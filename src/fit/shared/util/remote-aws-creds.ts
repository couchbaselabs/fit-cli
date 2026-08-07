/**
 * remote-aws-creds — install AWS credentials on a remote box in a form that survives
 * a multi-hour run, and keep them refreshed for as long as the run lasts.
 *
 * Why this isn't just "write the env vars once": `cbdinocluster` is the only thing on
 * the box that needs AWS (the Maven test-driver has no AWS SDK at all), and situational
 * / private-endpoint runs call it repeatedly for hours. Credentials fit-cli assumes are
 * capped at 1 hour whenever fit-cli's own identity is temporary — SSO, an instance
 * profile, an already-assumed role — because AWS caps "role chaining" there. Exporting a
 * snapshot into `~/.profile` freezes that 1 hour into the test-driver process and every
 * `cbdinocluster` it spawns, so a 3h suite spends its last 2h failing every EC2 call with
 * `RequestExpired` (`private-endpoints setup-link` and per-scenario cleanup being the
 * visible casualties).
 *
 * A localhost run never had this problem: proc.ts spawns children without an explicit
 * `env`, so each `cbdinocluster` inherits fit-cli's *live* `process.env`, which
 * `ensureFreshFitCliRole` updates in place. This module gives the remote box the same
 * property — a live source re-read per invocation — via a `credential_process` that
 * prints a file we keep rewriting.
 *
 * Run on its own (needs a reachable box; see `--help`):
 *   bun src/fit/shared/util/remote-aws-creds.ts --help
 *   bun src/fit/shared/util/remote-aws-creds.ts render
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { posixQuote } from "../../../util/non-fit/remote-target.js";
import { createRunFilePath } from "../../../util/non-fit/replay.js";
import type { ExecutionTarget } from "../../../util/non-fit/target.js";
import type { AwsCredentials } from "../../../cloud/util/aws/identity.js";
import { freshAssumedCredentials, type ForwardableCredentials } from "../../../cloud/util/aws/aws-cli.js";
import { AWS_REGION } from "../../../cloud/util/aws/aws-target.js";

/** Payload file the `credential_process` script prints. Read by the AWS SDK, never sourced. */
const REMOTE_AWS_CREDS_JSON_FILENAME = "fit-aws-creds.json";
/** The `credential_process` script itself — a one-liner that cats the payload. */
const REMOTE_AWS_CREDS_FETCH_FILENAME = "fit-aws-creds-fetch.sh";
/**
 * The pre-refresh env-var file. We no longer write it, but boxes reused across runs
 * (`onPortInUse: 'reuse'`, `--resume-at`, `--execution existing`) may still have it
 * sourced from `~/.profile`, and env vars outrank `~/.aws/config` in the AWS provider
 * chain — leaving it in place would silently defeat everything below.
 */
const LEGACY_AWS_CREDENTIALS_FILENAME = "fit-aws-credentials.sh";

/**
 * Refresh once the box's credentials are within this long of expiring. On a chained
 * (1h) session that means a refresh every ~30 minutes; on a full 12h session — a direct
 * IAM user, or CI's OIDC assume — it means one refresh near the end rather than dozens
 * of pointless STS calls and scps.
 */
export const REMOTE_CREDS_REFRESH_THRESHOLD_MS = 30 * 60 * 1000;
/**
 * How often to re-check. Small relative to the threshold so a failed attempt has several
 * more tries before the credentials actually lapse (at 5m/30m: six attempts).
 */
export const REMOTE_CREDS_REFRESH_TICK_MS = 5 * 60 * 1000;

export function remoteAwsCredsJsonPath(rootDir: string): string {
  return join(rootDir, REMOTE_AWS_CREDS_JSON_FILENAME);
}

export function remoteAwsCredsFetchPath(rootDir: string): string {
  return join(rootDir, REMOTE_AWS_CREDS_FETCH_FILENAME);
}

/**
 * The JSON contract for `credential_process` (`Version` must be 1). `Expiration` is what
 * makes this better than a static credentials file: the SDK re-invokes the process once it
 * passes, so even a single long-running `cbdinocluster` command (`private-endpoints enable`
 * routinely takes 7 minutes) picks up a newer session mid-flight instead of failing.
 *
 * Omitted when unknown — the case where fit-cli didn't assume the role itself and so has no
 * expiry to report. The SDK then treats the credentials as non-expiring, which is the best
 * available answer: whatever provided them owns their lifecycle.
 */
