import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { PerformerCapsFetchResponseSchema } from "../../../performance/generated/performer.caps_pb.js";
import type { Caps } from "../../../performance/generated/sdk.caps_pb.js";
import { isUnimplemented, toPerformerCaps } from "../performer-caps-rpc.js";

/**
 * A real gRPC response body captured from ghcr.io/couchbase/java-fit-performer:main.
 *
 * The response is decoded with the generated types, so this fixture is what catches them
 * drifting from what performers actually send.
 */
const JAVA_CAPS_RESPONSE_BASE64 =
  "AAAAAGsKHQABAwUEBgcLCAoJDA0ODxASExQVERYXGBoZGxweEghqYXZhLXNkaxoDMi4wIgUzLjUuMDICAAE6CgABDgQCAwcIBglCJAgJGBkAChMSAQIDBAUGBwsMDw0OEBEUFRYXGxweHyAiIyQlJw==";

/** The protobuf message, without the 5-byte gRPC frame header the fixture was captured with. */
const javaMessage = Buffer.from(JAVA_CAPS_RESPONSE_BASE64, "base64").subarray(5);

const decode = (message: Uint8Array) => toPerformerCaps(fromBinary(PerformerCapsFetchResponseSchema, message));

describe("decoding a real java performer response", () => {
  const caps = decode(javaMessage);

  test("reads the identifying strings", () => {
    assert.equal(caps.userAgent, "java-sdk");
    assert.equal(caps.libraryVersion, "3.5.0");
    assert.equal(caps.transactionsProtocolVersion, "2.0");
  });

  test("keeps the three cap enums apart", () => {
    // All three enums number from 0, so a bug that merged them would be invisible in
    // any single list. Assert the exact contents of each.
    assert.deepEqual(
      caps.transactionCaps,
      [0, 1, 3, 5, 4, 6, 7, 11, 8, 10, 9, 12, 13, 14, 15, 16, 18, 19, 20, 21, 17, 22, 23, 24, 26, 25, 27, 28, 30],
    );
    assert.deepEqual(
      caps.sdkCaps,
      [
        8, 9, 24, 25, 0, 10, 19, 18, 1, 2, 3, 4, 5, 6, 7, 11, 12, 15, 13, 14, 16, 17, 20, 21, 22, 23, 27, 28, 30, 31,
        32, 34, 35, 36, 37, 39,
      ],
    );
    assert.deepEqual(caps.performerCaps, [0, 1, 14, 4, 2, 3, 7, 8, 6, 9]);
  });

  test("reads the supported APIs (DEFAULT and ASYNC)", () => {
    assert.deepEqual(caps.supportedApis, [0, 1]);
  });
});

describe("decoding degenerate responses", () => {
  test("an empty message yields empty cap lists and no strings", () => {
    const caps = toPerformerCaps(create(PerformerCapsFetchResponseSchema, {}));
    assert.deepEqual(caps.sdkCaps, []);
    assert.deepEqual(caps.transactionCaps, []);
    assert.deepEqual(caps.performerCaps, []);
    assert.equal(caps.userAgent, undefined);
    assert.equal(caps.libraryVersion, undefined);
    assert.equal(caps.transactionsProtocolVersion, undefined);
  });

  test("unknown fields from a newer performer are ignored, not fatal", () => {
    // Field 99, varint 7 — a field this fit-cli has never heard of.
    const caps = decode(Buffer.concat([javaMessage, Buffer.from([0x98, 0x06, 0x07])]));
    assert.equal(caps.userAgent, "java-sdk");
    assert.equal(caps.sdkCaps.length, 36);
  });

  test("a cap number the generated enum doesn't name is kept, not dropped", () => {
    const caps = toPerformerCaps(create(PerformerCapsFetchResponseSchema, { sdkImplementationCaps: [9999 as Caps] }));
    assert.deepEqual(caps.sdkCaps, [9999]);
  });
});

test("only UNIMPLEMENTED sent by the performer itself counts as unimplemented", () => {
  const fromWire = (code: Code): ConnectError => {
    const err = new ConnectError("", code, new Headers({ "grpc-status": String(code) }));
    err.isWireError = true;
    return err;
  };
  assert.equal(isUnimplemented(fromWire(Code.Unimplemented)), true);
  assert.equal(isUnimplemented(fromWire(Code.Internal)), false);
  assert.equal(isUnimplemented(new ConnectError("not from the performer", Code.Unimplemented)), false);
});
