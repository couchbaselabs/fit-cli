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
  return Promise.race([
    promise,
    new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), timeoutMs)),
  ]);
}

export { TIMED_OUT };