export function awsCredentialProcessPayload(creds: ForwardableCredentials | AwsCredentials): string {
  const expiration = "expiration" in creds ? creds.expiration : undefined;
  return JSON.stringify({
    Version: 1,
    AccessKeyId: creds.accessKeyId,
    SecretAccessKey: creds.secretAccessKey,
    ...(creds.sessionToken ? { SessionToken: creds.sessionToken } : {}),
    ...(expiration ? { Expiration: expiration.toISOString() } : {}),
  }) + "\n";
}

/** The `credential_process` script: print the payload, nothing else. */
export function awsCredsFetchScript(jsonPath: string): string {
  return `#!/bin/sh\n# Written by fit-cli. Prints the AWS credentials fit-cli keeps refreshed for this run.\nexec cat ${posixQuote(jsonPath)}\n`;
}

/**
 * `~/.aws/config` contents. `credential_process` is re-run by every new process, which is
 * exactly what the old `~/.profile` exports could not do.
 *
 * The value is a command line the AWS SDK splits on whitespace, and quoting rules differ
 * between SDKs, so rather than guess at an escaping that works everywhere we require a path
 * with no whitespace. In practice it is always `<remote home>/fit-workspace/…`, built from a
 * constant; this only fires if that assumption is ever broken, and fails loudly rather than
 * writing a config that silently resolves no credentials.
 */
export function remoteAwsConfigFile(fetchScriptPath: string, region: string = AWS_REGION): string {
  if (/\s/.test(fetchScriptPath)) {
    throw new Error(
      `credential_process path must not contain whitespace (the AWS SDK splits the value as a ` +
      `command line): ${fetchScriptPath}`,
    );
  }
  return `# Written by fit-cli. Credentials come from a process so each cbdinocluster\n# invocation re-reads them; fit-cli keeps the underlying file refreshed.\n[default]\nregion = ${region}\ncredential_process = ${fetchScriptPath}\n`;
}

/**
 * Whether credentials expiring at `expiration` should be refreshed now. Undefined
 * expiry means we have nothing to schedule against (we didn't assume them), so no.
 */
export function shouldRefreshRemoteCreds(
  expiration: Date | undefined,
  now: Date,
  thresholdMs: number = REMOTE_CREDS_REFRESH_THRESHOLD_MS,
): boolean {
  if (expiration === undefined) return false;
  return expiration.getTime() - now.getTime() <= thresholdMs;
}

/**
 * Distinguishes every staged file, so a refresh tick and a reinstall can never collide on a
 * shared temp path. Both write the same logical files, and a fixed `.tmp` name let one
 * clobber (or `mv` away) the other's staged content mid-flight.
 */
let stageSequence = 0;

/**
 * Upload `contents` to a temp path derived from `stagingBasePath`, and return that path. The
 * caller then chmods and moves it into place — see {@link installCommand} — so that placing
 * several files costs one shell round trip rather than two per file. Remote round trips are
 * worth counting here: setup already makes ~17 SSH connections in under half a minute before
 * this point.
 *
 * Local and remote temp names both carry a per-call token. Overlap is unlikely but reachable
 * (a reused box reinstalls credentials per execution group, while the previous refresher may
 * still be ticking), and the failure would be a confusing mid-run scp or `mv` error.
 */
async function stageRemoteFile(
  target: ExecutionTarget,
  localFilename: string,
  contents: string,
  stagingBasePath: string,
): Promise<string> {
  stageSequence += 1;
  const token = `${process.pid}-${stageSequence}`;
  const tmpPath = `${stagingBasePath}.${token}.tmp`;
  const localFile = createRunFilePath(`${localFilename}.${token}`);
  writeFileSync(localFile, contents, { mode: 0o600 });
  try {
    await target.putFile(localFile, tmpPath);
  } finally {
    // Never leave credentials sitting in the run directory, even if the upload throws.
    rmSync(localFile, { force: true });
  }
  return tmpPath;
}

