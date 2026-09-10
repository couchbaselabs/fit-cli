/**
 * Kubernetes plumbing for CNG / Protostellar functional cycles. cbdinocluster
 * installs the Cloud Native Gateway via the Couchbase Kubernetes Operator, so a
 * CNG cycle needs a working Kubernetes where cbdinocluster runs.
 *
 * Two execution targets, handled differently:
 * - localhost: the user does a one-off k3d + `cbdinocluster init --kube-config`
 *   setup, which leaves `k8s.enabled: "true"` in ~/.cbdinocluster. We only check
 *   that's present and bail with guidance if not — we don't manage it.
 * - a clean AWS instance: fit-cli installs k3d, creates the `fit-cli-cluster`
 *   k3d cluster, writes its kubeconfig, installs the cao (Couchbase Autonomous
 *   Operator) tools cbdinocluster needs, and points the uploaded ~/.cbdinocluster
 *   at it all via a `k8s` block (see {@link buildRemoteK8sBlock}).
 *
 * Run on its own:
 *   # Check this machine's ~/.cbdinocluster is CNG-ready:
 *   bun src/cluster/cluster-create/cng-kubernetes.ts check-local
 *   # Print the k8s block fit-cli uploads to a remote box for a given home dir:
 *   bun src/cluster/cluster-create/cng-kubernetes.ts remote-block /home/ubuntu
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import type { PieceData } from "../../util/non-fit/config-pieces.js";
import { posixQuote } from "../../util/non-fit/remote-target.js";
import type { ClusterCommandExecutor } from "./allocate-cluster.js";
import { CAO_TOOLS_VERSION, installCaoToolsRemote } from "./install-cao-tools.js";

export { CAO_TOOLS_VERSION } from "./install-cao-tools.js";

/** The k3d cluster fit-cli stands up for CNG on a clean instance. */
export const CNG_K3D_CLUSTER_NAME = "fit-cli-cluster";
/** k3d prefixes the kube context with `k3d-`. */
export const CNG_K3D_CONTEXT = `k3d-${CNG_K3D_CLUSTER_NAME}`;

/** Guide for installing Kubernetes support for cbdinocluster (Linux). */
export const CNG_KUBERNETES_GUIDE_URL =
  "https://couchbase.slack.com/archives/C04DB7P157T/p1778840874709169";

const CBDINOCLUSTER_CONFIG_FILENAME = ".cbdinocluster";

/** The result of checking whether a target is ready to run CNG. */
export type CngKubernetesCheck = { ok: true } | { ok: false; message: string };

function k8sBlock(config: unknown): Record<string, unknown> | undefined {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return undefined;
  }
  const k8s = (config as Record<string, unknown>).k8s;
  if (typeof k8s !== "object" || k8s === null || Array.isArray(k8s)) {
    return undefined;
  }
  return k8s as Record<string, unknown>;
}

/**
 * Whether a parsed ~/.cbdinocluster config enables Kubernetes — cbdinocluster
 * writes `enabled: "true"` (a string) but we accept the boolean too. Pure logic.
 */
export function cbdinoclusterHasK8sEnabled(config: unknown): boolean {
  const enabled = k8sBlock(config)?.enabled;
  return enabled === true || enabled === "true";
}

/** The "you need Kubernetes" message shown when a localhost CNG run can't proceed. */
export function cngKubernetesMissingMessage(): string {
  return (
    "cbdinocluster requires Kubernetes support to run CNG. On Linux, follow this guide:\n  " +
    CNG_KUBERNETES_GUIDE_URL +
    "\nThen re-run." +
    "\nfit-cli looked for a `k8s` block with `enabled: \"true\"` in ~/.cbdinocluster.  You can also try running `cbdinocluster init` and configure k8s."
  );
}

/**
 * Check that this machine's ~/.cbdinocluster is set up for CNG (Kubernetes
 * enabled). Used before a localhost CNG cycle allocates anything.
 */
export function checkLocalhostCngKubernetes(home: string = homedir()): CngKubernetesCheck {
  const configPath = join(home, CBDINOCLUSTER_CONFIG_FILENAME);
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return { ok: false, message: cngKubernetesMissingMessage() };
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return { ok: false, message: cngKubernetesMissingMessage() };
  }
  return cbdinoclusterHasK8sEnabled(parsed) ? { ok: true } : { ok: false, message: cngKubernetesMissingMessage() };
}

