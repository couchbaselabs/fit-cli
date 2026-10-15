/**
 * Run `worker` over `items`, at most `limit` at a time, and return the results in the order of
 * `items`. If a worker throws, no more items are started, and the call rejects with the first
 * error once every worker already running has finished: a caller that cleans up on failure
 * (removes a directory the workers write to, say) never races a worker still running.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        failure ??= { error };
      }
    }
  });
  await Promise.all(runners);
  if (failure) throw failure.error;
  return results;
}
