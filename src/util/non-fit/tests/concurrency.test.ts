/**
 * Unit tests for mapWithConcurrency.
 *
 * Run on their own:
 *   node --import tsx --test src/util/non-fit/tests/concurrency.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mapWithConcurrency } from "../concurrency.js";

test("results keep the order of the items, and no more than `limit` workers run at once", async () => {
  // Each worker waits until the test releases it, so how many are running is decided here,
  // not by timing.
  const release: (() => void)[] = [];
  let running = 0;
  let most = 0;
  const done = mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n, i) => {
    running++;
    most = Math.max(most, running);
    await new Promise<void>((resolve) => release.push(resolve));
    running--;
    return `${i}:${n * 10}`;
  });
  // Release workers one at a time, last-started first, until all five have run.
  for (let released = 0; released < 5; released++) {
    while (release.length === 0) await Promise.resolve();
    assert.ok(running <= 2);
    release.pop()!();
  }
  assert.deepEqual(await done, ["0:10", "1:20", "2:30", "3:40", "4:50"]);
  assert.equal(most, 2);
});

test("an empty list makes no workers", async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, () => Promise.reject(new Error("not called"))), []);
});

test("after a failure, no more items start, and the call rejects only once running workers finish", async () => {
  const started: number[] = [];
  let releaseSlow!: () => void;
  let slowFinished = false;
  const done = mapWithConcurrency([0, 1, 2, 3, 4], 2, async (n) => {
    started.push(n);
    if (n === 0) {
      await new Promise<void>((resolve) => (releaseSlow = resolve));
      slowFinished = true;
      return n;
    }
    throw new Error(`item ${n} failed`);
  });
  let settled = false;
  done.catch(() => {}).finally(() => (settled = true));
  // Item 1 has failed; item 0 is still running, so the call must not have settled yet.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(settled, false);
  releaseSlow();
  await assert.rejects(done, /item 1 failed/);
  assert.equal(slowFinished, true);
  assert.deepEqual(started, [0, 1]);
});
