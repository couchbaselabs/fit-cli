/**
 * Unit tests for withCallTimeout. No IO and no mocks — just resolved/pending
 * promises — so the suite stays instant.
 *
 * Run on their own:
 *   bun test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TIMED_OUT, withCallTimeout } from "../with-call-timeout.js";

test("withCallTimeout passes the value through when the call answers in time", async () => {
  assert.equal(await withCallTimeout(Promise.resolve("value"), 30_000), "value");
});

test("withCallTimeout yields the sentinel when the call does not answer in time", async () => {
  assert.equal(await withCallTimeout(new Promise(() => {}), 20), TIMED_OUT);
});

test("withCallTimeout lets a rejection propagate rather than reporting a timeout", async () => {
  await assert.rejects(withCallTimeout(Promise.reject(new Error("real failure")), 30_000), /real failure/);
});

test("withCallTimeout does not leave a pending timer behind when the call wins", async () => {
  // A leaked timer keeps the event loop alive on its own, which stalled fit-cli
  // for up to two minutes at exit after a GCP run. Node exposes the count of
  // live handles, so assert it is unchanged rather than inferring from timing.
  const before = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length;
  await withCallTimeout(Promise.resolve("value"), 600_000);
  const after = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length;
  assert.equal(after, before, "withCallTimeout left a timer armed after resolving");
});
