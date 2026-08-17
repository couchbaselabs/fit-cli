import assert from "node:assert/strict";
import { test } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { isPerformerStatus } from "../performer-grpc.js";

/** How Connect reports a status the performer actually sent. */
function fromWire(code: Code): ConnectError {
  const err = new ConnectError("", code, new Headers({ "grpc-status": String(code) }));
  err.isWireError = true;
  return err;
}

test("a status the performer sent is an answer, whatever its code", () => {
  assert.equal(isPerformerStatus(fromWire(Code.Unimplemented)), true);
  assert.equal(isPerformerStatus(fromWire(Code.Internal)), true);
  assert.equal(isPerformerStatus(fromWire(Code.Unavailable)), true);
});

test("a refused connection is not an answer", () => {
  assert.equal(isPerformerStatus(new ConnectError("connect ECONNREFUSED", Code.Unavailable, undefined, undefined, new Error("ECONNREFUSED"))), false);
});

test("an HTTP/2 stream reset is not an answer, even though Connect gives it a code and no cause", () => {
  // As built by connect-node's connectErrorFromH2ResetCode: a performer resetting mid-boot.
  assert.equal(isPerformerStatus(new ConnectError("http/2 stream closed with error code INTERNAL_ERROR (0x2)", Code.Internal)), false);
  assert.equal(isPerformerStatus(new ConnectError("http/2 stream closed with error code CANCEL (0x8)", Code.Canceled)), false);
});

test("a client-side deadline is not an answer", () => {
  assert.equal(isPerformerStatus(new ConnectError("the operation timed out", Code.DeadlineExceeded)), false);
});

test("a plain Error is not an answer", () => {
  assert.equal(isPerformerStatus(new Error("nope")), false);
});
