/**
 * Put a Linux fit-cli binary on the execution target, so work that has to happen *on*
 * the box can run there rather than be driven from here over SSH.
 *
 * Perf is why this exists. The measurement loop has to sit beside the performer: driven
 * from a laptop it would time the WAN rather than the SDK. fit-cli's engine *is* fit-cli,
 * so putting the driver on the box means putting fit-cli there. Everything else about a remote run is
 * unchanged: the cluster and performer are already on the box, and the generated perf
 * config already addresses them as the box sees them.
 *
 * Two ways to get a binary there, chosen by whether we're running from a checkout:
 *
 *   from source   cross-compile the working tree and upload it. The only option that
 *                 measures the code you're editing, so it wins whenever it's available.
 *   installed     have the *box* download the release build for its own architecture.
 *                 Costs no upload, and it's what lets a macOS install drive a Linux box
 *                 at all — a mac binary can't be shipped to one.
 *
 * Nothing here runs for a local execution context — see {@link stageFitCliBinary}.
 *
 * grahamp: yes this approach feels a little odd.  But it's not really any different than the
 * old FIT/PERF approach of installing a binary (jenkins-sdk) on the remote: it's just the
 * binary is fit-cli itself here.
 * We build a fit-cli binary locally if needed.  We don't want to copy over random files from the
 * user's git repo, but we do need to pick up local dev changes for testing.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../../util/non-fit/proc.js";
import { CHANNELS, releaseAssetUrl, resolveRemoteSha, shasMatch, type Channel } from "../../upgrade/upgrade.js";
import { resolvedGitSha } from "../../version/version.js";
import { remoteFitBinDir, type FitExecutionContext } from "./remote-fit-run.js";

/** The architectures fit-cli publishes Linux binaries for (see .github/workflows/build-binaries.yaml). */
export type LinuxArch = "x64" | "arm64";

/** Map `uname -m` on the target to the arch name Bun's `--target` uses. */
export function linuxArchFromUname(unameMachine: string): LinuxArch {
  const machine = unameMachine.trim();
  if (machine === "x86_64" || machine === "amd64") return "x64";
  if (machine === "aarch64" || machine === "arm64") return "arm64";
  throw new Error(
    `Cannot run fit-cli on the instance: it reports architecture "${machine}", and fit-cli builds ` +
      "Linux binaries for x86_64 and aarch64 only.",
  );
}

/**
 * The fit-cli checkout this process is running from, or undefined when running as a
 * compiled binary (whose `import.meta.url` is a virtual `/$bunfs/` path that resolves
 * to no real directory). That difference is exactly the signal we want: with a checkout
 * we can build a binary matching the code under test, and without one we cannot.
 */
export function fitCliRepoRoot(): string | undefined {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const looksLikeCheckout = existsSync(join(root, "package.json")) && existsSync(join(root, "src", "fit", "main", "main.ts"));
  return looksLikeCheckout ? root : undefined;
}

/**
 * Cross-compile a Linux binary from the checkout.
 *
 * Deliberately passes none of the `--define`s the release workflow uses: `__FIT_BUILD_TIME`
 * would change the output on every build, and the content hash is what lets a repeat run
 * skip re-uploading ~100MB. So this binary carries no baked-in identity: `fit version` on the
 * box falls back to whatever `git rev-parse HEAD` yields in its working directory, which is
 * honest enough — it was built from a working tree, not from a commit.
 */
async function buildLinuxBinary(repoRoot: string, arch: LinuxArch): Promise<string> {
  const outfile = join(tmpdir(), `fit-cli-remote-linux-${arch}`);
  console.log(`\nBuilding a linux-${arch} fit-cli binary to run the perf engine on the instance...`);
  await run(
    "bun",
    ["build", "--compile", `--target=bun-linux-${arch}`, "src/fit/main/main.ts", "--outfile", outfile],
    repoRoot,
  );
  return outfile;
}

/**
 * One build per architecture per process. The first build is normally the preflight one
 * (see {@link prebuildRemoteFitCliBinary}), so every remote perf run in a definition ships
 * the working tree as it was when the run started, and none of them pays for a rebuild.
 */
const builtBinaries = new Map<LinuxArch, Promise<string>>();

function buildLinuxBinaryOnce(repoRoot: string, arch: LinuxArch): Promise<string> {
  let built = builtBinaries.get(arch);
  if (!built) {
    built = buildLinuxBinary(repoRoot, arch);
    builtBinaries.set(arch, built);
  }
  return built;
}

