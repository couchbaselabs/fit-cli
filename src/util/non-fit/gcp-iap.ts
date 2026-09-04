/**
 * gcp-iap — run commands on, and copy files to/from, a GCP instance over an
 * IAP (Identity-Aware Proxy) TCP tunnel. GCP's analog of the AWS SSM Session
 * Manager work: no public port 22 (only IAP's proxy range needs a firewall
 * rule, see working/gcp2.md), IAM-gated access (`roles/iap.tunnelResourceAccessor`),
 * and — paired with OS Login (`roles/compute.osLogin`) — an ephemeral
 * per-connection SSH key instead of a managed key pair.
 *
 * One real difference from SSM: this is still SSH under the hood. IAP tunnels
 * the TCP connection over Google's infrastructure, but sshd must be running on
 * the box and reachable through the tunnel — there is no fully agent-based,
 * no-SSH-at-all equivalent of SSM SendCommand on GCP. So this
 * matches SSM's "no open port, no key management, IAM-gated, audited"
 * properties, not "no SSH protocol involved at all".
 *
 * There is no `@google-cloud/*` SDK equivalent of `gcloud compute ssh
 * --tunnel-through-iap` — it's a client-side tunnel + the system `ssh`/`scp`,
 * with no server-side API call to wrap. This is the forced resolution of
 * gcp2.md's "Open decisions" item: fit-cli shells out to `gcloud` for this
 * one transport (everywhere else it stays SDK-only), matching cbdinocluster's
 * own ADC reliance and printing a command a user can rerun by hand.
 */
import { isMain, runCli } from "./cli.js";
import { formatBytes } from "./fit-cli-log.js";
import { capture, run, type RunOptions } from "./proc.js";

/** A GCP instance reachable over an IAP-tunneled SSH connection. */
export interface IapHost {
  /** Instance name (not an IP — IAP addresses instances by name). */
  instance: string;
  /** Zone the instance is in, e.g. "us-west1-a". */
  zone: string;
  /** GCP project id. Omit to use gcloud's configured default project. */
  project?: string;
  /**
   * Login user. With OS Login enabled this is advisory only — OS Login maps
   * the caller's IAM identity to a POSIX account server-side and gcloud
   * pushes an ephemeral key for it, so this mainly matters for display.
   * Defaults to "ubuntu" to match the AWS instances' login user.
   */
  user?: string;
}

/** The default login user when a host doesn't specify one. */
export const DEFAULT_IAP_USER = "ubuntu";

function loginTarget(host: IapHost): string {
  return `${host.user ?? DEFAULT_IAP_USER}@${host.instance}`;
}

function connectionFlags(host: IapHost): string[] {
  return [
    "--zone",
    host.zone,
    ...(host.project ? ["--project", host.project] : []),
    "--tunnel-through-iap",
    // Never prompt. On a host with no ~/.ssh/google_compute_engine — every fresh
    // CI runner — gcloud generates one, and ssh-keygen then asks for a passphrase
    // on stdin. That prompt hung a GCP release run for 5h in total silence.
    // proc.ts's capture() now gives stdin EOF rather than an open pipe, which is
    // the actual fix; this is the second lock on the same door.
    "--quiet",
    // Silences most of gcloud's routine noise without hiding real errors
    // (logged above this level). The OS Login notice below is printed via
    // gcloud's "status" stream, which bypasses --verbosity entirely, so it
    // still needs stripping from the output separately (see OS_LOGIN_NOTICE).
    "--verbosity=error",
  ];
}

/**
 * OS Login (see this file's header) always remaps the requested SSH user to
 * the caller's own POSIX account, and gcloud prints a notice saying so on
 * every single connection — via its "status" stream, which --verbosity=error
 * above does not suppress. It's not a warning about anything unexpected, so
 * it's dropped from streamed output rather than shown on every command.
 */
const OS_LOGIN_NOTICE = /^Using OS Login user \[[^\]]*\] instead of requested user \[[^\]]*\]\.?\r?\n?/gm;

/** `RunOptions.stripLines` for gcloud IAP ssh/scp invocations. */
export function stripOsLoginNotice(opts?: RunOptions): RunOptions {
  return { ...opts, stripLines: [...(opts?.stripLines ?? []), OS_LOGIN_NOTICE] };
}

/** Build the argv for `gcloud compute ssh` to run `command args...` on `host`. */
export function buildIapSshArgs(host: IapHost, command: string, args: readonly string[] = []): string[] {
  const remoteCommand = [command, ...args].join(" ");
  return ["compute", "ssh", loginTarget(host), ...connectionFlags(host), "--command", remoteCommand];
}

