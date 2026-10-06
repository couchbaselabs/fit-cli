/**
 * Unit tests for the unique stamp that identifies one fit-cli run.
 *
 * Run on their own:
 *   node --import tsx --test src/cluster/cluster-create/tests/allocate-purpose.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FITCLI_PURPOSE_PREFIX, allocatePurpose, isFitCliPurpose } from "../allocate-purpose.js";

test("allocatePurpose combines the prefix and the run id", () => {
  assert.equal(allocatePurpose("20260821-154758-ded4"), "fitcli-20260821-154758-ded4");
});

test("allocatePurpose reduces a run id to lowercase letters, digits and dashes", () => {
  assert.equal(allocatePurpose("20260821_154758.DED4"), "fitcli-20260821-154758-ded4");
  assert.equal(allocatePurpose("_odd_"), "fitcli-odd");
});

test("allocatePurpose still carries the prefix when it has nothing else to say", () => {
  assert.equal(allocatePurpose(""), FITCLI_PURPOSE_PREFIX);
  assert.ok(isFitCliPurpose(allocatePurpose("")));
});

test("isFitCliPurpose accepts our own purposes and nothing else", () => {
  assert.ok(isFitCliPurpose(allocatePurpose("20260821-154758-ded4")));
  // Older stamps carried the username after the run id. Runs that are still alive
  // use them, so they must stay ours.
  assert.ok(isFitCliPurpose("fitcli-20260821-154758-ded4-someone"));
  assert.ok(isFitCliPurpose(FITCLI_PURPOSE_PREFIX));
  assert.equal(isFitCliPurpose(undefined), false);
  assert.equal(isFitCliPurpose(""), false);
  assert.equal(isFitCliPurpose("tf_acc_test_project_common"), false);
  // The older `fit-cli-<user>` purpose is deliberately not ours. It carries no run
  // id, so it cannot identify a single run.
  assert.equal(isFitCliPurpose("fit-cli-someone"), false);
});