/**
 * The `k8s` block fit-cli adds to the ~/.cbdinocluster it uploads to a clean
 * instance, pointing cbdinocluster at the k3d cluster fit-cli stood up there.
 * `home` is the remote login user's home (e.g. /home/ubuntu). Pure logic.
 */
export function buildRemoteK8sBlock(home: string): PieceData {
  return {
    k8s: {
      enabled: "true",
      "cao-tools": `${home}/.dinotools/cao/${CAO_TOOLS_VERSION}`,
      kubeconfig: `${home}/.config/k3d/kubeconfig-${CNG_K3D_CLUSTER_NAME}.yaml`,
      context: CNG_K3D_CONTEXT,
    },
  };
}

/** Merge the remote k8s block into an existing cbdinocluster init config. */
export function withRemoteK8sBlock(config: PieceData, home: string): PieceData {
  return { ...config, ...buildRemoteK8sBlock(home) };
}

/** The remote login user's home directory, derived from the FIT workspace root. */
export function remoteHomeFromWorkspace(workspaceRootDir: string): string {
  return dirname(workspaceRootDir);
}

/**
 * Stand up Kubernetes on a clean instance for CNG: install k3d, create the
 * `fit-cli-cluster` k3d cluster, write its kubeconfig where the uploaded
 * ~/.cbdinocluster expects it, and install the cao tools cbdinocluster needs into
 * the configured `cao-tools` directory (see {@link installCaoToolsRemote}).
 *
 * The other cao prerequisites — the Couchbase CRDs and the admission controller —
 * are installed later, once the ~/.cbdinocluster config is uploaded, by
 * setup-declarative-cluster (see `installCaoCrdsAndAdmission`).
 *
 * Idempotent-ish: `k3d cluster create` is skipped if the cluster already exists
 * and the cao install is skipped if already present, so a resumed run on the same
 * box doesn't fail.
 */
export async function provisionRemoteK3d(
  execution: ClusterCommandExecutor,
  home: string,
): Promise<void> {
  console.log(`\n→ setup-cluster: provisioning Kubernetes (k3d) on ${execution.description} for CNG…`);

  if (!(await execution.commandAvailable("k3d"))) {
    console.log("→ setup-cluster: installing k3d…");
    await execution.runHiddenUntilFailure(
      "sh",
      ["-lc", "wget -q -O - https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash"],
      undefined,
      { display: "install k3d" },
    );
  }

  const clusterName = posixQuote(CNG_K3D_CLUSTER_NAME);
  await execution.run(
    "sh",
    [
      "-lc",
      `k3d cluster list ${clusterName} >/dev/null 2>&1 || k3d cluster create ${clusterName}`,
    ],
    undefined,
    { display: `k3d cluster create ${CNG_K3D_CLUSTER_NAME} (if absent)` },
  );

  const kubeconfigDir = `${home}/.config/k3d`;
  await execution.runHiddenUntilFailure("sh", ["-lc", `mkdir -p ${posixQuote(kubeconfigDir)}`], undefined, {
    display: `mkdir -p ${kubeconfigDir}`,
  });
  // `k3d kubeconfig write <cluster>` writes ~/.config/k3d/kubeconfig-<cluster>.yaml.
  await execution.runHiddenUntilFailure("sh", ["-lc", `k3d kubeconfig write ${clusterName}`], undefined, {
    display: `k3d kubeconfig write ${CNG_K3D_CLUSTER_NAME}`,
  });

  const caoToolsDir = `${home}/.dinotools/cao/${CAO_TOOLS_VERSION}`;
  await installCaoToolsRemote(execution, caoToolsDir);
  console.log(`→ setup-cluster: Kubernetes (k3d cluster ${CNG_K3D_CLUSTER_NAME}) is ready for CNG.`);
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const [action, arg] = process.argv.slice(2);
    if (action === "check-local") {
      const result = checkLocalhostCngKubernetes();
      console.log(result.ok ? "✓ This machine's ~/.cbdinocluster is CNG-ready." : `✗ ${result.message}`);
      process.exit(result.ok ? 0 : 1);
    }
    if (action === "remote-block") {
      console.log(YAML.stringify(buildRemoteK8sBlock(arg ?? "/home/ubuntu")));
      return Promise.resolve();
    }
    console.error(
      "Usage:\n" +
        "  tsx src/workflows/cluster/cluster-create/cng-kubernetes.ts check-local\n" +
        "  tsx src/workflows/cluster/cluster-create/cng-kubernetes.ts remote-block <home-dir>",
    );
    process.exit(2);
  });
}