/** Direction of a `gcloud compute scp` transfer relative to the local machine. */
export type IapScpDirection = "up" | "down";

/** Build the argv for `gcloud compute scp` to move `localPath` <-> `remotePath` on `host`. */
export function buildIapScpArgs(
  host: IapHost,
  localPath: string,
  remotePath: string,
  direction: IapScpDirection,
): string[] {
  const remote = `${loginTarget(host)}:${remotePath}`;
  const flags = connectionFlags(host);
  return direction === "up"
    ? ["compute", "scp", ...flags, localPath, remote]
    : ["compute", "scp", ...flags, remote, localPath];
}

/**
 * Confirm the `gcloud` CLI is on PATH before shelling out to it, and fail with
 * guidance rather than a bare ENOENT. Unlike AWS (SDK-only everywhere), this is
 * the one fit-cli transport with an external binary dependency: a laptop needs
 * the Cloud SDK installed (`gcloud auth login` / ADC configured), and a GHA
 * runner needs a `setup-gcloud`-style step — GitHub's hosted runners don't ship
 * it. Memoized (per process) so a `waitForIapSsh` poll loop, which calls this
 * on every retry, only actually shells out to `gcloud --version` once.
 */
let gcloudPreflightDone = false;

/** `gcloud --version` is local and offline; if it hasn't answered by now it never will. */
const GCLOUD_VERSION_TIMEOUT_MS = 60_000;

export async function preflightGcloudCli(): Promise<void> {
  if (gcloudPreflightDone) return;
  try {
    await capture("gcloud", ["--version"], undefined, { quiet: true, timeoutMs: GCLOUD_VERSION_TIMEOUT_MS });
    gcloudPreflightDone = true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `"gcloud" was not found on PATH, but IAP tunnelling shells out to it (there is no client-library equivalent of ` +
        `"gcloud compute ssh --tunnel-through-iap").\n` +
        `On a laptop: install the Google Cloud SDK, then run "gcloud auth login" (or set up Application Default Credentials).\n` +
        `On CI: add a "gcloud" install step (e.g. google-github-actions/setup-gcloud) to the job before this runs.\n` +
        `(${detail})`,
      { cause: err },
    );
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True for IAP/gcloud transport failures worth retrying — tunnel setup racing
 * a not-yet-registered OS Login key, or the instance not yet accepting IAP
 * connections right after boot. gcloud has no single dedicated exit code for
 * this (unlike ssh's 255), so this matches on gcloud's own error text.
 */
export function isTransientIapError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /error establishing ssh connection|Connection via Cloud IAP failed|WARNING: The public key.*propagat/is.test(err.message);
}

const IAP_RETRY_ATTEMPTS = 3;
const IAP_RETRY_DELAY_MS = 5_000;

/**
 * `describe()` labels the attempted operation (host + command) so a
 * non-transient failure — which propagates all the way to fit-cli's top-level
 * error handler if nothing downstream catches it — reads as a clean
 * "gcloud IAP transport failed for ubuntu@host: gcloud exited with code 1"
 * rather than a bare Node stack rooted in proc.ts.
 */
async function withIapRetry<T>(fn: () => Promise<T>, describe: () => string): Promise<T> {
  for (let attempt = 1; attempt <= IAP_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isTransientIapError(err) && attempt < IAP_RETRY_ATTEMPTS) {
        console.error(`[iap] transient connection error (attempt ${attempt}/${IAP_RETRY_ATTEMPTS}), retrying in ${IAP_RETRY_DELAY_MS / 1000}s…`);
        await sleep(IAP_RETRY_DELAY_MS);
        continue;
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`gcloud IAP transport failed for ${describe()}: ${detail}`, { cause: err });
    }
  }
  throw new Error("withIapRetry: unreachable");
}

/** Run a command on `host` over an IAP tunnel, streaming its output to the terminal. */
export async function iapSshRun(host: IapHost, command: string, args: readonly string[] = [], opts?: RunOptions): Promise<void> {
  await preflightGcloudCli();
  return withIapRetry(
    () => run("gcloud", buildIapSshArgs(host, command, args), undefined, stripOsLoginNotice(opts)),
    () => `${loginTarget(host)}: ${command}`,
  );
}