/**
 * The architecture every instance fit-cli provisions has: the AWS AMI lookup asks for
 * x86_64 (src/cloud/util/aws/image.ts), and the default GCP machine type is x86 too. It's
 * only a guess for an overridden GCP machine type or a reused instance, so staging still
 * checks `uname -m` and builds again on a mismatch.
 */
const PROVISIONED_ARCH: LinuxArch = "x64";

/**
 * Build the binary remote perf runs will ship, before anything is provisioned.
 *
 * The cross-compile is the step of a remote perf run most likely to fail — it compiles
 * whatever is in the working tree — and done lazily it only failed after an instance,
 * a cluster and a performer were already up. Does nothing when running as an installed
 * binary, which has the instance download a release build instead.
 */
export async function prebuildRemoteFitCliBinary(): Promise<void> {
  const repoRoot = fitCliRepoRoot();
  if (repoRoot) {
    await buildLinuxBinaryOnce(repoRoot, PROVISIONED_ARCH);
  }
}

/** Build from the checkout and upload, naming the result by content hash. */
async function uploadBuiltBinary(execution: FitExecutionContext, repoRoot: string, arch: LinuxArch): Promise<string> {
  const localBinary = await buildLinuxBinaryOnce(repoRoot, arch);
  const hash = createHash("sha256").update(readFileSync(localBinary)).digest("hex").slice(0, 12);
  const remotePath = remoteBinaryPath(execution, hash);

  if (await execution.pathExists(remotePath)) {
    console.log(`✓ fit-cli binary already on ${execution.description} at ${remotePath}`);
    return remotePath;
  }

  const megabytes = Math.round(statSync(localBinary).size / 1_000_000);
  console.log(`\nCopying the fit-cli binary (${megabytes}MB) to ${execution.description}...`);
  await execution.stageFile(localBinary, remotePath);
  await execution.run("chmod", ["+x", remotePath]);
  console.log(`✓ fit-cli binary staged at ${remotePath}`);
  return remotePath;
}

/**
 * Where a binary identified by `key` lives on the target.
 *
 * The key names the directory rather than the file, so the executable keeps the plain name
 * `fit` in logs and in its own invocation banner, while two versions still can't collide —
 * and neither shadows anything already on the workspace bin dir's PATH.
 */
function remoteBinaryPath(execution: FitExecutionContext, key: string): string {
  return join(remoteFitBinDir(execution.rootDir), key, "fit");
}

/** Which published build the target should download. */
export interface ReleaseBinarySource {
  channel: Channel;
  /**
   * Commit at that channel's tip: the build being downloaded, and the cache key.
   * Undefined when no channel could be resolved at all, which makes the download
   * unidentifiable and so uncacheable.
   */
  sha?: string;
  /** False when no channel's tip is this binary's own commit — see {@link chooseReleaseChannel}. */
  matchesThisBuild: boolean;
}

/**
 * Preferred when nothing distinguishes the channels: `ci` is the promoted build, so it is
 * both the steadier thing to measure with and the more meaningful name to see in a log.
 */
const DEFAULT_REMOTE_CHANNEL: Channel = "ci";

/**
 * Order to consider channels in. Written in terms of CHANNELS so that adding a channel
 * there doesn't silently leave it unconsidered here.
 */
const CHANNEL_PREFERENCE: readonly Channel[] = [
  DEFAULT_REMOTE_CHANNEL,
  ...CHANNELS.filter((c) => c !== DEFAULT_REMOTE_CHANNEL),
];

/**
 * Pick the channel to download from, given each channel's current tip.
 *
 * An installed binary records the commit it was built from but *not* the channel it came
 * from, so the channel is recovered by asking which one's tip is that commit.
 *
 * When none is — a stale install, or one from a per-branch channel — this still returns a
 * channel rather than refusing. Refusing would make remote perf broken-by-default on macOS,
 * since `latest` moves with every push to main. The mismatch is reported instead: fit-cli is
 * the instrument here, not the thing being measured, and the caller says so out loud.
 *
 * The same goes for `tips` being empty, which means the release API couldn't be reached at
 * all: the asset download itself doesn't need that API, so a wobble there shouldn't be what
 * stops a perf run. The build is then simply unidentified, and reported as such.
 *
 * Pure, so the precedence rules can be tested without the network.
 */
