/**
 * Step: install the Couchbase Autonomous Operator (cao) tools on a remote box,
 * replicating what `cbdinocluster init` does interactively. cbdinocluster only
 * downloads the cao tools behind an interactive `auto-install the cao tools?
 * [Y/n]` prompt, which never fires on the non-interactive remote runs fit-cli
 * drives — so without this the configured `cao-tools` directory stays empty and a
 * CNG allocation fails later when cbdinocluster goes looking for `cao` there.
 *
 * The work is one remote shell script (see {@link caoToolsInstallScript}) so it
 * runs through any executor that can `run` a command — an {@link SsmTarget} for
 * the standalone CLI below, or the cluster executor that setup-cluster already
 * uses for {@link provisionRemoteK3d}.
 *
 * It can also install the Couchbase CRDs + admission controller (the cao
 * deployer's other prerequisites) by driving cbdinocluster's own non-interactive
 * subcommands — see {@link installCaoCrdsAndAdmission}.
 *
 * Run on its own:
 *   # Just print the script it would run (no SSH, no AWS):
 *   bun src/cluster/cluster-create/install-cao-tools.ts --print [--cao-dir <path>] [--version 2.8.0]
 *   # Install using a saved instance dir (reads ec2-instance.json + .pem automatically):
 *   bun src/cluster/cluster-create/install-cao-tools.ts --dir /tmp/fit-cli/<run>/instances/0
 *   # Install cao tools and also deploy CRDs + admission controller:
 *   bun src/cluster/cluster-create/install-cao-tools.ts --dir /tmp/fit-cli/<run>/instances/0 --deploy
 *   # Install with explicit flags:
 *   bun src/cluster/cluster-create/install-cao-tools.ts \
 *     --instance i-0123456789abcdef0 [--user ubuntu] [--version 2.8.0]
 */
import { readFileSync } from "fs";
import { join } from "path";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { prepareAwsCli } from "../../cloud/util/aws/aws-cli.js";
import { fitCliError } from "../../util/non-fit/fit-cli-log.js";
import type { RunOptions } from "../../util/non-fit/proc.js";
import { posixQuote } from "../../util/non-fit/remote-target.js";
import { SsmTarget, waitForSsmReady } from "../../util/non-fit/ssm-target.js";
import { ssmStartSessionCommand } from "../../fit/util/aws/lifecycle-warning.js";
import { loadEnvironments } from "../../fit/util/environments.js";

/**
 * The Couchbase Autonomous Operator tools version CNG uses. The cao CLI generates
 * the operator's RBAC `Role` and installs the couchbase.com CRDs, so it MUST match
 * the operator image cbdinocluster deploys (defaults.caoOperatorVersion in
 * environments.json5) — hence it's derived from it, not pinned separately. When
 * they drift, the cao CLI lays down a Role/CRD set that lacks resources the operator
 * image needs (e.g. 2.8.0's tooling has no `couchbaseencryptionkeys`), so the 2.9.2
 * operator can't sync its caches and crash-loops, the cluster never comes up, and
 * `cbdinocluster allocate` hangs forever waiting.
 */
export const CAO_TOOLS_VERSION = loadEnvironments().defaults.caoOperatorVersion;

/** Where Couchbase publishes the Autonomous Operator (cao) release tarballs. */
export const CAO_TOOLS_DOWNLOAD_BASE = "https://packages.couchbase.com/releases/couchbase-operator";

/** Default login user for the EC2 boxes fit-cli launches (stock Ubuntu AMI). */
const DEFAULT_INSTANCE_USER = "ubuntu";

