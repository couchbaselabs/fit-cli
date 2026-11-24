import assert from "node:assert/strict";
import test from "node:test";
import { applyRepeatOverride, extractResultsUploadFlag, extractRepeatFlags } from "../run.js";

test("extractRepeatFlags pulls --repeat <n> out of argv", () => {
  const { repeat, stopOnFailure, positionals } = extractRepeatFlags(["definition.json5", "--repeat", "5"]);
  assert.equal(repeat, 5);
  assert.equal(stopOnFailure, false);
  assert.deepEqual(positionals, ["definition.json5"]);
});

test("extractRepeatFlags accepts --repeat=<n>", () => {
  const { repeat, positionals } = extractRepeatFlags(["--repeat=3", "definition.json5"]);
  assert.equal(repeat, 3);
  assert.deepEqual(positionals, ["definition.json5"]);
});

test("extractRepeatFlags pulls --stop-on-failure out of argv", () => {
  const { repeat, stopOnFailure, positionals } = extractRepeatFlags(["--stop-on-failure", "definition.json5"]);
  assert.equal(repeat, undefined);
  assert.equal(stopOnFailure, true);
  assert.deepEqual(positionals, ["definition.json5"]);
});

test("extractRepeatFlags combines --repeat and --stop-on-failure", () => {
  const { repeat, stopOnFailure } = extractRepeatFlags(["--repeat", "20", "--stop-on-failure"]);
  assert.equal(repeat, 20);
  assert.equal(stopOnFailure, true);
});

test("extractRepeatFlags rejects a non-positive-integer --repeat value", () => {
  const proc = process as unknown as { exit: (code?: number) => never };
  const originalExit = proc.exit;
  let exitCode: number | undefined;
  proc.exit = (code?: number): never => {
    exitCode = code;
    throw new Error("exit");
  };
  try {
    assert.throws(() => extractRepeatFlags(["--repeat", "0"]));
    assert.equal(exitCode, 2);
  } finally {
    proc.exit = originalExit;
  }
});

interface RawRun {
  runs: Record<string, unknown>[];
}
interface RawInstance {
  clusters?: { sessions: RawRun[] }[];
  clusterlessSessions?: RawRun[];
}
interface RawDefinition extends Record<string, unknown> {
  instances: RawInstance[];
}

function functionalDefinition(run: Record<string, unknown>): RawDefinition {
  return {
    instances: [
      {
        clusters: [
          {
            sessions: [{ runs: [run] }],
          },
        ],
      },
    ],
  };
}

test("applyRepeatOverride sets repeat on every run under sessions[].runs[]", () => {
  const raw = functionalDefinition({ type: "functional", tests: { presets: ["all"] } });
  applyRepeatOverride(raw, 5);
  const run = raw.instances[0].clusters![0].sessions[0].runs[0];
  assert.equal(run.repeat, 5);
});

test("applyRepeatOverride sets repeat on clusterlessSessions[].runs[] too", () => {
  const raw: RawDefinition = {
    instances: [
      {
        clusterlessSessions: [{ runs: [{ type: "situational", tests: {}, situational: {} }] }],
      },
    ],
  };
  applyRepeatOverride(raw, 7);
  const run = raw.instances[0].clusterlessSessions![0].runs[0];
  assert.equal(run.repeat, 7);
});

test("applyRepeatOverride errors on a run that already sets versions", () => {
  const raw = functionalDefinition({ type: "situational", tests: {}, situational: {}, versions: ["8.0"] });
  assert.throws(() => applyRepeatOverride(raw, 5), /already sets "versions"/);
});

test("extractResultsUploadFlag pulls --results-upload out of argv", () => {
  assert.deepEqual(extractResultsUploadFlag(["definition.json5", "--results-upload"]), { resultsUpload: true, positionals: ["definition.json5"] });
  assert.deepEqual(extractResultsUploadFlag(["definition.json5"]), { resultsUpload: false, positionals: ["definition.json5"] });
});
