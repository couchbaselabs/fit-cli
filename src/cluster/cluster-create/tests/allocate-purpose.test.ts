/**
 * Unit tests for the purpose string that marks a cluster as fit-cli's.
 *
 * Run on their own:
 *   node --import tsx --test src/cluster/cluster-create/tests/allocate-purpose.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FITCLI_PURPOSE_PREFIX, allocatePurpose, isFitCliPurpose } from "../allocate-purpose.js";

test("allocatePurpose combines the prefix, the run id and the user", () => {
  assert.equal(allocatePurpose("20260821-154758-ded4", "someone"), "fitcli-20260821-154758-ded4-someone");
});

test("allocatePurpose reduces a username to lowercase letters, digits and dashes", () => {
  assert.equal(allocatePurpose("20260821-154758-ded4", "First.Last"), "fitcli-20260821-154758-ded4-first-last");
  assert.equal(allocatePurpose("20260821-154758-ded4", "_odd_"), "fitcli-20260821-154758-ded4-odd");
});

test("allocatePurpose still carries the prefix when it has nothing else to say", () => {
  assert.ok(isFitCliPurpose(allocatePurpose("", "")));
});

test("isFitCliPurpose accepts our own purposes and nothing else", () => {
  assert.ok(isFitCliPurpose(allocatePurpose("20260821-154758-ded4", "someone")));
  assert.ok(isFitCliPurpose(FITCLI_PURPOSE_PREFIX));
  assert.equal(isFitCliPurpose(undefined), false);
  assert.equal(isFitCliPurpose(""), false);
  assert.equal(isFitCliPurpose("tf_acc_test_project_common"), false);
  // The old `fit-cli-<user>` shape is deliberately not ours: those clusters
  // predate the project-name stamping, so we can't prove we created them.
  assert.equal(isFitCliPurpose("fit-cli-someone"), false);
});
