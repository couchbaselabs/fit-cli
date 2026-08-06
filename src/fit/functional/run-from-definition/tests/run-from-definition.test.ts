import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sdkByValue } from "../../../../util/sdk/sdks.js";
import type { ClusterCommandExecutor } from "../../../../cluster/cluster-create/allocate-cluster.js";
import type { ResolvedExecutionGroup, ResolvedFunctionalExecutionGroup } from "../../../shared/definition/resolve-definition.js";
import type { FitExecutionContext } from "../../../shared/util/remote-fit-run.js";
import type { ExecutionOverride } from "../../select-execution-target/select-execution-target.js";
import {
  cbdinoclusterSetupFailed,
  finalizeRunFromDefinition,
  repoDirOverrideConflictsWithRemote,
  runTests,
  scopedPromptId,
  setupCluster,
  situationalCbdinoSettings,
} from "../run-from-definition.js";
import { loadEnvironments } from "../../../util/environments.js";

function functionalCycle(): ResolvedFunctionalExecutionGroup {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  return {
    type: "functional",
    path: { instanceIndex: 0, clusterIndex: 0 },
    instance: { kind: "localhost" },
    clusterMode: "cbdinocluster",
    cng: false,
    capellaEnvironment: "dev",
    cbdinocluster: {
      config: { nodes: [{ count: 1, version: "8.1.0-2188", services: ["kv"] }] },
      onClusterExists: "destroyAndRecreate",
    },
    sessions: [
      {
        sdk,
        performerPort: 8060,
        onPortInUse: "restart",
        path: { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0 },
        runs: [
          {
            type: "functional",
            path: { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0, runIndex: 0 },
            sdk,
            performerPort: 8060,
            testSelection: { allTests: [], selectedTests: [] },
            onPortInUse: "restart",
            extraMavenArgs: [],
          },
          {
            type: "functional",
            path: { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0, runIndex: 1 },
            sdk,
            performerPort: 8061,
            testSelection: { allTests: [], selectedTests: [] },
            onPortInUse: "restart",
            extraMavenArgs: [],
          },
        ],
      },
    ],
  };
}

function executor(): ClusterCommandExecutor {
  return {
    description: "test target",
    run: () => Promise.resolve(),
    capture: () => Promise.resolve(""),
    streamToTerminalAndFile: () => Promise.resolve(),
    targetFilePath: (path) => path,
    stageFile: (path) => Promise.resolve(path),
    collectFile: (_targetPath: string, localPath: string) => Promise.resolve(localPath),
    commandAvailable: () => Promise.resolve(true),
  };
}

function cluster() {
  return {
    scheme: "couchbase" as const,
    defaultHostname: "localhost",
    flavour: "self-managed" as const,
    credentials: { username: "Administrator", password: "password" },
    tls: null,
  };
}

function iteration() {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  return {
    type: "functional" as const,
    path: { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0, runIndex: 0 },
    sdk,
    cluster: cluster(),
    performerPort: 8060,
    testSelection: { allTests: [], selectedTests: [] },
    onPortInUse: "restart" as const,
    extraMavenArgs: [],
  };
}

function fitExecutionContext(): FitExecutionContext {
  return {
    kind: "local",
    description: "test execution",
    target: {
      kind: "local",
      description: "this machine",
      run: () => Promise.resolve(),
      capture: () => Promise.resolve(""),
      runHiddenUntilFailure: () => Promise.resolve(),
      putFile: () => Promise.resolve(),
      getFile: () => Promise.resolve(),
    },
    rootDir: "/tmp/root",
    fitPerformerDir: "/tmp/performer",
    dockerCommand: "docker",
    artifacts: [],
    details: [],
    ensureWorkspace: () => Promise.resolve(true),
    run: () => Promise.resolve(),
    capture: () => Promise.resolve(""),
    runHiddenUntilFailure: () => Promise.resolve(),
    streamToTerminalAndFile: () => Promise.resolve(),
    streamToArtifactFile: () => Promise.resolve(),
    streamToArtifactFileInBackground: () => Promise.resolve({ drain: () => Promise.resolve() }),
    targetFilePath: (path) => path,
    stageFile: (path) => Promise.resolve(path),
    collectFile: (_targetPath: string, localPath: string) => Promise.resolve(localPath),
    removeTree: () => Promise.resolve(),
    runArtifactsDir: () => "/tmp/root/artifacts/run",
    collectJunitArtifacts: () => Promise.resolve([]),
    collectResultsDir: () => Promise.resolve(undefined),
    pathExists: () => Promise.resolve(true),
    commandAvailable: () => Promise.resolve(true),
    performerRunArgs: () => [],
  };
}

