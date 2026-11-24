/**
 * `performerCapsFetch` on `protocol.PerformerService`: ask a performer what it supports.
 *
 * Made with the shared performer gRPC client (see performers/util/performer-grpc.ts), and decoded
 * with the types generated from the FIT protos. This module's job is just to flatten the response
 * into the shape `fit caps` and `fit performer metadata` work with.
 */
import { Code } from "@connectrpc/connect";
import type { PerformerCapsFetchResponse } from "../../performance/generated/performer.caps_pb.js";
import { connectPerformer, isPerformerStatus } from "../../performers/util/performer-grpc.js";

/** How long to wait for a performer to answer before giving up on it. */
export const CAPS_FETCH_TIMEOUT_MS = 30_000;

/**
 * A decoded PerformerCapsFetchResponse.
 *
 * Caps are raw enum numbers — the three enums are independent and all start at 0, so
 * they must be kept apart and only ever resolved to names against their own group.
 */
export interface PerformerCaps {
  /** `transactions.Caps` — field 1. */
  transactionCaps: number[];
  /** `sdk.Caps` — field 8. */
  sdkCaps: number[];
  /** `performer.Caps` — field 7. */
  performerCaps: number[];
  /** `shared.API` — field 6. Empty means the performer supports only API.DEFAULT. */
  supportedApis: number[];
  /** e.g. "java-sdk" */
  userAgent?: string;
  /** The SDK/library version under test, e.g. "3.5.0". */
  libraryVersion?: string;
  /** Only set for transactions-capable performers, e.g. "2.0". */
  transactionsProtocolVersion?: string;
}

/**
 * Flatten a PerformerCapsFetchResponse.
 *
 * Enums stay plain numbers, including ones the generated types don't name: a cap a performer
 * reports that this fit-cli doesn't know about must still show up, flagged, in the caps table.
 */
export function toPerformerCaps(response: PerformerCapsFetchResponse): PerformerCaps {
  return {
    transactionCaps: [...response.transactionImplementationsCaps],
    sdkCaps: [...response.sdkImplementationCaps],
    performerCaps: [...response.performerCaps],
    supportedApis: [...response.supportedApis],
    // proto3 strings are "" when unset; keep reporting that as absent.
    ...(response.performerUserAgent ? { userAgent: response.performerUserAgent } : {}),
    ...(response.libraryVersion ? { libraryVersion: response.libraryVersion } : {}),
    ...(response.transactionsProtocolVersion ? { transactionsProtocolVersion: response.transactionsProtocolVersion } : {}),
  };
}

/**
 * True if the performer simply hasn't implemented performerCapsFetch. That's a meaningful
 * answer ("this SDK is too old"), not a fit-cli failure.
 */
export function isUnimplemented(err: unknown): boolean {
  return isPerformerStatus(err) && err.code === Code.Unimplemented;
}

/**
 * Call performerCapsFetch against a performer listening on `host:port`.
 *
 * Rejects with a Connect `ConnectError`: see {@link isPerformerStatus} and {@link isUnimplemented}
 * to tell a performer that answered from one that can't be reached.
 */
export async function fetchPerformerCaps(host: string, port: number, timeoutMs: number = CAPS_FETCH_TIMEOUT_MS): Promise<PerformerCaps> {
  const connection = connectPerformer(host, port);
  try {
    return toPerformerCaps(await connection.client.performerCapsFetch({}, { timeoutMs }));
  } finally {
    connection.close();
  }
}
