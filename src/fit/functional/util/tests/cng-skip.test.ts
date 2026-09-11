import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sdkByValue, type Sdk } from "../../../../util/sdk/sdks.js";
import type { ResolvedExecutionGroup } from "../../../shared/definition/resolve-definition.js";
import { shouldSkipCngGroup, shouldSkipCngRun } from "../cng-skip.js";

const java = sdkByValue("java")!;
const rust = sdkByValue("rust")!;

// Only the fields cng-skip reads.
function functionalGroup(cng: boolean, sdks: Sdk[]): ResolvedExecutionGroup {
  return {
    type: "functional",
    cng,
    sessions: sdks.map((sdk) => ({ sdk, runs: [{ type: "functional", sdk }] })),
  } as unknown as ResolvedExecutionGroup;
}

function situationalGroup(runs: { sdk: Sdk; cng: boolean }[]): ResolvedExecutionGroup {
  return {
    type: "situational",
    cng: runs.some((run) => run.cng),
    runs: runs.map((run) => ({ type: "situational", ...run })),
  } as unknown as ResolvedExecutionGroup;
}

function runsOf(group: ResolvedExecutionGroup) {
  return group.type === "functional" ? group.sessions.flatMap((session) => session.runs) : group.runs;
}

describe("shouldSkipCngGroup", () => {
  test("skips a CNG group whose SDKs all lack support", () => {
    assert.equal(shouldSkipCngGroup(functionalGroup(true, [rust])), true);
  });

  test("treats an SDK without the cng field as unsupported", () => {
    assert.equal(shouldSkipCngGroup(functionalGroup(true, [sdkByValue("analytics-java")!])), true);
  });

  test("keeps a CNG group for a supported SDK", () => {
    assert.equal(shouldSkipCngGroup(functionalGroup(true, [java])), false);
  });

  test("keeps a non-CNG group", () => {
    assert.equal(shouldSkipCngGroup(functionalGroup(false, [rust])), false);
  });

  test("keeps a group where some SDKs support CNG", () => {
    assert.equal(shouldSkipCngGroup(functionalGroup(true, [rust, java])), false);
  });

  test("keeps a situational group with non-CNG runs left", () => {
    assert.equal(shouldSkipCngGroup(situationalGroup([{ sdk: rust, cng: true }, { sdk: rust, cng: false }])), false);
  });
});

describe("shouldSkipCngRun", () => {
  test("skips only the unsupported SDK's CNG runs", () => {
    const group = functionalGroup(true, [rust, java]);
    assert.deepEqual(
      runsOf(group).map((run) => shouldSkipCngRun(group, run)),
      [true, false],
    );
  });

  test("situational runs are judged individually", () => {
    const group = situationalGroup([{ sdk: rust, cng: true }, { sdk: rust, cng: false }]);
    assert.deepEqual(
      runsOf(group).map((run) => shouldSkipCngRun(group, run)),
      [true, false],
    );
  });
});
