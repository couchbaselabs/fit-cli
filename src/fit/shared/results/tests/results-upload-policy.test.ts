/**
 * Unit tests for the shared results upload rule.
 *
 * Run on their own:
 *   bun test src/fit/shared/results/tests/results-upload-policy.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resultsUploadSkipReason } from "../results-upload-policy.js";

test("--results-upload uploads", () => {
  assert.equal(resultsUploadSkipReason(true), undefined);
});

test("without --results-upload the files are kept, and the reason names the flag", () => {
  assert.match(resultsUploadSkipReason(false) ?? "", /--results-upload was not given/);
});