test("setupCluster applies the allocated cbdinocluster to every functional iteration in the cycle", async () => {
  const cycle = functionalCycle();
  const execution = executor();
  let receivedExecution: ClusterCommandExecutor | undefined;

  const result = await setupCluster(cycle, execution, (_plan, passedExecution) => {
    receivedExecution = passedExecution;
    return Promise.resolve({
      allocated: true,
      clusterId: "cluster-id",
      cbdinocluster: "cbdinocluster",
      cluster: cluster(),
      artifacts: [],
      details: [],
    });
  });

  assert.equal(receivedExecution, execution);
  assert.deepEqual(result.group.sessions.flatMap((s) => s.runs.map((r) => r.cluster)), [cluster(), cluster()]);
});

test("setupCluster leaves the iterations unchanged when allocation fails", async () => {
  const result = await setupCluster(functionalCycle(), executor(), () =>
    Promise.resolve({
      allocated: false,
      artifacts: [],
      details: [],
    }),
  );

  assert.deepEqual(result.group.sessions.flatMap((s) => s.runs.map((r) => r.cluster)), [undefined, undefined]);
});

test("cbdinoclusterSetupFailed flags a missing cycle cluster after the cluster phase ran", () => {
  assert.equal(cbdinoclusterSetupFailed(functionalCycle(), true), true);

  const resolved = functionalCycle();
  resolved.sessions = resolved.sessions.map((session) => ({
    ...session,
    runs: session.runs.map((iteration) => ({ ...iteration, cluster: cluster() })),
  }));
  assert.equal(cbdinoclusterSetupFailed(resolved, true), false);
  assert.equal(cbdinoclusterSetupFailed(functionalCycle(), false), false);
});

test("finalizeRunFromDefinition writes AGENTS.md and includes it in artifacts", () => {
  const runDir = mkdtempSync(join(tmpdir(), "fit-cli-run-from-definition-"));
  const result = finalizeRunFromDefinition([
    {
      filename: "instances/0/clusters/0/sessions/0/runs/0/driver.log",
      explanation: "FIT test-driver stdout/stderr captured for this run",
    },
  ], [], runDir);

  assert.deepEqual(result.artifacts.map((artifact) => artifact.filename), [
    "instances/0/clusters/0/sessions/0/runs/0/driver.log",
    "AGENTS.md",
  ]);
  const written = readFileSync(join(runDir, "AGENTS.md"), "utf8");
  assert.match(written, /instances\/0\/clusters\/0\/sessions\/0\/runs\/0\/driver\.log/);
});

test("runTests stops before later steps when the cluster REST sanity check fails", async () => {
  let generatedFitConfig = false;
  let checkedPerformer = false;
  let ranDriver = false;

  await assert.rejects(
    () =>
      runTests(fitExecutionContext(), "connection", iteration(), undefined, {
        runClusterDiagFn: () => Promise.resolve(false),
        generateFitConfigurationFn: () => {
          generatedFitConfig = true;
          return { path: "/tmp/fit.json", artifacts: [], details: [] };
        },
        runPerformerClusterSanityCheckFn: () => {
          checkedPerformer = true;
          return Promise.resolve({ ok: true, artifacts: [], details: [] });
        },
        runTestDriverFn: () => {
          ranDriver = true;
          return Promise.resolve({ ok: true, logFile: "/tmp/driver.log", artifacts: [], details: [] });
        },
      }),
    { message: "Cluster sanity test failed; this execution group cannot continue." },
  );

  assert.equal(generatedFitConfig, false);
  assert.equal(checkedPerformer, false);
  assert.equal(ranDriver, false);
});


test("runTests throws FatalToSession when the test driver reports failure", async () => {
  await assert.rejects(
    () =>
      runTests(fitExecutionContext(), "connection", iteration(), undefined, {
        runClusterDiagFn: () => Promise.resolve(true),
        generateFitConfigurationFn: () => ({ path: "/tmp/fit.json", artifacts: [], details: [] }),
        runPerformerClusterSanityCheckFn: () => Promise.resolve({ ok: true, artifacts: [], details: [] }),
        runTestDriverFn: () => Promise.resolve({ ok: false, logFile: "/tmp/driver.log", artifacts: [], details: [] }),
      }),
    { message: "FIT tests failed — check the test-driver log for details." },
  );
});

