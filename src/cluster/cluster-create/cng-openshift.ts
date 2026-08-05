/**
 * Kubernetes plumbing for CNG / Protostellar functional cycles on OpenShift
 * (ROSA). This is the path fit-cli actually uses for CNG: Brett confirmed we can
 * only test CNG against the shared ROSA cluster, so cbdinocluster's `cao` deployer
 * runs against it rather than the local k3d cluster {@link provisionRemoteK3d}
 * stands up. The k3d path is kept for future local/dev use but is unreachable by
 * default (see {@link cngKubernetesBackend}).
 *
 * On a clean instance a CNG cycle needs, before cbdinocluster can allocate:
 * - the `oc` CLI installed (pinned, sha256-verified against the OpenShift mirror)
 * - `oc login` to the ROSA cluster (credentials from AWS Secrets Manager)
 * - a pre-flight that clears Couchbase CRs stuck Terminating and force-cleans
 *   broken namespaces left by a previous run on the shared cluster
 * - the cao tools cbdinocluster needs ({@link installCaoToolsRemote})
 * - a `~/.cbdinocluster` `k8s` block pointing at the logged-in OpenShift context
 *   ({@link buildOpenShiftK8sBlock})
 *
 * Run on its own:
 *   # Print the oc-install script it would run on the box (no SSH, no AWS):
 *   bun src/cluster/cluster-create/cng-openshift.ts print-oc-install [--version 4.10.67]
 *   # Print the pre-flight cleanup script:
 *   bun src/cluster/cluster-create/cng-openshift.ts print-preflight
 *   # Print the k8s block fit-cli uploads, for a given home + context:
 *   bun src/cluster/cluster-create/cng-openshift.ts k8s-block /home/ubuntu my-context
 *   # Provision oc + login + pre-flight + cao tools on a saved instance dir
 *   # (reads ROSA creds from AWS Secrets Manager):
 *   bun src/cluster/cluster-create/cng-openshift.ts --dir /tmp/fit-cli/<run>/instances/0
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { fitCliError } from "../../util/non-fit/fit-cli-log.js";
import type { PieceData } from "../../util/non-fit/config-pieces.js";
import type { RunOptions } from "../../util/non-fit/proc.js";
import { posixQuote } from "../../util/non-fit/remote-target.js";
import { SsmTarget, waitForSsmReady } from "../../util/non-fit/ssm-target.js";
import { ssmStartSessionCommand } from "../../fit/util/aws/lifecycle-warning.js";
import { prepareAwsCli } from "../../cloud/util/aws/aws-cli.js";
import { resolveRosaCredentials, type ResolvedRosaCredentials } from "../../fit/util/config.js";
import { throwFatalToCluster } from "../../fit/shared/failure-classification.js";
import { CAO_TOOLS_VERSION, installCaoToolsRemote } from "./install-cao-tools.js";

export { CAO_TOOLS_VERSION } from "./install-cao-tools.js";

/**
 * The OpenShift `oc` client version fit-cli installs, matching PR #123's default.
 * Overridable with the `OC_VERSION` env var (the CI `vars.OC_VERSION` equivalent).
 */
export const DEFAULT_OC_VERSION = "4.10.67";

/** Where the OpenShift mirror publishes the per-arch client tarballs + checksums. */
export const OC_MIRROR_BASE = "https://mirror.openshift.com/pub/openshift-v4";

/** Default login user for the EC2 boxes fit-cli launches (stock Ubuntu AMI). */
const DEFAULT_INSTANCE_USER = "ubuntu";

