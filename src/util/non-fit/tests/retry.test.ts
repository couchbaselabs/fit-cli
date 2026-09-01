/**
 * Unit tests for retryWhole. The operations under test are plain counters that
 * fail a set number of times — no mocks, no IO — and every delay is 0 so the
 * suite stays instant.
 *
 * Run on their own:
 *   bun test
 *   node --import tsx --test src/util/non-fit/tests/retry.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { exponentialDelays, retryWhole } from "../retry.js";

/** An operation that fails its first `failures` calls, then succeeds. Counts its calls. */
function failsThenSucceeds(failures: number): { op: () => Promise<string>; calls: () => number } {
  let calls = 0;
  return {
    op: () => {
      calls++;
      return calls <= failures
        ? Promise.reject(new Error(`attempt ${calls} failed`))
        : Promise.resolve("ok");
    },
    calls: () => calls,
  };
}

test("retryWhole: a first-attempt success runs the operation once and never retries", async () => {
  const { op, calls } = failsThenSucceeds(0);
  const retries: number[] = [];
  assert.equal(await retryWhole(op, { delaysMs: [0, 0], onRetry: (_e, _w, n) => retries.push(n) }), "ok");
  assert.equal(calls(), 1);
  assert.deepEqual(retries, []);
});

test("retryWhole: two failures then success — three attempts, result returned", async () => {
  const { op, calls } = failsThenSucceeds(2);
  assert.equal(await retryWhole(op, { delaysMs: [0, 0] }), "ok");
  assert.equal(calls(), 3);
});

test("retryWhole: re-invokes the operation per attempt, so per-attempt setup runs again", async () => {
  // The upload case: each attempt must open its own read stream, which only
  // happens if the operation body itself is re-entered rather than a value reused.
  const opened: number[] = [];
  let calls = 0;
  await retryWhole(
    () => {
      calls++;
      opened.push(calls);
      return calls < 3 ? Promise.reject(new Error("dropped")) : Promise.resolve();
    },
    { delaysMs: [0, 0] },
  );
  assert.deepEqual(opened, [1, 2, 3]);
});

test("retryWhole: onRetry reports the failure, its wait, and the 1-based next attempt", async () => {
  const { op } = failsThenSucceeds(2);
  const seen: { message: string; waitMs: number; nextAttempt: number }[] = [];
  await retryWhole(op, {
    delaysMs: [0, 0],
    onRetry: (err, waitMs, nextAttempt) => seen.push({ message: err.message, waitMs, nextAttempt }),
  });
  assert.deepEqual(seen, [
    { message: "attempt 1 failed", waitMs: 0, nextAttempt: 2 },
    { message: "attempt 2 failed", waitMs: 0, nextAttempt: 3 },
  ]);
});

test("retryWhole: exhausting every attempt throws the last error, not the first", async () => {
  const { op, calls } = failsThenSucceeds(Number.POSITIVE_INFINITY);
  await assert.rejects(retryWhole(op, { delaysMs: [0, 0] }), /attempt 3 failed/);
  assert.equal(calls(), 3);
});

test("retryWhole: an empty delay schedule means a single attempt", async () => {
  const { op, calls } = failsThenSucceeds(1);
  const retries: number[] = [];
  await assert.rejects(retryWhole(op, { delaysMs: [], onRetry: (_e, _w, n) => retries.push(n) }), /attempt 1 failed/);
  assert.equal(calls(), 1);
  assert.deepEqual(retries, []);
});

test("retryWhole: the delay schedule is followed in order", async () => {
  const { op } = failsThenSucceeds(3);
  const waits: number[] = [];
  await retryWhole(op, { delaysMs: [0, 1, 2], onRetry: (_e, waitMs) => waits.push(waitMs) });
  assert.deepEqual(waits, [0, 1, 2]);
});

test("retryWhole: the operation is told which attempt it is, so a retry can differ", async () => {
  // The upload case: attempt 1 runs four parts at a time, later attempts run one.
  const attempts: number[] = [];
  await retryWhole(
    (attempt) => {
      attempts.push(attempt);
      return attempt < 3 ? Promise.reject(new Error("dropped")) : Promise.resolve();
    },
    { delaysMs: [0, 0] },
  );
  assert.deepEqual(attempts, [1, 2, 3]);
});

test("retryWhole: shouldRetry rejecting a failure gives up immediately", async () => {
  const { op, calls } = failsThenSucceeds(1);
  const retries: number[] = [];
  await assert.rejects(
    retryWhole(op, { delaysMs: [0, 0], shouldRetry: () => false, onRetry: (_e, _w, n) => retries.push(n) }),
    /attempt 1 failed/,
  );
  assert.equal(calls(), 1);
  assert.deepEqual(retries, []);
});

