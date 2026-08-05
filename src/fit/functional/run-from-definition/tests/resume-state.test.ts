import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRunState, runStatePath, writeRunState, type RunState } from "../resume-state.js";

function sampleState(): RunState {
  return {
    version: 1,
    executionGroupIndex: 0,
    startRunIndex: 0,
    target: { kind: "remote", instanceId: "i-123", owned: true },
    cluster: {
      cluster: {
        scheme: "couchbase",
        defaultHostname: "127.0.0.1",
        flavour: "self-managed",
        credentials: { username: "Administrator", password: "password" },
        tls: null,
      },
      allocated: true,
      clusterId: "cb-abc",
      cbdinoclusterCommand: "/home/ubuntu/fit-workspace/cbdinocluster",
    },
    performers: [{ globalRunIndex: 0, containerId: "deadbeef", port: 8060, sdk: "java" }],
  };
}

test("runStatePath puts the state under _internal inside the run dir", () => {
  assert.equal(
    runStatePath("/tmp/fit-cli/20260605-142043"),
    "/tmp/fit-cli/20260605-142043/_internal/run-state.json",
  );
});

test("writeRunState then readRunState round-trips the state", () => {
  const runDir = mkdtempSync(join(tmpdir(), "resume-state-"));
  const written = writeRunState(runDir, sampleState());
  assert.equal(written, runStatePath(runDir));
  assert.deepEqual(readRunState(runDir), sampleState());
});

test("round-trips the forceLocalhost flag", () => {
  const runDir = mkdtempSync(join(tmpdir(), "resume-state-"));
  const state: RunState = { ...sampleState(), forceLocalhost: true };
  writeRunState(runDir, state);
  assert.equal(readRunState(runDir)?.forceLocalhost, true);
});

test("readRunState returns undefined when there is no saved state", () => {
  const runDir = mkdtempSync(join(tmpdir(), "resume-state-"));
  assert.equal(readRunState(runDir), undefined);
});

test("readRunState rejects an unsupported version", () => {
  const runDir = mkdtempSync(join(tmpdir(), "resume-state-"));
  writeRunState(runDir, { ...sampleState(), version: 2 as unknown as 1 });
  assert.throws(() => readRunState(runDir), /Unsupported run-state version/);
});