test("runTests throws FatalToSession when performer sanity fails", async () => {
  await assert.rejects(
    () =>
      runTests(fitExecutionContext(), "connection", iteration(), undefined, {
        runClusterDiagFn: () => Promise.resolve(true),
        generateFitConfigurationFn: () => ({ path: "/tmp/fit.json", artifacts: [], details: [] }),
        runPerformerClusterSanityCheckFn: () => Promise.resolve({ ok: false, artifacts: [], details: [] }),
        runTestDriverFn: () => Promise.resolve({ ok: true, logFile: "/tmp/driver.log", artifacts: [], details: [] }),
      }),
    { message: "Performer cluster sanity check failed; stopping this iteration." },
  );
});


function groupWithKind(kind: "aws" | "localhost"): ResolvedExecutionGroup {
  return { instance: { kind } } as unknown as ResolvedExecutionGroup;
}

const DEFINITION_OVERRIDE: ExecutionOverride = { kind: "definition" };
const LOCALHOST_OVERRIDE: ExecutionOverride = { kind: "localhost" };
const AWS_OVERRIDE: ExecutionOverride = { kind: "aws" };
const EXISTING_OVERRIDE: ExecutionOverride = { kind: "existing", existing: { host: "h", user: "u", identityFile: "/tmp/id" } };

test("repoDirOverrideConflictsWithRemote is true when the definition puts an AWS group on it and the override honours the definition", () => {
  assert.equal(
    repoDirOverrideConflictsWithRemote(["transactions-fit-performer"], DEFINITION_OVERRIDE, [groupWithKind("aws")]),
    true,
  );
});

test("repoDirOverrideConflictsWithRemote is false with no active overrides, even against an AWS instance", () => {
  assert.equal(repoDirOverrideConflictsWithRemote([], DEFINITION_OVERRIDE, [groupWithKind("aws")]), false);
});

test("repoDirOverrideConflictsWithRemote is false when every group's declared instance is localhost", () => {
  assert.equal(
    repoDirOverrideConflictsWithRemote(["transactions-fit-performer"], DEFINITION_OVERRIDE, [groupWithKind("localhost")]),
    false,
  );
});

test("repoDirOverrideConflictsWithRemote is false when an interactive run overrides an AWS-declared group onto localhost", () => {
  assert.equal(
    repoDirOverrideConflictsWithRemote(["transactions-fit-performer"], LOCALHOST_OVERRIDE, [groupWithKind("aws")]),
    false,
  );
});

test("repoDirOverrideConflictsWithRemote is true when an interactive run forces a fresh EC2 instance, even if every group is declared localhost", () => {
  assert.equal(
    repoDirOverrideConflictsWithRemote(["transactions-fit-performer"], AWS_OVERRIDE, [groupWithKind("localhost")]),
    true,
  );
});

test("repoDirOverrideConflictsWithRemote is true when an interactive run forces an existing EC2 instance", () => {
  assert.equal(
    repoDirOverrideConflictsWithRemote(["transactions-fit-performer"], EXISTING_OVERRIDE, [groupWithKind("localhost")]),
    true,
  );
});

test("scopedPromptId leaves ids unscoped for single-preset runs", () => {
  // No scope: id must stay byte-for-byte identical so existing replay logs still match.
  assert.equal(scopedPromptId("run-from-definition.teardown.leave-up", undefined), "run-from-definition.teardown.leave-up");
});

test("scopedPromptId suffixes with the preset scope so grouped presets don't collide", () => {
  // A preset group reuses the same base id per preset; the scope keeps them distinct
  // (this is what stops the replay "used more than once" guard from firing).
  const a = scopedPromptId("run-from-definition.teardown.leave-up", "op-onprem-func-lite");
  const b = scopedPromptId("run-from-definition.teardown.leave-up", "op-cng-func-lite");
  assert.equal(a, "run-from-definition.teardown.leave-up.op-onprem-func-lite");
  assert.notEqual(a, b);
});

test("situationalCbdinoSettings uses environments.json5's capellaClusterVersion when no override is given", () => {
  const settings = situationalCbdinoSettings(false, false);
  assert.equal(settings.version, loadEnvironments().defaults.capellaClusterVersion);
});

test("situationalCbdinoSettings uses the override version for a non-CNG run", () => {
  const settings = situationalCbdinoSettings(false, false, "8.0-stable");
  assert.equal(settings.version, "8.0-stable");
});

test("situationalCbdinoSettings ignores a version override for a CNG run (CNG pins its own version)", () => {
  const withOverride = situationalCbdinoSettings(true, false, "8.0-stable");
  const withoutOverride = situationalCbdinoSettings(true, false);
  assert.equal(withOverride.version, withoutOverride.version);
});
