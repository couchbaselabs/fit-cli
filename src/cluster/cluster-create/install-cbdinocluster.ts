/**
 * Step: install cbdinocluster on a remote box — either by downloading the
 * matching binary from the couchbaselabs/cbdinocluster GitHub releases (default),
 * or by cloning a specific PR or branch and building the binary from source on
 * the box.
 *
 * The release-download path: detects the remote's OS/arch, fetches the latest
 * release asset, makes it executable, and returns the absolute path — ready to
 * hand to `cbdinocluster <args>` over the same executor.
 *
 * The source-build path: clones the repo, fetches `refs/pull/<N>/head` (PR) or
 * the branch, builds with `go build`, installs the same binary location. Go is
 * auto-installed on the box if missing. The build is arch-correct by
 * construction since it runs on the box.
 *
 * Both paths run as a single remote shell script so they work through any
 * executor that can `capture` a command.
 *
 * Run on its own against an existing EC2 instance:
 *   # Latest release (default):
 *   bun src/cluster/cluster-create/install-cbdinocluster.ts --dir /tmp/fit-cli/<run>/instances/0
 *   # From a PR (builds from source on the box):
 *   bun src/cluster/cluster-create/install-cbdinocluster.ts --dir /tmp/fit-cli/<run>/instances/0 --pr 123
 *   bun src/cluster/cluster-create/install-cbdinocluster.ts --dir /tmp/fit-cli/<run>/instances/0 --pr 123 --repo myfork/cbdinocluster
 *   # From a branch (builds from source on the box):
 *   bun src/cluster/cluster-create/install-cbdinocluster.ts --dir /tmp/fit-cli/<run>/instances/0 --branch my-fix
 *   # With explicit flags:
 *   bun src/cluster/cluster-create/install-cbdinocluster.ts \
 *     --instance i-0123456789abcdef0 [--user ubuntu] [--pr 123]
 */
import { readFileSync } from "fs";
import { join } from "path";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { prepareAwsCli } from "../../cloud/util/aws/aws-cli.js";
import { SsmTarget, waitForSsmReady } from "../../util/non-fit/ssm-target.js";
import { ssmStartSessionCommand } from "../../fit/util/aws/lifecycle-warning.js";
import type { RunOptions } from "../../util/non-fit/proc.js";
import { fitCliError } from "../../util/non-fit/fit-cli-log.js";
import { CBDINOCLUSTER_URL } from "../../fit/util/config.js";
import type { CbdinoclusterSourceGit } from "../../fit/shared/definition/types.js";

/** Default login user for the EC2 boxes fit-cli launches (stock Ubuntu AMI). */
const DEFAULT_INSTANCE_USER = "ubuntu";

/** Where the remote install drops the binary (a per-user dir that needs no sudo). */
const DEFAULT_REMOTE_BIN_DIR = "$HOME/.local/bin";

const CBDINOCLUSTER_CANONICAL_REPO = "couchbaselabs/cbdinocluster";

/**
 * Pinned Go version used when the box doesn't have Go installed. Kept here so
 * we have one place to bump it when a new Go release is needed.
 */
export const PINNED_GO_VERSION = "1.23.4";