/**
 * `chmod <mode> <tmp> && mv -f <tmp> <dest>`, for running several at once in one shell.
 *
 * chmod before the rename, so the file is never briefly world-readable at its real path; and
 * rename rather than write-in-place, because `mv` within a directory is atomic — a concurrent
 * `credential_process` reader sees either the whole old file or the whole new one, never a
 * half-written one. That matters because the refresher rewrites the payload underneath a
 * running test-driver.
 *
 * `dest` is deliberately NOT quoted here, so a caller can pass `~/.aws/config` and have the
 * shell expand it. Callers passing anything else must pre-quote it themselves (as the callers
 * below do, with `posixQuote`). `tmpPath` is always an absolute path we built, so it is quoted
 * for them.
 */
function installCommand(tmpPath: string, dest: string, mode: "600" | "700"): string {
  return `chmod ${mode} ${posixQuote(tmpPath)} && mv -f ${posixQuote(tmpPath)} ${dest}`;
}

/**
 * Install AWS credentials on the box behind a `credential_process`, so that every
 * `cbdinocluster` invocation re-reads them and {@link startRemoteAwsCredsRefresher} can
 * keep them current for the whole run. Also migrates away from the legacy env-var file,
 * which would otherwise take precedence and pin the box to a stale 1-hour session.
 *
 * Credential values are only ever written via SCP, never on a command line.
 *
 * Returns when the installed credentials expire, or undefined when fit-cli didn't assume them
 * and so has no expiry to report — pass it to {@link startRemoteAwsCredsRefresher} to keep them
 * current for the rest of the run.
 */
export async function uploadRemoteAwsCredentials(
  target: ExecutionTarget,
  rootDir: string,
  creds: AwsCredentials,
): Promise<Date | undefined> {
  const jsonPath = remoteAwsCredsJsonPath(rootDir);
  const fetchPath = remoteAwsCredsFetchPath(rootDir);
  // Ask for the freshest session, using the same threshold the refresher schedules against —
  // with the default 5-minute margin a near-expiry session would be reported as still fresh.
  const fresh = await freshAssumedCredentials(REMOTE_CREDS_REFRESH_THRESHOLD_MS);
  const effective = fresh ?? creds;

  console.log(
    `→ setup-aws-credentials: installing AWS credentials on ${target.description} via ${fetchPath}`,
  );
  if (fresh?.expiration) {
    console.log(`  session expires ${fresh.expiration.toISOString()}; fit-cli will refresh it for the life of the run`);
  } else {
    // No assumed session of our own (e.g. CI, already fit-cli-role via OIDC): say so rather
    // than implying a refresh that cannot happen. CI's 12h OIDC session covers normal runs.
    console.log(`  fit-cli did not assume these credentials, so it cannot refresh them on the box`);
  }

  // `~/.aws/config` is staged under rootDir rather than uploaded straight to `~/.aws/`:
  // scp and posixQuote both treat `~` as literal text, so the shell has to expand it.
  const jsonTmp = await stageRemoteFile(
    target, REMOTE_AWS_CREDS_JSON_FILENAME, awsCredentialProcessPayload(effective), jsonPath,
  );
  const fetchTmp = await stageRemoteFile(
    target, REMOTE_AWS_CREDS_FETCH_FILENAME, awsCredsFetchScript(jsonPath), fetchPath,
  );
  const configTmp = await stageRemoteFile(
    target, "fit-aws-config", remoteAwsConfigFile(fetchPath), join(rootDir, "fit-aws-config"),
  );

  // One round trip to put all three in place and retire the legacy file. The legacy removal
  // comes last so a failure part-way never leaves the box with neither mechanism.
  await target.run(
    "sh",
    ["-lc", [
      installCommand(jsonTmp, posixQuote(jsonPath), "600"),
      installCommand(fetchTmp, posixQuote(fetchPath), "700"),
      "mkdir -p -m 700 ~/.aws",
      installCommand(configTmp, "~/.aws/config", "600"),
      legacyRemovalCommand(rootDir),
    ].join(" && ")],
    undefined,
    { display: `install AWS credential_process and retire legacy env-var credentials` },
  );
  return fresh?.expiration;
}

