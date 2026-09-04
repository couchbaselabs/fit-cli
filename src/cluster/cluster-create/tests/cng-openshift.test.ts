/**
 * Unit tests for the pure CNG OpenShift (ROSA) helpers.
 *
 * Run on their own:
 *   bun run test
 *   node --import tsx --test src/cluster/cluster-create/tests/cng-openshift.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildOpenShiftK8sBlock,
  cngKubernetesBackend,
  DEFAULT_OC_VERSION,
  ocInstallScript,
  openshiftCapacityScript,
  resolveOcVersion,
  withOpenShiftK8sBlock,
} from "../cng-openshift.js";
import { CAO_TOOLS_VERSION } from "../install-cao-tools.js";

test("cngKubernetesBackend defaults to openshift and only switches to k3d on FIT_CNG_K8S=k3d", () => {
  assert.equal(cngKubernetesBackend({}), "openshift");
  assert.equal(cngKubernetesBackend({ FIT_CNG_K8S: "openshift" }), "openshift");
  assert.equal(cngKubernetesBackend({ FIT_CNG_K8S: "k3d" }), "k3d");
  assert.equal(cngKubernetesBackend({ FIT_CNG_K8S: "K3D" }), "k3d");
});

test("resolveOcVersion honours the OC_VERSION override, else the pinned default", () => {
  assert.equal(resolveOcVersion({}), DEFAULT_OC_VERSION);
  assert.equal(resolveOcVersion({ OC_VERSION: "4.12.0" }), "4.12.0");
});

test("buildOpenShiftK8sBlock points cbdinocluster at the logged-in OpenShift context", () => {
  assert.deepEqual(buildOpenShiftK8sBlock("/home/ubuntu", "rosa/api-example:6443/cluster-admin"), {
    k8s: {
      enabled: "true",
      "cao-tools": `/home/ubuntu/.dinotools/cao/${CAO_TOOLS_VERSION}`,
      kubeconfig: "/home/ubuntu/.kube/config",
      context: "rosa/api-example:6443/cluster-admin",
    },
  });
});

test("withOpenShiftK8sBlock merges the k8s block onto an init config without dropping fields", () => {
  const merged = withOpenShiftK8sBlock({ version: 6, docker: { network: "fit" } }, "/home/ubuntu", "ctx");
  assert.equal(merged.version, 6);
  assert.deepEqual(merged.docker, { network: "fit" });
  assert.equal((merged.k8s as Record<string, unknown>).context, "ctx");
});

test("ocInstallScript pins the version, verifies a checksum, and is idempotent", () => {
  const script = ocInstallScript("4.10.67");
  assert.match(script, /ver=4\.10\.67/);
  // Idempotency guard: skip when oc already reports the pinned version.
  assert.match(script, /oc version --client/);
  // Checksum verification against the mirror's sha256sum.txt (or pinned OC_SHA256).
  assert.match(script, /sha256sum\.txt/);
  assert.match(script, /sha256 mismatch/);
});

test("openshiftCapacityScript asks for the four things that diagnose a starved ROSA cluster", () => {
  const script = openshiftCapacityScript();
  // Node allocatable — a bare `oc get nodes` gives a count but not the capacity,
  // which is what actually decides whether the next 3x4Gi cluster fits.
  assert.match(script, /allocatable\.memory/);
  // Requested-vs-allocatable only comes from `describe`.
  assert.match(script, /Allocated resources/);
  // The scheduler's own explanation — the line that names the cause outright.
  assert.match(script, /reason=FailedScheduling/);
  assert.match(script, /status\.phase=Pending/);
  // The leftover-cluster backlog that starves the next run.
  assert.match(script, /couchbaseclusters/);
});

test("openshiftCapacityScript stays bounded and never fails the run", () => {
  const script = openshiftCapacityScript();
  // Dedup is what keeps this ~15 lines rather than ~235: raw FailedScheduling
  // events repeat per pod per retry, and there can be thousands.
  assert.match(script, /uniq -c/);
  // Every listing that grows with the backlog is capped, so a wedged cluster can't
  // flood the log. The two uncapped commands are bounded by node count instead, which
  // is inherently small — everything else must carry a `head`.
  for (const line of script.split("\n")) {
    if (line.trimStart().startsWith("echo ")) continue; // section headers, not listings
    const growsWithBacklog = /FailedScheduling|status\.phase=Pending|couchbaseclusters/.test(line);
    if (!growsWithBacklog) continue;
    assert.match(line, /head -\d+/, `unbounded listing could flood the log: ${line}`);
  }
  for (const [, limit] of script.matchAll(/head -(\d+)/g)) {
    assert.ok(Number(limit) <= 30, `head limit ${limit} is too generous`);
  }
  // Diagnostics must never turn a healthy run red: no bare command may propagate a
  // non-zero exit, and the script must not run under `set -e`.
  assert.doesNotMatch(script, /^set -e/m);
  for (const line of script.split("\n")) {
    if (!line.startsWith("oc ")) continue;
    assert.match(line, /\|\| true$/, `unguarded oc command could fail the run: ${line}`);
  }
});