test("retryWhole: shouldRetry sees the failure and can allow it", async () => {
  const { op, calls } = failsThenSucceeds(1);
  const seen: string[] = [];
  await retryWhole(op, {
    delaysMs: [0],
    shouldRetry: (err) => {
      seen.push(err instanceof Error ? err.message : String(err));
      return true;
    },
  });
  assert.equal(calls(), 2);
  assert.deepEqual(seen, ["attempt 1 failed"]);
});

test("retryWhole: a non-Error throw is wrapped for onRetry but rethrown as-is", async () => {
  let calls = 0;
  const reported: unknown[] = [];
  await assert.rejects(
    retryWhole(
      () => {
        calls++;
        // The point of the test: something that isn't an Error. eslint would rather
        // we didn't, which is precisely the case callers can't be trusted to avoid.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject("boom");
      },
      { delaysMs: [0], onRetry: (err) => reported.push(err) },
    ),
    // Rethrown unchanged — not wrapped, not stringified.
    (err: unknown) => err === "boom",
  );
  assert.equal(calls, 2);
  assert.ok(reported[0] instanceof Error);
  assert.equal(reported[0].message, "boom");
});

test("retryWhole: shouldRetry sees the thrown value as thrown, not wrapped", async () => {
  let calls = 0;
  const types: string[] = [];
  await assert.rejects(
    retryWhole(
      () => {
        calls++;
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject("boom");
      },
      {
        delaysMs: [0],
        shouldRetry: (err) => {
          types.push(typeof err);
          return false;
        },
      },
    ),
    (err: unknown) => err === "boom",
  );
  assert.equal(calls, 1);
  assert.deepEqual(types, ["string"]);
});

test("retryWhole: a budget that the next attempt's wait would exceed stops the retries", async () => {
  // Clock advances 40s per reading, so the 30s wait before attempt 2 doesn't fit
  // in a 60s budget: report the failure rather than sleeping and failing anyway.
  let clock = 0;
  const { op, calls } = failsThenSucceeds(1);
  await assert.rejects(
    retryWhole(op, {
      delaysMs: [30_000],
      totalBudgetMs: 60_000,
      now: () => {
        const value = clock;
        clock += 40_000;
        return value;
      },
    }),
    /attempt 1 failed/,
  );
  assert.equal(calls(), 1);
});

test("retryWhole: a budget with room to spare still retries", async () => {
  let clock = 0;
  const { op, calls } = failsThenSucceeds(1);
  await retryWhole(op, {
    delaysMs: [0],
    totalBudgetMs: 60_000,
    now: () => {
      const value = clock;
      clock += 1_000;
      return value;
    },
  });
  assert.equal(calls(), 2);
});

test("exponentialDelays: doubles from baseMs and plateaus at maxMs", () => {
  assert.deepEqual(exponentialDelays({ attempts: 10, baseMs: 250, maxMs: 15_000 }), [
    250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000,
  ]);
});

test("exponentialDelays: returns the gaps between attempts, so length is attempts - 1", () => {
  for (const attempts of [2, 3, 6, 10]) {
    assert.equal(exponentialDelays({ attempts, baseMs: 250, maxMs: 15_000 }).length, attempts - 1);
  }
});

test("exponentialDelays: a single attempt means no retries", () => {
  assert.deepEqual(exponentialDelays({ attempts: 1, baseMs: 250, maxMs: 15_000 }), []);
  assert.deepEqual(exponentialDelays({ attempts: 0, baseMs: 250, maxMs: 15_000 }), []);
});

test("exponentialDelays: a maxMs below baseMs caps every delay", () => {
  assert.deepEqual(exponentialDelays({ attempts: 4, baseMs: 5_000, maxMs: 1_000 }), [1_000, 1_000, 1_000]);
});

test("exponentialDelays: the schedule it builds drives retryWhole the expected number of times", async () => {
  // Ties the helper to its consumer: 10 attempts must mean 9 retries, matching withSsmRetry.
  const { op, calls } = failsThenSucceeds(Number.MAX_SAFE_INTEGER);
  const retries: number[] = [];
  await assert.rejects(() =>
    retryWhole(op, {
      delaysMs: exponentialDelays({ attempts: 10, baseMs: 0, maxMs: 0 }),
      onRetry: (_err, _waitMs, nextAttempt) => retries.push(nextAttempt),
    }),
  );
  assert.equal(calls(), 10);
  assert.deepEqual(retries, [2, 3, 4, 5, 6, 7, 8, 9, 10]);
});