export function chooseReleaseChannel(
  localSha: string,
  tips: readonly { channel: Channel; sha: string }[],
): ReleaseBinarySource {
  const byPreference = CHANNEL_PREFERENCE.map((channel) => tips.find((t) => t.channel === channel)).filter(
    (t): t is { channel: Channel; sha: string } => t !== undefined,
  );
  const ordered = byPreference.length > 0 ? byPreference : tips;

  const exact = ordered.find((t) => shasMatch(localSha, t.sha));
  if (exact) return { ...exact, matchesThisBuild: true };

  const fallback = ordered[0] ?? { channel: DEFAULT_REMOTE_CHANNEL };
  return { ...fallback, matchesThisBuild: false };
}

/**
 * {@link chooseReleaseChannel} against the live release tags.
 *
 * Concurrent, and every lookup is individually bounded (see `resolveRemoteSha`): this is a
 * nicety that runs before the real work, so it must never be able to hold a perf run up. A
 * channel that has never been published 404s, which is not fatal while another resolves.
 */
async function resolveReleaseBinarySource(): Promise<ReleaseBinarySource> {
  const settled = await Promise.allSettled(CHANNEL_PREFERENCE.map((channel) => resolveRemoteSha(channel)));
  const tips = CHANNEL_PREFERENCE.flatMap((channel, i) => {
    const result = settled[i];
    return result?.status === "fulfilled" ? [{ channel, sha: result.value }] : [];
  });
  return chooseReleaseChannel(resolvedGitSha(), tips);
}

/** Have the target fetch a release build for its own architecture. */
async function downloadBinaryOnTarget(execution: FitExecutionContext, arch: LinuxArch): Promise<string> {
  const source = await resolveReleaseBinarySource();
  // Two quite different situations, so they get told apart: one is "you are out of date",
  // the other is "we could not check". Either way the numbers come from the downloaded build,
  // which is the part that has to be said out loud.
  if (source.sha && !source.matchesThisBuild) {
    console.warn(
      `\n⚠ This fit-cli (${resolvedGitSha()}) is not the tip of any release channel, so the perf engine\n` +
        `  on ${execution.description} will be the "${source.channel}" build (${source.sha.slice(0, 12)}) instead.\n` +
        "  The measurements come from that build. Run 'fit upgrade' to line the two up.",
    );
  } else if (!source.sha) {
    console.warn(
      `\n⚠ Could not reach the release API to work out which build this fit-cli is, so the perf engine\n` +
        `  on ${execution.description} will be the current "${source.channel}" build, whatever that is.\n` +
        "  The measurements come from that build.",
    );
  }

  const remotePath = remoteBinaryPath(execution, source.sha?.slice(0, 12) ?? `${source.channel}-unidentified`);
  // Only reuse a binary we can name: without a resolved commit, "already there" doesn't
  // establish that what's there is the build we're about to ask for.
  if (source.sha && (await execution.pathExists(remotePath))) {
    console.log(`✓ fit-cli binary already on ${execution.description} at ${remotePath}`);
    return remotePath;
  }

  const url = releaseAssetUrl(source.channel, `fit-linux-${arch}`);
  console.log(`\nDownloading the fit-cli binary onto ${execution.description} from the "${source.channel}" channel...`);
  await execution.run("mkdir", ["-p", dirname(remotePath)]);
  // The only thing here that needs more than coreutils on the instance. Fine on the Ubuntu
  // 22.04 server image we provision (see src/cloud/util/aws/image.ts), which ships curl, and
  // install.sh already assumes the same of anywhere fit-cli gets installed.
  await execution.run("curl", ["-fL", "--retry", "3", "--retry-delay", "2", "-o", remotePath, url]);
  await execution.run("chmod", ["+x", remotePath]);
  console.log(`✓ fit-cli binary staged at ${remotePath}`);
  return remotePath;
}

/**
 * Ensure a fit-cli binary is on the execution target and return its path there.
 *
 * Named by content hash (built) or release commit (downloaded), so re-running against a
 * leftover instance — or a second perf run in the same definition — skips the transfer,
 * while any change produces a different name and is always re-fetched. Only meaningful for
 * a remote context; a local one is already running the binary in question.
 */
export async function stageFitCliBinary(execution: FitExecutionContext): Promise<string> {
  if (execution.kind !== "remote") {
    return process.execPath;
  }

  const arch = linuxArchFromUname(await execution.capture("uname", ["-m"]));
  const repoRoot = fitCliRepoRoot();
  return repoRoot ? await uploadBuiltBinary(execution, repoRoot, arch) : await downloadBinaryOnTarget(execution, arch);
}