/**
 * Drop the legacy `~/.profile` sourcing line and the env-var file it pointed at. Idempotent,
 * and a no-op on a box that never had them. Without this a reused box (`onPortInUse: 'reuse'`,
 * `--resume-at`, `--execution existing`) keeps exporting stale `AWS_*` values, which outrank
 * `~/.aws/config` in the AWS provider chain — the refresh would appear to work and change
 * nothing.
 */
export function legacyRemovalCommand(rootDir: string): string {
  const legacyPath = join(rootDir, LEGACY_AWS_CREDENTIALS_FILENAME);
  // `\#…#d` tells sed to use `#` as the delimiter, so the path's slashes need no escaping.
  const sedScript = posixQuote(`\\#${LEGACY_AWS_CREDENTIALS_FILENAME}#d`);
  return (
    `{ if [ -f ~/.profile ]; then sed -i.fit-cli-bak ${sedScript} ~/.profile; fi; ` +
    `rm -f ${posixQuote(legacyPath)}; }`
  );
}

/** A running refresher; call {@link RemoteAwsCredsRefresher.stop} at instance teardown. */
export interface RemoteAwsCredsRefresher {
  /**
   * Stop ticking, and resolve once any tick already in flight has finished. Await it before
   * reinstalling credentials on the same box, so the two can't both be writing.
   */
  stop(): Promise<void>;
  /** Refresh attempts that failed. Non-zero means the box may be running on stale credentials. */
  readonly failures: number;
  /**
   * Why the most recent *failed* attempt failed, for the end-of-run summary. Deliberately not
   * cleared by a later success, so it stays paired with the cumulative {@link failures} count —
   * clearing it would leave the summary reporting failures with no reason attached.
   */
  readonly lastError: string | undefined;
}

/**
 * Keep the box's credential file current for the life of the run.
 *
 * Ticks every {@link REMOTE_CREDS_REFRESH_TICK_MS} and re-uploads once the session is within
 * {@link REMOTE_CREDS_REFRESH_THRESHOLD_MS} of expiry. Failures are warned about immediately
 * and counted, but do not abort the run: fit-cli has no way to interrupt an in-flight
 * test-driver process, so callers should read {@link RemoteAwsCredsRefresher.failures} at
 * teardown and surface it, rather than letting the cause resurface hours later as an
 * unexplained `RequestExpired` inside cbdinocluster.
 */
export function startRemoteAwsCredsRefresher(
  target: ExecutionTarget,
  rootDir: string,
  expiration: Date | undefined,
): RemoteAwsCredsRefresher {
  const state: {
    expiration: Date | undefined;
    failures: number;
    stopped: boolean;
    /** The tick currently running, so {@link stop} can wait it out rather than orphan it. */
    inFlight?: Promise<void>;
    lastError?: string;
  } = { expiration, failures: 0, stopped: false };

  const refresh = async (): Promise<void> => {
    try {
      const fresh = await freshAssumedCredentials(REMOTE_CREDS_REFRESH_THRESHOLD_MS);
      if (!fresh) {
        // Nothing of ours to refresh. Stop looking so we don't log this every tick.
        state.expiration = undefined;
        return;
      }
      const jsonPath = remoteAwsCredsJsonPath(rootDir);
      const tmpPath = await stageRemoteFile(
        target, REMOTE_AWS_CREDS_JSON_FILENAME, awsCredentialProcessPayload(fresh), jsonPath,
      );
      await target.run(
        "sh",
        ["-lc", installCommand(tmpPath, posixQuote(jsonPath), "600")],
        undefined,
        { display: `refresh AWS credentials on ${target.description} (expire ${fresh.expiration?.toISOString() ?? "unknown"})` },
      );
      state.expiration = fresh.expiration;
    } catch (err) {
      state.failures += 1;
      const detail = err instanceof Error ? err.message : String(err);
      const expiresAt = state.expiration?.toISOString() ?? "unknown";
      state.lastError =
        `Could not refresh AWS credentials on ${target.description}: ${detail}. ` +
        `They expire at ${expiresAt}; cbdinocluster calls on the box fail with RequestExpired after that.`;
      console.warn(`⚠  ${state.lastError}`);
    }
  };

  const tick = (): void => {
    // Skip rather than queue: a slow refresh shouldn't stack up behind itself, and the next
    // tick is only minutes away.
    if (state.stopped || state.inFlight) return;
    if (!shouldRefreshRemoteCreds(state.expiration, new Date())) return;
    const running = refresh().finally(() => {
      if (state.inFlight === running) state.inFlight = undefined;
    });
    state.inFlight = running;
  };

  const timer = setInterval(tick, REMOTE_CREDS_REFRESH_TICK_MS);
  // Never hold fit-cli open at exit just because a refresh timer is pending.
  timer.unref?.();
  return {
    stop: async () => {
      state.stopped = true;
      clearInterval(timer);
      // Read into a local first: the tick clears state.inFlight when it settles.
      const running = state.inFlight;
      if (running) await running;
    },
    get failures() {
      return state.failures;
    },
    get lastError() {
      return state.lastError;
    },
  };
}