/** The minimum an executor must offer for {@link installCaoToolsRemote}. */
export type RunExecutor = {
  readonly description: string;
  run(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<void>;
};

/**
 * The shell script that installs the cao tools into `caoToolsDir`, replicating
 * what `cbdinocluster init` does interactively: download the release tarball
 * matching the box's arch, extract it, and move its contents to the final
 * location (so cbdinocluster finds `cao` exactly where it expects).
 *
 * Idempotent: skips the download when `caoToolsDir` already has contents, so a
 * resumed run on the same box is a no-op. Pure logic. `set -e` aborts on any
 * step failing.
 */
export function caoToolsInstallScript(
  caoToolsDir: string,
  version: string = CAO_TOOLS_VERSION,
): string {
  return [
    "set -e",
    `dest=${posixQuote(caoToolsDir)}`,
    // Already populated (e.g. a resumed run)? Nothing to do.
    'if [ -d "$dest" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ]; then',
    `  printf '%s\\n' "cao tools already present at $dest"`,
    "  exit 0",
    "fi",
    "arch=$(uname -m)",
    'case "$arch" in',
    "  x86_64|amd64) arch=amd64 ;;",
    "  aarch64|arm64) arch=arm64 ;;",
    '  *) echo "cao: unsupported architecture $arch" >&2; exit 1 ;;',
    "esac",
    `ver=${posixQuote(version)}`,
    `url="${CAO_TOOLS_DOWNLOAD_BASE}/$ver/couchbase-autonomous-operator_$ver-kubernetes-linux-$arch.tar.gz"`,
    "tmp=$(mktemp -d)",
    `trap 'rm -rf "$tmp"' EXIT`,
    'curl -fsSL "$url" -o "$tmp/cao.tar.gz"',
    'tar -xzf "$tmp/cao.tar.gz" -C "$tmp"',
    // The tarball holds a single top-level dir; move its contents into dest so
    // cbdinocluster finds cao exactly where it expects (mirrors its own move).
    `extracted=$(find "$tmp" -maxdepth 1 -mindepth 1 -type d | head -n1)`,
    'mkdir -p "$dest"',
    'cp -R "$extracted"/. "$dest"/',
    `printf '%s\\n' "installed cao tools to $dest"`,
  ].join("\n");
}

/**
 * Install the cao tools into `caoToolsDir` on the host `execution` runs on, and
 * resolve with that directory. Throws (via the executor) if the download or
 * install fails. Idempotent by way of {@link caoToolsInstallScript}.
 */
export async function installCaoToolsRemote(
  execution: RunExecutor,
  caoToolsDir: string,
  version: string = CAO_TOOLS_VERSION,
): Promise<string> {
  console.log(`→ Installing cao tools (${version}) into ${caoToolsDir} on ${execution.description}…`);
  await execution.run("sh", ["-lc", caoToolsInstallScript(caoToolsDir, version)], undefined, {
    display: `install cao tools ${version}`,
  });
  return caoToolsDir;
}

/**
 * Install the Couchbase CRDs and the cao admission controller into the k8s
 * cluster `cbdinocluster` is pointed at, by driving cbdinocluster's own
 * non-interactive subcommands — the same operations its interactive `init` runs
 * behind the "auto-install the cao crds? [Y/n]" / "auto-install the Admission
 * Controller? [Y/n]" prompts. We run them ahead of time so the non-interactive
 * CNG allocate fit-cli drives never stalls on those prompts, and so the cao
 * deployer finds the CRDs + admission controller already present.
 *
 * Both subcommands read the kubeconfig/context (the `k8s` block) and the GHCR
 * credentials (the `github` block) from the `~/.cbdinocluster` we upload, so this
 * must run *after* that upload — and after the k3d cluster is up. Both are
 * idempotent: cbdinocluster removes any existing couchbase CRDs / admission
 * controller before reinstalling, so a resumed run is safe.
 *
 * `cbdinocluster` is the resolved command to invoke it with (its name on the
 * remote PATH, or the absolute path {@link installCbdinoclusterRemote} returned).
 */
export async function installCaoCrdsAndAdmission(
  execution: RunExecutor,
  cbdinocluster: string,
): Promise<void> {
  console.log(`→ Installing Couchbase CRDs on ${execution.description} (cbdinocluster tools cao install-crds)…`);
  await execution.run(cbdinocluster, ["tools", "cao", "install-crds"], undefined, {
    display: "cbdinocluster tools cao install-crds",
  });
  console.log(
    `→ Installing the cao admission controller on ${execution.description} (cbdinocluster tools cao install-admission)…`,
  );
  await execution.run(cbdinocluster, ["tools", "cao", "install-admission"], undefined, {
    display: "cbdinocluster tools cao install-admission",
  });
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

/** The cao-tools dir for a login user, mirroring the remote `k8s` block layout. */
function defaultCaoToolsDir(user: string, version: string): string {
  return `/home/${user}/.dinotools/cao/${version}`;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    const version = flag(argv, "version") ?? CAO_TOOLS_VERSION;

    // --print just emits the script (no SSH, no AWS) — handy for inspection.
    if (argv.includes("--print")) {
      const dir = flag(argv, "dir") ?? defaultCaoToolsDir(DEFAULT_INSTANCE_USER, version);
      console.log(caoToolsInstallScript(dir, version));
      return;
    }

    let instanceId = flag(argv, "instance");
    const user = flag(argv, "user") ?? DEFAULT_INSTANCE_USER;

    const instanceDir = flag(argv, "dir");
    if (instanceDir) {
      const info = JSON.parse(readFileSync(join(instanceDir, "ec2-instance.json"), "utf8")) as { instanceId?: string };
      instanceId ??= info.instanceId;
    }

    if (!instanceId) {
      fitCliError(
        "Usage:\n" +
          "  install-cao-tools.ts --dir <instance-dir> [--user ubuntu] [--version 2.8.0] [--cao-dir <cao-tools-dir>] [--deploy]\n" +
          "  install-cao-tools.ts --instance <ec2-id> [--user ubuntu] [--version 2.8.0] [--cao-dir <cao-tools-dir>] [--deploy]\n" +
          "  install-cao-tools.ts --print [--cao-dir <cao-tools-dir>] [--version 2.8.0]\n" +
          "\n--deploy also installs the Couchbase CRDs + admission controller (needs cbdinocluster + a CNG-ready ~/.cbdinocluster on the box).",
      );
      process.exit(1);
    }
    const caoToolsDir = flag(argv, "cao-dir") ?? defaultCaoToolsDir(user, version);

    await prepareAwsCli();
    process.stdout.write(`Waiting for ${instanceId} to register with SSM...`);
    if (!(await waitForSsmReady(instanceId))) {
      console.log(" unreachable");
      throw new Error(`Couldn't reach ${instanceId} over SSM. Check the instance id and that it's up.`);
    }
    console.log(" ready");

    const target = new SsmTarget(instanceId, user);
    await installCaoToolsRemote(target, caoToolsDir, version);
    console.log(`\n✓ cao tools (${version}) are ready on ${instanceId} at ${caoToolsDir}`);

    // --deploy also installs the CRDs + admission controller into the box's k8s
    // cluster. Needs cbdinocluster + a CNG-ready ~/.cbdinocluster already on the
    // box (k8s + github blocks); override the binary with --cbdinocluster.
    const details = [
      { label: "Instance", value: instanceId },
      { label: "cao tools dir", value: caoToolsDir },
      { label: "Debug access (SSM)", value: ssmStartSessionCommand(instanceId) },
    ];
    if (argv.includes("--deploy")) {
      const cbdinocluster = flag(argv, "cbdinocluster") ?? "cbdinocluster";
      await installCaoCrdsAndAdmission(target, cbdinocluster);
      console.log(`\n✓ Couchbase CRDs + admission controller installed on ${instanceId}`);
      details.push({ label: "cao deploy", value: "CRDs + admission controller installed" });
    }

    return { details };
  });
}
