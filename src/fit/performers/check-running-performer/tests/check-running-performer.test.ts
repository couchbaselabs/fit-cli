import assert from "node:assert/strict";
import test from "node:test";
import type { FitExecutionContext } from "../../../shared/util/remote-fit-run.js";
import {
  applyPolicyToRunningContainers,
  applyPortInUsePolicy,
  handlePortInUse,
  killProcessArgs,
  lsofPortArgs,
  parseDockerPs,
  parseLsofPids,
  runningPerformerPsArgs,
  stopPerformerContainerArgs,
  waitForPortFree,
  type DockerContainerSummary,
  type PortInUseDeps,
} from "../check-running-performer.js";
import { sdkByValue } from "../../../../util/sdk/sdks.js";

function fakeExecutionContext(): FitExecutionContext {
  return {
    kind: "local",
    description: "test",
    target: {} as never,
    rootDir: "/work/root",
    fitPerformerDir: "/work/root/transactions-fit-performer",
    dockerCommand: "docker",
    artifacts: [],
    details: [],
    ensureWorkspace: () => Promise.resolve(true),
    run: () => Promise.resolve(),
    runHiddenUntilFailure: () => Promise.resolve(),
    capture: () => Promise.resolve(""),
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
    performerRunArgs: (imageName) => ["run", imageName],
  };
}

test("runningPerformerPsArgs filters docker ps by the requested performer image", () => {
  assert.deepEqual(runningPerformerPsArgs("performer-node-main"), [
    "ps",
    "--filter",
    "ancestor=performer-node-main",
    "--format",
    "{{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Ports}}",
  ]);
});

test("parseDockerPs extracts container summaries from docker ps output", () => {
  assert.deepEqual(
    parseDockerPs(
      [
        "abc123\tperformer-node-main\tfit-node\t0.0.0.0:8060->8060/tcp",
        "def456\tperformer-java-main\tfit-java\t",
      ].join("\n"),
    ),
    [
      {
        id: "abc123",
        image: "performer-node-main",
        name: "fit-node",
        ports: "0.0.0.0:8060->8060/tcp",
      },
      {
        id: "def456",
        image: "performer-java-main",
        name: "fit-java",
        ports: "",
      },
    ],
  );
});

test("stopPerformerContainerArgs stops all provided container ids", () => {
  assert.deepEqual(stopPerformerContainerArgs(["abc123", "def456"]), ["stop", "abc123", "def456"]);
});

test("lsofPortArgs lists the listening PIDs on a TCP port", () => {
  assert.deepEqual(lsofPortArgs(8060), ["-t", "-i", "tcp:8060", "-sTCP:LISTEN"]);
});

test("parseLsofPids extracts unique positive PIDs from lsof output", () => {
  assert.deepEqual(parseLsofPids("123\n456\n123\n\n  789  \n"), [123, 456, 789]);
});

test("parseLsofPids ignores non-numeric lines", () => {
  assert.deepEqual(parseLsofPids("not-a-pid\n0\n-5\n42\n"), [42]);
});

test("killProcessArgs renders PIDs as kill arguments", () => {
  assert.deepEqual(killProcessArgs([123, 456]), ["123", "456"]);
});

test("waitForPortFree resolves true once the port frees up", async () => {
  const availability = [{ available: false }, { available: false }, { available: true }];
  let sleeps = 0;
  const freed = await waitForPortFree(fakeExecutionContext(), 8060, {
    maxAttempts: 5,
    checkAvailability: () => Promise.resolve(availability.shift() ?? { available: true }),
    sleep: () => {
      sleeps++;
      return Promise.resolve();
    },
  });
  assert.equal(freed, true);
  assert.equal(sleeps, 2);
});

test("waitForPortFree resolves false when the port stays in use", async () => {
  const freed = await waitForPortFree(fakeExecutionContext(), 8060, {
    maxAttempts: 3,
    checkAvailability: () => Promise.resolve({ available: false }),
    sleep: () => Promise.resolve(),
  });
  assert.equal(freed, false);
});

