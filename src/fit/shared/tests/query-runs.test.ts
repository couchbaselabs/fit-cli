/**
 * Unit tests for the query-runs mini CLI's pure helpers.
 *
 * Run on their own:
 *   bun run test src/fit/shared/tests/query-runs.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RESULTS_ENV } from "../../util/config.js";
import { parseArgs, validateRunIds } from "../query-runs/query-runs.js";

test("parseArgs collects positional run ids and an --env flag (both forms)", () => {
  assert.deepEqual(parseArgs(["abc", "def"]), { ids: ["abc", "def"], env: DEFAULT_RESULTS_ENV });
  assert.deepEqual(parseArgs(["abc", "--env", "other"]), { ids: ["abc"], env: "other" });
  assert.deepEqual(parseArgs(["abc", "--env=other", "def"]), { ids: ["abc", "def"], env: "other" });
});

test("parseArgs rejects a dangling --env with no value", () => {
  assert.throws(() => parseArgs(["--env"]), /--env needs a value/);
});

test("validateRunIds accepts well-formed UUIDs", () => {
  assert.doesNotThrow(() => validateRunIds(["123e4567-e89b-12d3-a456-426614174000"]));
});

test("validateRunIds rejects non-UUID ids and requires at least one", () => {
  assert.throws(() => validateRunIds([]), /at least one run id/);
  assert.throws(() => validateRunIds(["not-a-uuid"]), /Not a valid run id/);
});