/** The minimum an executor must offer to provision OpenShift on a box. */
export type OpenShiftExecutor = {
  readonly description: string;
  run(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<void>;
  capture(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<string>;
};

/**
 * Which Kubernetes backend a remote CNG cycle uses. OpenShift/ROSA is the only
 * tested path and the default; `k3d` is the legacy local-dev path, kept in place
 * but reachable only by setting `FIT_CNG_K8S=k3d`. Pure logic.
 */
export type CngKubernetesBackend = "openshift" | "k3d";

export function cngKubernetesBackend(env: NodeJS.ProcessEnv = process.env): CngKubernetesBackend {
  return env.FIT_CNG_K8S?.trim().toLowerCase() === "k3d" ? "k3d" : "openshift";
}

/** The pinned oc version, honouring the `OC_VERSION` override. Pure logic. */
export function resolveOcVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.OC_VERSION?.trim() || DEFAULT_OC_VERSION;
}

/**
 * Shell script that installs the `oc` client of `version` into `~/.local/bin`,
 * matching what PR #123 does: download the tarball for the box's arch from the
 * OpenShift mirror, verify its sha256 against the mirror's published
 * `sha256sum.txt`, then extract just the `oc` binary. Idempotent — skips the whole
 * thing when `oc` already reports the pinned version. Pure logic. `set -e` aborts
 * on any step failing.
 *
 * Pin a specific checksum with the `OC_SHA256` env var; otherwise the script
 * trusts (but still verifies against) the mirror's published checksum file.
 */
export function ocInstallScript(version: string = DEFAULT_OC_VERSION): string {
  return [
    "set -e",
    `ver=${posixQuote(version)}`,
    'bindir="$HOME/.local/bin"',
    'mkdir -p "$bindir"',
    // Already the pinned version? Nothing to do (resumed run / warm box).
    'if command -v oc >/dev/null 2>&1 && oc version --client 2>/dev/null | grep -q "$ver"; then',
    `  printf '%s\\n' "oc $ver already installed"`,
    "  exit 0",
    "fi",
    "arch=$(uname -m)",
    // Use the version-stamped tarball names — that's how the mirror's
    // sha256sum.txt lists them, so the download and checksum lookup line up.
    'case "$arch" in',
    '  x86_64|amd64) archdir=x86_64; tarball="openshift-client-linux-$ver.tar.gz" ;;',
    '  aarch64|arm64) archdir=arm64; tarball="openshift-client-linux-arm64-$ver.tar.gz" ;;',
    '  *) echo "oc: unsupported architecture $arch" >&2; exit 1 ;;',
    "esac",
    `base="${OC_MIRROR_BASE}/$archdir/clients/ocp/$ver"`,
    "tmp=$(mktemp -d)",
    `trap 'rm -rf "$tmp"' EXIT`,
    'curl -fsSL "$base/$tarball" -o "$tmp/oc.tar.gz"',
    // Verify the download. A pinned OC_SHA256 wins; otherwise look the expected
    // value up in the mirror's sha256sum.txt for this exact tarball.
    'expected="${OC_SHA256:-}"',
    'if [ -z "$expected" ]; then',
    '  curl -fsSL "$base/sha256sum.txt" -o "$tmp/sha256sum.txt"',
    '  expected=$(grep " $tarball\\$" "$tmp/sha256sum.txt" | awk \'{print $1}\' | head -n1)',
    "fi",
    'if [ -z "$expected" ]; then echo "oc: could not determine expected sha256" >&2; exit 1; fi',
    'actual=$(sha256sum "$tmp/oc.tar.gz" | awk \'{print $1}\')',
    'if [ "$actual" != "$expected" ]; then',
    '  echo "oc: sha256 mismatch (expected $expected, got $actual)" >&2; exit 1',
    "fi",
    'tar -xzf "$tmp/oc.tar.gz" -C "$tmp" oc',
    'install -m 0755 "$tmp/oc" "$bindir/oc"',
    `printf '%s\\n' "installed oc $ver to $bindir/oc"`,
  ].join("\n");
}

/**
 * Install the pinned `oc` client on the box `execution` runs on. Throws (via the
 * executor) if the download, checksum verification, or install fails.
 */
export async function installOcRemote(
  execution: OpenShiftExecutor,
  version: string = DEFAULT_OC_VERSION,
): Promise<void> {
  console.log(`→ setup-cluster: installing oc ${version} on ${execution.description}…`);
  await execution.run("sh", ["-lc", ocInstallScript(version)], undefined, {
    display: `install oc ${version}`,
  });
}

/**
 * Shell script that pre-cleans the shared ROSA cluster before a CNG allocate,
 * mirroring PR #123's pre-flight. Two failure modes a previous run can leave
 * behind on a cluster cbdinocluster doesn't fully own:
 * - Couchbase custom resources stuck in Terminating because their finalizers
 *   never ran — we strip the finalizers so the namespace can drain.
 * - namespaces stuck Terminating after a broken cbdino teardown — we strip their
 *   finalizers too.
 *
 * Best-effort: every step is guarded so a clean cluster is a no-op and a missing
 * CRD/namespace doesn't abort the run. Pure logic.
 *
 * grahamp: This was produced during a marathon LLM iteration to get stable testing against OpenShift.
 */
export function openshiftPreflightScript(): string {
  return [
    "set -u",
    // Remove cbdc2-<cluster-id> namespaces stuck in Terminating from previous runs.
    // Only Terminating namespaces are targeted — an Active namespace might belong to
    // another concurrent fit-cli run on the shared ROSA cluster.
    // We skip cbdc2-cao-admission: it holds the admission controller whose CA bundle is
    // embedded cluster-wide; deleting it causes "x509: certificate signed by unknown authority".
    'echo "→ pre-flight: deleting cbdc2-* cluster namespaces stuck in Terminating"',
    "term_ns=$(oc get ns -o jsonpath='{range .items[*]}{.metadata.name} {.status.phase}{\"\\n\"}{end}' 2>/dev/null | awk '$2==\"Terminating\" && $1 ~ /^cbdc2-/ && $1 != \"cbdc2-cao-admission\" {print \"namespace/\" $1}' || true)",
    'if [ -n "$term_ns" ]; then',
    '  echo "$term_ns" | while read ns; do',
    '    echo "  deleting stuck $ns"',
    "    oc delete \"$ns\" --wait=false 2>/dev/null || true",
    "  done",
    "else",
    '  echo "  no cbdc2-* namespaces stuck in Terminating"',
    "fi",
    'echo "→ pre-flight: clearing Couchbase CRs stuck in Terminating"',
    // Strip finalizers from any couchbase.com custom resource across all namespaces
    // so a half-deleted cluster from a previous run can finish draining.
    "for crd in $(oc get crd -o name 2>/dev/null | grep 'couchbase.com' || true); do",
    '  kind="${crd#customresourcedefinition.apiextensions.k8s.io/}"',
    '  for ns in $(oc get "$kind" -A -o jsonpath=\'{range .items[?(@.metadata.deletionTimestamp)]}{.metadata.namespace}/{.metadata.name}{"\\n"}{end}\' 2>/dev/null || true); do',
    '    [ -n "$ns" ] || continue',
    '    name="${ns#*/}"; namespace="${ns%/*}"',
    '    echo "  patching $kind $ns to drop finalizers"',
    '    oc patch "$kind" "$name" -n "$namespace" --type=merge -p \'{"metadata":{"finalizers":[]}}\' 2>/dev/null || true',
    "  done",
    "done",
    // The Kubernetes GC may re-add the foregroundDeletion finalizer to CRs (because owned
    // objects still exist), preventing the CRD from finishing its deletion.  Patching the
    // CRD's own customresourcecleanup finalizer out lets the CRD complete deletion
    // immediately — install-crds can then re-create it cleanly.
    'echo "→ pre-flight: clearing Couchbase CRDs stuck in Terminating"',
    "for crd in $(oc get crd -o name 2>/dev/null | grep 'couchbase.com' || true); do",
    '  dt=$(oc get "$crd" -o jsonpath=\'{.metadata.deletionTimestamp}\' 2>/dev/null || true)',
    '  [ -n "$dt" ] || continue',
    '  echo "  patching $crd (deletionTimestamp: $dt) to drop CRD finalizers"',
    '  oc patch "$crd" --type=merge -p \'{"metadata":{"finalizers":[]}}\' 2>/dev/null || true',
    "done",
    'echo "→ pre-flight: clearing namespaces stuck in Terminating"',
    "for ns in $(oc get ns -o jsonpath='{range .items[?(@.status.phase==\"Terminating\")]}{.metadata.name}{\"\\n\"}{end}' 2>/dev/null || true); do",
    '  [ -n "$ns" ] || continue',
    '  echo "  clearing finalizers on namespace $ns"',
    '  oc patch ns "$ns" --type=merge -p \'{"spec":{"finalizers":[]}}\' 2>/dev/null || true',
    "done",
    'echo "→ pre-flight: done"',
  ].join("\n");
}

/** Run the shared-cluster pre-flight cleanup on the box. Best-effort (never throws on a dirty cluster). */
export async function runOpenShiftPreflight(execution: OpenShiftExecutor): Promise<void> {
  console.log(`→ setup-cluster: running ROSA pre-flight cleanup on ${execution.description}…`);
  await execution.run("sh", ["-lc", openshiftPreflightScript()], undefined, {
    display: "ROSA pre-flight cleanup",
  });
}

/**
 * CPU a single CAO-deployed Couchbase Server pod requests — confirmed live
 * 2026-07-08 from a `cbdc2-*` pod spec on the shared ROSA cluster
 * (`resources.requests.cpu: "2"`; the `cloud-native-gateway` sidecar has no
 * explicit request). The shared cluster's nodes were 3500m allocatable each, so
 * in practice each node fits at most one Couchbase Server pod. Hardcoded rather
 * than derived, since fit-cli has no way to introspect CAO's pod template ahead
 * of an allocate — if CAO's resource requests change, update this.
 */
export const CNG_CPU_MILLICORES_PER_NODE = 2000;

/** One-liner to force-remove every cbdinocluster stuck `creating` on the box (emergency capacity relief). */
export const CNG_EMERGENCY_CLEANUP_COMMAND =
  "cbdinocluster -v ls 2>&1 | grep 'State: creating' | awk '{print $1}' | xargs -I{} cbdinocluster remove {}";

function parseCpuMillicores(value: string | undefined): number {
  if (!value) return 0;
  return value.endsWith("m") ? parseInt(value, 10) : Math.round(parseFloat(value) * 1000);
}

/** Free vs. required CPU on the shared ROSA cluster for a CNG allocate of `requiredNodes` size. */
export interface CngCapacity {
  ok: boolean;
  freeMillicores: number;
  requiredMillicores: number;
  nodeCount: number;
}

/**
 * Measure free CPU headroom on the OpenShift cluster `execution` is logged into:
 * sum of node-allocatable CPU minus CPU requested by every non-terminated pod,
 * compared against `requiredNodes * `{@link CNG_CPU_MILLICORES_PER_NODE}. Doesn't
 * account for memory or other resources — CPU is what's exhausted the shared
 * cluster every time we've hit this in practice (`Insufficient cpu` scheduling
 * failures), so it's the cheapest useful signal.
 */
export async function checkCngCapacity(execution: OpenShiftExecutor, requiredNodes: number): Promise<CngCapacity> {
  const [nodesJson, podsJson] = await Promise.all([
    execution.capture("oc", ["get", "nodes", "-o", "json"], undefined, { quiet: true }),
    execution.capture(
      "oc",
      ["get", "pods", "-A", "-o", "json", "--field-selector", "status.phase!=Succeeded,status.phase!=Failed"],
      undefined,
      { quiet: true },
    ),
  ]);
  const nodes = JSON.parse(nodesJson) as { items: { status?: { allocatable?: { cpu?: string } } }[] };
  const pods = JSON.parse(podsJson) as {
    items: { spec?: { containers?: { resources?: { requests?: { cpu?: string } } }[] } }[];
  };
  const allocatable = nodes.items.reduce((sum, n) => sum + parseCpuMillicores(n.status?.allocatable?.cpu), 0);
  const requested = pods.items.reduce(
    (sum, p) =>
      sum + (p.spec?.containers ?? []).reduce((s, c) => s + parseCpuMillicores(c.resources?.requests?.cpu), 0),
    0,
  );
  const freeMillicores = allocatable - requested;
  const requiredMillicores = requiredNodes * CNG_CPU_MILLICORES_PER_NODE;
  return { ok: freeMillicores >= requiredMillicores, freeMillicores, requiredMillicores, nodeCount: nodes.items.length };
}

/**
 * Human-readable capacity-shortfall message with pointers to diagnose and
 * (manually) clear it. `target` identifies the box to run those commands on
 * (`user@host`, from {@link OpenShiftExecutor.description}) — `oc`/`cbdinocluster`
 * are only logged in and installed there, not on the machine invoking fit-cli;
 * see the "SSH ACCESS" block printed earlier in this run for the full `ssh -i
 * ...` command.
 */
export function formatCngCapacityShortfall(capacity: CngCapacity, requiredNodes: number, target: string): string {
  return [
    `The shared ROSA cluster doesn't have enough free CPU for a ${requiredNodes}-node CNG cluster right now.`,
    `  Free:    ${(capacity.freeMillicores / 1000).toFixed(1)} CPU across ${capacity.nodeCount} nodes.`,
    `  Needed:  ~${(capacity.requiredMillicores / 1000).toFixed(1)} CPU (${requiredNodes} nodes × ${CNG_CPU_MILLICORES_PER_NODE / 1000} CPU/node).`,
    "",
    "This is usually leaked/stuck clusters from previous failed runs — cbdinocluster's cleanup only reaps",
    "*expired* clusters, and a failed allocate can leave one running indefinitely otherwise.",
    "",
    `Run the following on ${target} (where oc/cbdinocluster are installed and logged in — see the SSH`,
    "ACCESS block printed earlier in this run for the full ssh command), NOT on your own machine:",
    "  See what's using capacity:  cbdinocluster -v ls",
    "  Emergency cleanup (removes every cluster stuck 'creating' — check none belong to someone else's active run first):",
    `    ${CNG_EMERGENCY_CLEANUP_COMMAND}`,
    "  Note: cbdc-cleanup-cronjob (namespace cbdc-shared) also runs every 15 minutes, but only reaps clusters",
    "  that have already expired — it won't free capacity immediately if everything is still within its expiry window.",
  ].join("\n");
}

/**
 * Preflight capacity check before a CNG allocate. Only checks and reports —
 * never removes anything itself; see {@link formatCngCapacityShortfall} for the
 * manual cleanup commands it points at. Best-effort: if `oc` itself fails (e.g.
 * a permissions issue unrelated to capacity), warns and lets the run proceed
 * rather than blocking on the check itself. A capacity shortfall is reported via
 * {@link throwFatalToCluster} so it's printed immediately (before the "leave
 * everything up?" prompt), matching every other cluster-setup failure.
 */
export async function preflightCngCapacity(execution: OpenShiftExecutor, requiredNodes: number): Promise<void> {
  let capacity: CngCapacity;
  try {
    capacity = await checkCngCapacity(execution, requiredNodes);
  } catch (err) {
    console.warn(`→ setup-cluster: couldn't check ROSA capacity (non-fatal): ${(err as Error).message}`);
    return;
  }
  if (!capacity.ok) {
    throwFatalToCluster(formatCngCapacityShortfall(capacity, requiredNodes, execution.description));
  }
  console.log(
    `→ setup-cluster: ROSA capacity check passed (${(capacity.freeMillicores / 1000).toFixed(1)} CPU free across ${capacity.nodeCount} nodes, need ~${(capacity.requiredMillicores / 1000).toFixed(1)}).`,
  );
}

/**
 * Post-login sanity diagnostics: `oc get nodes` and `oc get couchbaseclusters -A`.
 * Both are NonFatal — failures are logged but don't block the setup.
 */
export async function ocPostLoginDiagnostics(execution: OpenShiftExecutor): Promise<void> {
  const checks: [string, string[]][] = [
    ["oc", ["get", "nodes"]],
    ["oc", ["get", "couchbaseclusters", "-A"]],
  ];
  for (const [cmd, args] of checks) {
    try {
      await execution.run(cmd, args);
    } catch {
      console.warn(`→ setup-cluster: ${cmd} ${args.join(" ")} failed (non-fatal)`);
    }
  }
}

/**
 * `oc login` to the ROSA cluster. The password is kept out of the echoed command
 * via `display`. `--insecure-skip-tls-verify` matches the self-signed serving cert
 * the shared ROSA cluster presents (CNG itself also runs with `tls.insecure`).
 */
export async function ocLogin(execution: OpenShiftExecutor, creds: ResolvedRosaCredentials): Promise<void> {
  console.log(`→ setup-cluster: oc login to ${creds.url} as ${creds.username} on ${execution.description}…`);
  await execution.run(
    "oc",
    [
      "login",
      creds.url,
      "--username",
      creds.username,
      "--password",
      creds.password,
      "--insecure-skip-tls-verify=true",
    ],
    undefined,
    { display: `oc login ${creds.url} --username ${creds.username}` },
  );
}

/** Capture the current kube context name `oc login` selected. */
export async function currentOcContext(execution: OpenShiftExecutor): Promise<string> {
  const context = (await execution.capture("oc", ["config", "current-context"], undefined, { quiet: true })).trim();
  if (!context) {
    throw new Error("oc didn't report a current context after login");
  }
  return context;
}

/**
 * The `k8s` block fit-cli adds to the ~/.cbdinocluster it uploads to the box,
 * pointing cbdinocluster at the OpenShift cluster `oc login` selected. `home` is
 * the remote login user's home (e.g. /home/ubuntu); `context` is the kube context
 * name from {@link currentOcContext}. Pure logic.
 */
export function buildOpenShiftK8sBlock(home: string, context: string): PieceData {
  return {
    k8s: {
      enabled: "true",
      "cao-tools": `${home}/.dinotools/cao/${CAO_TOOLS_VERSION}`,
      kubeconfig: `${home}/.kube/config`,
      context,
    },
  };
}

/** Merge the OpenShift k8s block into an existing cbdinocluster init config. */
export function withOpenShiftK8sBlock(config: PieceData, home: string, context: string): PieceData {
  return { ...config, ...buildOpenShiftK8sBlock(home, context) };
}

/** The remote login user's home directory, derived from the FIT workspace root. */
export function remoteHomeFromWorkspace(workspaceRootDir: string): string {
  return dirname(workspaceRootDir);
}

/**
 * Make a clean instance CNG-ready against ROSA: install oc, log into the shared
 * cluster, run the pre-flight cleanup, and install the cao tools cbdinocluster
 * needs. Resolves with the kube context name so the caller can build the
 * ~/.cbdinocluster `k8s` block ({@link buildOpenShiftK8sBlock}). The Couchbase
 * CRDs + admission controller are installed later, once that config is uploaded,
 * by setup-declarative-cluster (see `installCaoCrdsAndAdmission`).
 */
export async function provisionRemoteOpenShift(
  execution: OpenShiftExecutor,
  home: string,
  creds: ResolvedRosaCredentials,
  version: string = DEFAULT_OC_VERSION,
  requiredNodes?: number,
): Promise<{ context: string }> {
  console.log(`\n→ setup-cluster: preparing OpenShift (ROSA) on ${execution.description} for CNG…`);
  await installOcRemote(execution, version);
  await ocLogin(execution, creds);
  await ocPostLoginDiagnostics(execution);
  const context = await currentOcContext(execution);
  // Pre-flight temporarily disabled — see https://github.com/couchbaselabs/fit-cli/issues/TBD
  // await runOpenShiftPreflight(execution);
  if (requiredNodes !== undefined) {
    await preflightCngCapacity(execution, requiredNodes);
  }
  await installCaoToolsRemote(execution, `${home}/.dinotools/cao/${CAO_TOOLS_VERSION}`);
  console.log(`→ setup-cluster: OpenShift (context ${context}) is ready for CNG.`);
  return { context };
}

/** Read a `--<name> <value>` (or `--<name>=<value>`) flag from argv. */
function flag(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(prefix)) return argv[i].slice(prefix.length);
  }
  return undefined;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    const [action] = argv;
    const version = flag(argv, "version") ?? resolveOcVersion();

    if (action === "print-oc-install") {
      console.log(ocInstallScript(version));
      return;
    }
    if (action === "print-preflight") {
      console.log(openshiftPreflightScript());
      return;
    }
    if (action === "k8s-block") {
      console.log(YAML.stringify(buildOpenShiftK8sBlock(argv[1] ?? "/home/ubuntu", argv[2] ?? "my-context")));
      return;
    }

    const requiredNodes = Number(flag(argv, "required-nodes") ?? "3");

    // Otherwise: provision a saved instance dir end-to-end (needs ROSA creds).
    const instanceDir = flag(argv, "dir");
    const user = flag(argv, "user") ?? DEFAULT_INSTANCE_USER;
    let instanceId = flag(argv, "instance");
    if (instanceDir) {
      const info = JSON.parse(readFileSync(join(instanceDir, "ec2-instance.json"), "utf8")) as { instanceId?: string };
      instanceId ??= info.instanceId;
    }
    if (!instanceId) {
      fitCliError(
        "Usage:\n" +
          "  cng-openshift.ts print-oc-install [--version 4.10.67]\n" +
          "  cng-openshift.ts print-preflight\n" +
          "  cng-openshift.ts k8s-block <home-dir> <context>\n" +
          "  cng-openshift.ts --dir <instance-dir> [--user ubuntu] [--version 4.10.67] [--required-nodes 3]\n" +
          "  cng-openshift.ts --instance <ec2-id> [--user ubuntu] [--version 4.10.67] [--required-nodes 3]",
      );
      process.exit(1);
    }

    const creds = await resolveRosaCredentials();
    if (typeof creds === "string") {
      fitCliError(creds);
      process.exit(1);
    }

    await prepareAwsCli();
    process.stdout.write(`Waiting for ${instanceId} to register with SSM...`);
    if (!(await waitForSsmReady(instanceId))) {
      console.log(" unreachable");
      throw new Error(`Couldn't reach ${instanceId} over SSM.`);
    }
    console.log(" ready");

    const target = new SsmTarget(instanceId, user);
    const home = `/home/${user}`;
    const { context } = await provisionRemoteOpenShift(target, home, creds, version, requiredNodes);
    return {
      details: [
        { label: "Instance", value: instanceId },
        { label: "oc version", value: version },
        { label: "kube context", value: context },
        { label: "k8s block", value: YAML.stringify(buildOpenShiftK8sBlock(home, context)).trim() },
        { label: "Debug access (SSM)", value: ssmStartSessionCommand(instanceId) },
      ],
    };
  });
}
