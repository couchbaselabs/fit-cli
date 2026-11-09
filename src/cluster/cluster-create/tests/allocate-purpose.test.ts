/**
 * Unit tests for the unique stamp that identifies one fit-cli run.
 *
 * Run on their own:
 *   node --import tsx --test src/cluster/cluster-create/tests/allocate-purpose.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FITCLI_PURPOSE_PREFIX, allocatePurpose, isFitCliPurpose } from "../allocate-purpose.js";

/** A Kubernetes label value, where cao stores the purpose FIT builds from the stamp. */
const LABEL_VALUE = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;

/** The longest role FIT appends to the stamp. */
const LONGEST_FIT_SUFFIX = "-FIT-SIT-CNG";

test("allocatePurpose builds the prefix, a timestamp and 8 hex characters", () => {
  const stamp = allocatePurpose();
  assert.match(stamp, /^fitcli-\d{8}-\d{6}-[0-9a-f]{8}$/);
  assert.equal(stamp.length, 31);
});

test("allocatePurpose gives a fresh stamp on each call", () => {
  assert.notEqual(allocatePurpose(), allocatePurpose());
});

test("the stamp with FIT's longest suffix is still a valid Kubernetes label value", () => {
  const purpose = allocatePurpose() + LONGEST_FIT_SUFFIX;
  assert.ok(purpose.length <= 63, `${purpose} is ${purpose.length} characters`);
  assert.match(purpose, LABEL_VALUE);
});

test("isFitCliPurpose accepts our own purposes and nothing else", () => {
  assert.ok(isFitCliPurpose(allocatePurpose()));
  assert.ok(isFitCliPurpose(allocatePurpose() + LONGEST_FIT_SUFFIX));
  // Any value with the prefix is ours, whatever follows it.
  assert.ok(isFitCliPurpose("fitcli-20260821-154758-ded4-someone"));
  assert.ok(isFitCliPurpose(FITCLI_PURPOSE_PREFIX));
  assert.equal(isFitCliPurpose(undefined), false);
  assert.equal(isFitCliPurpose(""), false);
  assert.equal(isFitCliPurpose("tf_acc_test_project_common"), false);
  // The older `fit-cli-<user>` purpose is deliberately not ours. It carries no run
  // id, so it cannot identify a single run.
  assert.equal(isFitCliPurpose("fit-cli-someone"), false);
});