function portInUseDeps(overrides: Partial<PortInUseDeps>): PortInUseDeps {
  return {
    confirm: () => Promise.resolve(false),
    stopProcessesOnPort: () => Promise.resolve(true),
    waitForPortFree: () => Promise.resolve(true),
    ...overrides,
  };
}

test("handlePortInUse tests against an external performer when the user agrees", async () => {
  const result = await handlePortInUse(fakeExecutionContext(), 8060, portInUseDeps({ confirm: () => Promise.resolve(true) }));
  assert.deepEqual(result, { action: "external" });
});

test("handlePortInUse aborts when the user declines both options", async () => {
  const result = await handlePortInUse(fakeExecutionContext(), 8060, portInUseDeps({ confirm: () => Promise.resolve(false) }));
  assert.deepEqual(result, { action: "abort" });
});

test("handlePortInUse stops the process and starts once the port frees up", async () => {
  const answers = [false, true];
  let stopped = false;
  const result = await handlePortInUse(
    fakeExecutionContext(),
    8060,
    portInUseDeps({
      confirm: () => Promise.resolve(answers.shift() ?? false),
      stopProcessesOnPort: () => {
        stopped = true;
        return Promise.resolve(true);
      },
      waitForPortFree: () => Promise.resolve(true),
    }),
  );
  assert.equal(stopped, true);
  assert.deepEqual(result, { action: "start" });
});

test("handlePortInUse aborts when the port never frees up after stopping", async () => {
  const answers = [false, true];
  const result = await handlePortInUse(
    fakeExecutionContext(),
    8060,
    portInUseDeps({
      confirm: () => Promise.resolve(answers.shift() ?? false),
      waitForPortFree: () => Promise.resolve(false),
    }),
  );
  assert.deepEqual(result, { action: "abort" });
});

test("applyPortInUsePolicy fail aborts without touching the port", async () => {
  let stopped = false;
  const result = await applyPortInUsePolicy(
    fakeExecutionContext(),
    8060,
    "fail",
    portInUseDeps({ stopProcessesOnPort: () => { stopped = true; return Promise.resolve(true); } }),
  );
  assert.deepEqual(result, { action: "abort" });
  assert.equal(stopped, false);
});

test("applyPortInUsePolicy reuse tests against the external performer", async () => {
  const result = await applyPortInUsePolicy(fakeExecutionContext(), 8060, "reuse", portInUseDeps({}));
  assert.deepEqual(result, { action: "external" });
});

test("applyPortInUsePolicy restart stops the process and starts once free", async () => {
  let stopped = false;
  const result = await applyPortInUsePolicy(
    fakeExecutionContext(),
    8060,
    "restart",
    portInUseDeps({
      stopProcessesOnPort: () => { stopped = true; return Promise.resolve(true); },
      waitForPortFree: () => Promise.resolve(true),
    }),
  );
  assert.equal(stopped, true);
  assert.deepEqual(result, { action: "start" });
});

test("applyPortInUsePolicy restart aborts when the port never frees up", async () => {
  const result = await applyPortInUsePolicy(
    fakeExecutionContext(),
    8060,
    "restart",
    portInUseDeps({ waitForPortFree: () => Promise.resolve(false) }),
  );
  assert.deepEqual(result, { action: "abort" });
});

test("applyPolicyToRunningContainers maps each policy to an action", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  const containers: DockerContainerSummary[] = [{ id: "abc123", image: "performer-java-main", name: "fit-java", ports: "" }];
  assert.deepEqual(applyPolicyToRunningContainers(sdk, containers, "fail"), { action: "abort" });
  assert.deepEqual(applyPolicyToRunningContainers(sdk, containers, "reuse"), { action: "reuse", containers });
  assert.deepEqual(applyPolicyToRunningContainers(sdk, containers, "restart"), { action: "restart", containers });
});
