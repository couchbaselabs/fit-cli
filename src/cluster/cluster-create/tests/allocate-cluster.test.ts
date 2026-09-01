import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allocateCluster, type ClusterCommandExecutor, writeClusterDef } from "../allocate-cluster.js";
import { allocatePurpose } from "../allocate-purpose.js";
import { ensureRunDir } from "../../../util/non-fit/replay.js";

test("writeClusterDef writes into the provided cluster directory", () => {
  const runDir = mkdtempSync(join(tmpdir(), "fit-cli-run-dir-"));
  const cycleDir = join(runDir, "instances", "0", "clusters", "0");
  const def = "services:\n  - kv\n";
  const result = writeClusterDef(def, cycleDir, runDir);

  assert.equal(result.path, `${cycleDir}/cbdinocluster.yaml`);
  assert.equal(result.artifact.filename, "instances/0/clusters/0/cbdinocluster.yaml");
  assert.equal(result.artifact.explanation, "cbdinocluster definition used to allocate the cluster");
  assert.equal(readFileSync(result.path, "utf8"), def);
});

/** Fake executor that records the args passed to `cbdinocluster allocate` and fakes a successful allocation. */
function fakeExecutor(): ClusterCommandExecutor & { capturedArgs: string[] } {
  const executor = {
    description: "fake",
    capturedArgs: [] as string[],
    run: () => Promise.resolve(),
    runHiddenUntilFailure: () => Promise.resolve(),
    capture: () => Promise.resolve(""),
    streamToTerminalAndFile: (_command: string, args: string[], targetPath: string) => {
      executor.capturedArgs = args;
      writeFileSync(targetPath, "df45d6d0-cfbe-4905-bc8c-989a09c03817\n");
      return Promise.resolve();
    },
    targetFilePath: (localPath: string) => localPath,
    stageFile: (localPath: string) => Promise.resolve(localPath),
    collectFile: (_targetPath: string, localPath: string) => Promise.resolve(localPath),
    commandAvailable: () => Promise.resolve(true),
  };
  return executor;
}

test("allocateCluster sets a short expiry for shared resources (Capella, CNG) and a long one otherwise", async () => {
  const cycleDir = join(ensureRunDir(), "instances", "0", "clusters", "0");

  const cloudExecutor = fakeExecutor();
  await allocateCluster("cbdinocluster", "def", "cloud", cloudExecutor, cycleDir);
  assert.ok(cloudExecutor.capturedArgs.includes("--expiry=3h"));

  const cngExecutor = fakeExecutor();
  await allocateCluster("cbdinocluster", "def", "cao", cngExecutor, cycleDir, true);
  assert.ok(cngExecutor.capturedArgs.includes("--expiry=3h"));

  const dockerExecutor = fakeExecutor();
  await allocateCluster("cbdinocluster", "def", "docker", dockerExecutor, cycleDir);
  assert.ok(dockerExecutor.capturedArgs.includes("--expiry=31h"));
});

test("allocateCluster always tags the allocate call with --purpose", async () => {
  const cycleDir = join(ensureRunDir(), "instances", "0", "clusters", "0");
  const executor = fakeExecutor();
  await allocateCluster("cbdinocluster", "def", "docker", executor, cycleDir);
  assert.ok(executor.capturedArgs.includes(`--purpose=${allocatePurpose()}`));
});
