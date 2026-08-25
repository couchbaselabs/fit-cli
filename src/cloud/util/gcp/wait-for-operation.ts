/**
 * wait-for-operation — block until a GCP zone operation (insert/delete, etc.)
 * reaches DONE. ZoneOperationsClient.wait is a server-side long-poll capped at
 * a couple of minutes per call, so this loops until the operation is actually
 * done rather than assuming one call suffices. Shared by create-instance.ts
 * and terminate-instance.ts.
 */
import type { ZoneOperationsClient } from "@google-cloud/compute";
import { TIMED_OUT, withCallTimeout } from "./with-call-timeout.js";

const OPERATION_TIMEOUT_MS = 600_000;
const CALL_TIMEOUT_MS = 180_000;
const RETRY_DELAY_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForZoneOperation(
  client: ZoneOperationsClient,
  project: string,
  zone: string,
  operationName: string | undefined,
): Promise<void> {
  if (!operationName) {
    throw new Error("GCP operation had no name to wait on — cannot confirm it completed.");
  }
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  let lastStatus: string | undefined;
  for (;;) {
    // wait() is meant to be a server-side long-poll capped at a couple of
    // minutes, but a stalled client-side call (network blip, stuck token
    // refresh) isn't bound by that server-side cap — race it against our own
    // timeout so the deadline below always gets checked.
    const result = await withCallTimeout(client.wait({ project, zone, operation: operationName }), CALL_TIMEOUT_MS);
    if (result !== TIMED_OUT) {
      const [op] = result;
      // compute v1 is a REST API (unlike this library's gRPC-transport clients), so
      // its JSON responses carry the enum's string name directly — `op.status` is
      // the literal string "DONE", not the numeric enum value the .d.ts's
      // `Status|keyof typeof Status` union also allows for.
      if (op.status === "DONE") {
        if (op.error?.errors?.length) {
          throw new Error(`GCP operation ${operationName} failed: ${JSON.stringify(op.error.errors)}`);
        }
        return;
      }
      lastStatus = op.status !== undefined ? String(op.status) : undefined;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for GCP operation ${operationName} (last status: ${lastStatus ?? "unknown"}).`);
    }
    // Pace the retry instead of hammering the API when wait() returns early with a non-DONE status.
    await sleep(RETRY_DELAY_MS);
  }
}