/** The minimum an executor must offer for {@link installCbdinoclusterRemote}. */
export type CaptureExecutor = {
  readonly description: string;
  capture(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<string>;
};

/**
 * The shell script that runs on the remote host to install cbdinocluster. It
 * maps `uname` output to the release asset naming (`cbdinocluster-<os>-<arch>`),
 * downloads the latest release with curl (`-f` so a bad URL is a hard failure),
 * makes it executable, and finally prints the absolute path it installed to so
 * the caller can parse it back. `set -e` means any step failing aborts.
 */
export function remoteInstallScript(binDir: string = DEFAULT_REMOTE_BIN_DIR): string {
  return [
    "set -e",
    `os=$(uname -s | tr '[:upper:]' '[:lower:]')`,
    "arch=$(uname -m)",
    'case "$arch" in',
    "  x86_64|amd64) arch=amd64 ;;",
    "  aarch64|arm64) arch=arm64 ;;",
    '  *) echo "cbdinocluster: unsupported architecture $arch" >&2; exit 1 ;;',
    "esac",
    `bindir="${binDir}"`,
    'mkdir -p "$bindir"',
    'target="$bindir/cbdinocluster"',
    `url="${CBDINOCLUSTER_URL}/releases/latest/download/cbdinocluster-$os-$arch"`,
    'curl -fsSL "$url" -o "$target"',
    'chmod 755 "$target"',
    // The one line of stdout the caller parses: the absolute path it installed to.
    `printf '%s\\n' "$target"`,
  ].join("\n");
}

/**
 * The shell script that builds cbdinocluster from a PR or branch on the remote
 * box. It:
 *   1. Ensures Go is available, auto-installing a pinned version if not.
 *   2. Clones the repo and checks out `refs/pull/<pr>/head` (PR) or the branch.
 *   3. Builds the binary with `go build` and installs it to `binDir`.
 *   4. Prints the absolute installed path (same contract as {@link remoteInstallScript}).
 *
 * `set -e` aborts on any failure.
 */
export function remoteBuildFromPrScript(
  source: CbdinoclusterSourceGit,
  binDir: string = DEFAULT_REMOTE_BIN_DIR,
  goVersion: string = PINNED_GO_VERSION,
): string {
  const repo = source.repo ?? CBDINOCLUSTER_CANONICAL_REPO;
  const cloneUrl = `https://github.com/${repo}`;
  const fetchRef = source.pr !== undefined ? `refs/pull/${source.pr}/head` : source.branch;
  const label = source.pr !== undefined ? `PR #${source.pr}` : `branch ${source.branch}`;

  return [
    "set -e",
    // Ensure Go. If `go` isn't on PATH, download and unpack the pinned version.
    `if ! command -v go >/dev/null 2>&1; then`,
    `  goarch=$(uname -m)`,
    `  case "$goarch" in`,
    `    x86_64|amd64) goarch=amd64 ;;`,
    `    aarch64|arm64) goarch=arm64 ;;`,
    `    *) echo "cbdinocluster build: unsupported architecture $goarch" >&2; exit 1 ;;`,
    `  esac`,
    `  goos=$(uname -s | tr '[:upper:]' '[:lower:]')`,
    `  gotar="go${goVersion}.$goos-$goarch.tar.gz"`,
    `  gourl="https://go.dev/dl/$gotar"`,
    `  echo "→ Go not found; installing go${goVersion} from $gourl"`,
    `  curl -fsSL "$gourl" -o "/tmp/$gotar"`,
    `  mkdir -p "$HOME/.local/go-dist"`,
    `  tar -C "$HOME/.local/go-dist" -xzf "/tmp/$gotar" --strip-components=1`,
    `  rm -f "/tmp/$gotar"`,
    `  export PATH="$HOME/.local/go-dist/bin:$PATH"`,
    `fi`,
    // Clone and check out the PR/branch.
    `clonedir="$(mktemp -d)/cbdinocluster"`,
    `echo "→ Cloning ${cloneUrl} ..."`,
    `git clone --depth=1 ${cloneUrl} "$clonedir"`,
    `echo "→ Fetching ${label} (${fetchRef}) ..."`,
    `git -C "$clonedir" fetch origin ${fetchRef}`,
    `git -C "$clonedir" checkout FETCH_HEAD`,
    // Build.
    `bindir="${binDir}"`,
    `mkdir -p "$bindir"`,
    `target="$bindir/cbdinocluster"`,
    `echo "→ Building cbdinocluster from ${label} ..."`,
    `cd "$clonedir" && go build -o "$target" .`,
    `chmod 755 "$target"`,
    `rm -rf "$clonedir"`,
    // Same one-line stdout contract as remoteInstallScript.
    `printf '%s\\n' "$target"`,
  ].join("\n");
}

/**
 * Install the latest cbdinocluster release on the host `execution` runs on, and
 * resolve with the absolute path to the installed binary. Throws (via the
 * executor) if the download or install fails, or if nothing usable came back.
 */
export async function installCbdinoclusterRemote(
  execution: CaptureExecutor,
  binDir: string = DEFAULT_REMOTE_BIN_DIR,
): Promise<string> {
  console.log(
    `→ Installing the latest cbdinocluster release on ${execution.description} from ${CBDINOCLUSTER_URL}...`,
  );
  const output = await execution.capture("sh", ["-lc", remoteInstallScript(binDir)], undefined, {
    display: `install cbdinocluster from ${CBDINOCLUSTER_URL}`,
  });
  return parseInstalledPath(output, "cbdinocluster install script didn't print where it installed the binary");
}

/**
 * Build cbdinocluster from a PR or branch on the remote box and return the
 * absolute path to the installed binary. Go is auto-installed on the box if
 * absent.
 */
export async function buildCbdinoclusterFromPr(
  execution: CaptureExecutor,
  source: CbdinoclusterSourceGit,
  binDir: string = DEFAULT_REMOTE_BIN_DIR,
): Promise<string> {
  const repo = source.repo ?? CBDINOCLUSTER_CANONICAL_REPO;
  const label = source.pr !== undefined ? `PR #${source.pr}` : `branch ${source.branch}`;
  console.log(`→ Building cbdinocluster from ${label} (${repo}) on ${execution.description}...`);
  const output = await execution.capture("sh", ["-lc", remoteBuildFromPrScript(source, binDir)], undefined, {
    display: `build cbdinocluster from ${label} (${repo})`,
  });
  const installedPath = parseInstalledPath(output, "cbdinocluster build script didn't print where it installed the binary");
  console.log(`✓ Built cbdinocluster (${label}) on ${execution.description} at ${installedPath}`);
  return installedPath;
}

function parseInstalledPath(output: string, errorMsg: string): string {
  const installedPath = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  if (!installedPath) {
    throw new Error(errorMsg);
  }
  return installedPath;
}

/** Read a `--<name> <value>` (or `--<name>=<value>`) flag from argv. */
function flag(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) {
      return argv[i + 1];
    }
    if (argv[i].startsWith(prefix)) {
      return argv[i].slice(prefix.length);
    }
  }
  return undefined;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);

    if (argv.includes("--help") || argv.includes("-h")) {
      console.log(
        "Usage:\n" +
          "  install-cbdinocluster.ts --dir <instance-dir> [--user ubuntu] [--pr <N> | --branch <name>] [--repo owner/repo]\n" +
          "  install-cbdinocluster.ts --instance <ec2-id> --key <path.pem> [--user ubuntu] [--pr <N> | --branch <name>] [--repo owner/repo]\n" +
          "\n" +
          "Options:\n" +
          "  --dir        path to an instance dir (reads ec2-instance.json + .pem automatically)\n" +
          "  --instance   EC2 instance ID (e.g. i-0123456789abcdef0)\n" +
          "  --key        path to SSH private key (.pem)\n" +
          "  --user       SSH user on the box (default: ubuntu)\n" +
          "  --pr         PR number to build from source instead of using the latest release\n" +
          "  --branch     branch name to build from source instead of using the latest release\n" +
          "  --repo       GitHub repo for the PR/branch, as owner/repo (default: couchbaselabs/cbdinocluster)\n",
      );
      process.exit(0);
    }

    let instanceId = flag(argv, "instance");
    const user = flag(argv, "user") ?? DEFAULT_INSTANCE_USER;
    const prStr = flag(argv, "pr");
    const branch = flag(argv, "branch");
    const repo = flag(argv, "repo");

    if (prStr !== undefined && branch !== undefined) {
      fitCliError("--pr and --branch are mutually exclusive");
      process.exit(1);
    }

    const instanceDir = flag(argv, "dir");
    if (instanceDir) {
      const info = JSON.parse(readFileSync(join(instanceDir, "ec2-instance.json"), "utf8")) as { instanceId?: string };
      instanceId ??= info.instanceId;
    }

    if (!instanceId) {
      fitCliError(
        "Usage:\n" +
          "  install-cbdinocluster.ts --dir <instance-dir> [--user ubuntu] [--pr <N>]\n" +
          "  install-cbdinocluster.ts --instance <ec2-id> [--user ubuntu] [--pr <N>]",
      );
      process.exit(1);
    }

    await prepareAwsCli();
    process.stdout.write(`Waiting for ${instanceId} to register with SSM...`);
    if (!(await waitForSsmReady(instanceId))) {
      console.log(" unreachable");
      throw new Error(`Couldn't reach ${instanceId} over SSM. Check the instance id and that it's up.`);
    }
    console.log(" ready");

    const target = new SsmTarget(instanceId, user);

    let installedPath: string;
    if (prStr !== undefined) {
      const pr = parseInt(prStr, 10);
      if (isNaN(pr) || pr <= 0) {
        fitCliError(`--pr must be a positive integer, got: ${prStr}`);
        process.exit(1);
      }
      installedPath = await buildCbdinoclusterFromPr(target, { pr, repo });
    } else if (branch !== undefined) {
      installedPath = await buildCbdinoclusterFromPr(target, { branch, repo });
    } else {
      installedPath = await installCbdinoclusterRemote(target);
    }

    // Sanity-check the binary actually runs on this box.
    await target.capture(installedPath, ["--help"]);
    console.log(`\n✓ cbdinocluster is ready on ${instanceId} at ${installedPath}`);

    return {
      details: [
        { label: "Instance", value: instanceId },
        { label: "cbdinocluster path", value: installedPath },
        { label: "Debug access (SSM)", value: ssmStartSessionCommand(instanceId) },
        ...(prStr ? [{ label: "Built from PR", value: `${repo ?? CBDINOCLUSTER_CANONICAL_REPO}#${prStr}` }] : []),
        ...(branch ? [{ label: "Built from branch", value: `${repo ?? CBDINOCLUSTER_CANONICAL_REPO}@${branch}` }] : []),
      ],
    };
  });
}