/** Run a command on `host` over an IAP tunnel and resolve with its captured stdout. */
export async function iapSshCapture(host: IapHost, command: string, args: readonly string[] = [], opts?: RunOptions): Promise<string> {
  await preflightGcloudCli();
  return withIapRetry(
    () => capture("gcloud", buildIapSshArgs(host, command, args), undefined, opts),
    () => `${loginTarget(host)}: ${command}`,
  );
}

/** Copy a local file up to `remotePath` on `host` over an IAP tunnel. */
export async function iapScpUp(host: IapHost, localPath: string, remotePath: string): Promise<void> {
  await preflightGcloudCli();
  return withIapRetry(
    () =>
      run(
        "gcloud",
        buildIapScpArgs(host, localPath, remotePath, "up"),
        undefined,
        stripOsLoginNotice({ display: `gcloud compute scp (IAP) ${localPath} -> ${loginTarget(host)}:${remotePath}` }),
      ),
    () => `${loginTarget(host)}: scp ${localPath} -> ${remotePath}`,
  );
}

/**
 * Copy `remotePath` on `host` down to a local file over an IAP tunnel.
 * `sizeBytes`, when known ahead of time, is shown in the echoed command.
 */
export async function iapScpDown(host: IapHost, remotePath: string, localPath: string, sizeBytes?: number): Promise<void> {
  await preflightGcloudCli();
  const size = sizeBytes !== undefined ? ` (${formatBytes(sizeBytes)})` : "";
  return withIapRetry(
    () =>
      run(
        "gcloud",
        buildIapScpArgs(host, localPath, remotePath, "down"),
        undefined,
        stripOsLoginNotice({ display: `gcloud compute scp (IAP) ${loginTarget(host)}:${remotePath}${size} -> ${localPath}` }),
      ),
    () => `${loginTarget(host)}: scp ${remotePath} -> ${localPath}`,
  );
}

/**
 * How long a single reachability probe gets before it is killed and counted as a
 * failed attempt. Needed because a stalled `gcloud compute ssh` produces no
 * output and never exits — the tunnel can come up while sshd never answers — so
 * without it the `deadline` below is simply never reached: the loop is stuck
 * inside its first `await`, not going round. That is exactly how a GCP FIT run
 * silently consumed its full 6h GHA budget having logged nothing.
 *
 * Kept well under the overall deadline so a slow-booting box still gets several
 * probes rather than one long one. Deliberately generous: because the old code
 * hung rather than failing, we have never measured how long a genuinely cold
 * runner legitimately takes (first-time OS Login key generation and
 * propagation), and the point of this bound is to prevent a 5h hang, not to
 * lose a run to a 3-minute deadline. Loosen further rather than tighten.
 */
const IAP_PROBE_TIMEOUT_MS = 90_000;

/**
 * Poll until `host` accepts an IAP-tunneled SSH connection (by running `true`
 * on it), or until `timeoutMs` elapses. Freshly launched instances take a
 * little while before OS Login propagates the caller's ephemeral key and sshd
 * is reachable through the tunnel. Resolves true once connected, false on
 * timeout.
 */
export async function waitForIapSsh(
  host: IapHost,
  { timeoutMs = 300_000, intervalMs = 5_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // Polling for the tunnel + sshd to come up — don't echo every probe.
      // A probe timeout isn't a transient IAP error, so withIapRetry rethrows it
      // rather than burning its 3 attempts here; the deadline check below then
      // decides whether to probe again.
      await iapSshCapture(host, "true", [], { quiet: true, timeoutMs: IAP_PROBE_TIMEOUT_MS });
      return true;
    } catch {
      if (Date.now() >= deadline) {
        return false;
      }
      await sleep(intervalMs);
    }
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    const flag = (name: string): string | undefined => {
      const index = argv.indexOf(`--${name}`);
      return index !== -1 ? argv[index + 1] : undefined;
    };
    const instance = flag("instance");
    const zone = flag("zone");
    if (!instance || !zone) {
      throw new Error("Usage: gcp-iap.ts --instance <name> --zone <zone> [--project <id>] [--user <user>] -- <command> [args...]");
    }
    const separator = argv.indexOf("--");
    const [command, ...args] = separator !== -1 ? argv.slice(separator + 1) : [];
    const host: IapHost = { instance, zone, project: flag("project"), user: flag("user") };
    if (!command) {
      console.log(`Waiting for IAP-tunneled SSH on ${instance}...`);
      console.log((await waitForIapSsh(host)) ? "✓ reachable" : "✗ timed out");
      return;
    }
    await iapSshRun(host, command, args);
  });
}
