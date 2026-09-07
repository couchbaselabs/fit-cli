/**
 * with-call-timeout — bound a single GCP client-library call so a stalled
 * request (network blip, stuck token refresh) can't hang a polling loop
 * forever. The @google-cloud/compute client has no built-in per-call
 * deadline, so loops that only check their own deadline after an await
 * returns can hang indefinitely if that await never settles.
 *
 * Resolves to a sentinel on timeout rather than rejecting, so a genuine
 * error from the call itself still propagates immediately instead of being
 * mistaken for a timeout.
 */
const TIMED_OUT = Symbol("with-call-timeout: timed out");

export async function withCallTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  // The timer must be cleared on every exit path, including a rejection. A
  // pending timer keeps the event loop alive on its own, so leaving it armed
  // after the call has already answered means fit-cli sits there doing nothing
  // for up to `timeoutMs` before the process can exit — observed as a ~2 minute
  // pause after "✓ Terminated" at the end of a GCP run.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export { TIMED_OUT };
