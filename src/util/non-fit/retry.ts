/**
 * retryWhole — re-run an operation from the start after it fails. Two shapes of
 * caller use it:
 *
 * - Work that can't be resumed part-way, so recovery means doing it again: an S3
 *   upload whose read stream has already been consumed, say. The operation is
 *   handed its 1-based attempt number so a retry can be a *different* attempt
 *   (smaller batch, less concurrency) rather than a repeat of one that just failed.
 * - A thin retry around a single remote call that is simply repeated as-is until
 *   it stops failing transiently — see {@link exponentialDelays} for the backoff
 *   such callers usually want.
 *
 * Pure control flow (the only IO is sleeping between attempts), so it's unit
 * tested directly — see tests/retry.test.ts.
 */

/**
 * Build a doubling backoff schedule for {@link RetryWholeOptions.delaysMs}:
 * `baseMs`, then doubling, capped at `maxMs`, for a run of `attempts` total
 * attempts. Returns the *gaps between* attempts, so its length is
 * `attempts - 1` and `attempts: 1` means "no retries".
 *
 * Deliberately un-jittered: the schedules it produces are tuned per caller
 * against observed failure bursts, and jitter would make that tuning
 * unreproducible. Add jitter at a call site that wants it, not here.
 */
export function exponentialDelays({
  attempts,
  baseMs,
  maxMs,
}: {
  attempts: number;
  baseMs: number;
  maxMs: number;
}): number[] {
  return Array.from({ length: Math.max(0, attempts - 1) }, (_, i) => Math.min(baseMs * 2 ** i, maxMs));
}

/** When to retry, how long to wait, and what to say when one happens. */
export interface RetryWholeOptions {
  /**
   * Backoff before each retry. Its length sets how many retries follow the first
   * attempt, so `[10_000, 30_000]` means up to three attempts in total, and `[]`
   * means no retries at all.
   */
  delaysMs: readonly number[];
  /**
   * Overall budget from the first attempt onwards. A retry that couldn't start
   * within it is not attempted, so a long operation gets fewer tries than a short
   * one without the caller having to know how long it takes. Unbounded if unset.
   */
  totalBudgetMs?: number;
  /**
   * Whether a failure is worth another attempt at all — a misconfiguration
   * usually isn't. Defaults to retrying everything. Sees the thrown value as
   * thrown, deliberately: a predicate may want to treat "not even an Error" as a
   * bug in our own code rather than as something transient.
   */
  shouldRetry?: (err: unknown) => boolean;
  /**
   * Called after a failed attempt, before sleeping — `nextAttempt` is 1-based and
   * counts the first attempt, so the first retry reports attempt 2. A thrown value
   * that isn't an Error is wrapped in one, so reporters can rely on `.message`.
   */
  onRetry?: (err: Error, waitMs: number, nextAttempt: number) => void;
  /** Clock, injectable so the budget can be tested without waiting. */
  now?: () => number;
}

/**
 * Run `operation`, retrying the whole of it on failure per `delaysMs`. Returns its
 * result as soon as an attempt succeeds; if the attempts are exhausted, the budget
 * runs out, or `shouldRetry` rejects the failure, throws the error from the last
 * attempt — earlier failures are reported through `onRetry` rather than collected,
 * since a caller wants the most recent cause.
 */
export async function retryWhole<T>(
  operation: (attempt: number) => Promise<T>,
  opts: RetryWholeOptions,
): Promise<T> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const totalAttempts = opts.delaysMs.length + 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (err) {
      if (attempt >= totalAttempts) {
        throw err;
      }
      if (opts.shouldRetry && !opts.shouldRetry(err)) {
        throw err;
      }
      const waitMs = opts.delaysMs[attempt - 1] ?? 0;
      // Don't start an attempt the budget can't cover: better to report the failure
      // now than to sleep first and then report it anyway.
      if (opts.totalBudgetMs !== undefined && now() - startedAt + waitMs >= opts.totalBudgetMs) {
        throw err;
      }
      // Only the report gets a wrapped value; the original is what we rethrow, so a
      // caller's own error handling still sees exactly what was thrown.
      opts.onRetry?.(err instanceof Error ? err : new Error(String(err)), waitMs, attempt + 1);
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