const LOCAL_CLI_HELP = `remote-aws-creds — install and refresh AWS credentials on a remote box.

Usage:
  bun src/fit/shared/util/remote-aws-creds.ts render [rootDir]
      Print the three files that would be written (credentials redacted), for eyeballing
      the shape without touching a box. Default rootDir: /home/ubuntu/fit-workspace.

  bun src/fit/shared/util/remote-aws-creds.ts refresh-check <isoExpiry>
      Report whether credentials expiring at <isoExpiry> are due a refresh now.
`;

/** Both subcommands are pure rendering, so this is sync; runCli just wants a promise. */
function runLocalCli(): void {
  {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
      console.log(LOCAL_CLI_HELP);
      return;
    }
    const [action] = args;
    if (action === "render") {
      const rootDir = args[1] ?? "/home/ubuntu/fit-workspace";
      const jsonPath = remoteAwsCredsJsonPath(rootDir);
      const fetchPath = remoteAwsCredsFetchPath(rootDir);
      console.log(`--- ${jsonPath} ---`);
      console.log(awsCredentialProcessPayload({
        accessKeyId: "ASIAREDACTED", secretAccessKey: "REDACTED", sessionToken: "REDACTED",
        expiration: new Date("2026-01-01T00:00:00Z"),
      }));
      console.log(`--- ${fetchPath} ---`);
      console.log(awsCredsFetchScript(jsonPath));
      console.log(`--- ~/.aws/config ---`);
      console.log(remoteAwsConfigFile(fetchPath));
      // `<token>` stands in for the per-call token stageRemoteFile adds; a real run has a
      // distinct one per staged file so a refresh tick can't collide with an install.
      console.log(`--- the single shell command that installs all three ---`);
      console.log([
        installCommand(`${jsonPath}.<token>.tmp`, posixQuote(jsonPath), "600"),
        installCommand(`${fetchPath}.<token>.tmp`, posixQuote(fetchPath), "700"),
        "mkdir -p -m 700 ~/.aws",
        installCommand(join(rootDir, "fit-aws-config.<token>.tmp"), "~/.aws/config", "600"),
        legacyRemovalCommand(rootDir),
      ].join(" && "));
      return;
    }
    if (action === "refresh-check") {
      const iso = args[1];
      if (!iso) {
        console.error(`refresh-check needs an ISO expiry.\n\n${LOCAL_CLI_HELP}`);
        process.exit(2);
      }
      const expiry = new Date(iso);
      if (Number.isNaN(expiry.getTime())) {
        console.error(`'${iso}' is not a valid ISO date.\n\n${LOCAL_CLI_HELP}`);
        process.exit(2);
      }
      const now = new Date();
      console.log(
        `expires ${expiry.toISOString()}, now ${now.toISOString()}, ` +
        `minutes left ${Math.round((expiry.getTime() - now.getTime()) / 60000)}, ` +
        `refresh now: ${shouldRefreshRemoteCreds(expiry, now)}`,
      );
      return;
    }
    console.error(`Unknown subcommand '${action}'.\n\n${LOCAL_CLI_HELP}`);
    process.exit(2);
  }
}

if (isMain(import.meta.url)) {
  runCli(() => Promise.resolve(runLocalCli()));
}
