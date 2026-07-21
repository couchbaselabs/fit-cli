import assert from "node:assert/strict";
import test from "node:test";
import type { CapsFile } from "../../../caps/util/caps-metadata.js";
import type { PerformerCaps } from "../../../caps/util/performer-caps-rpc.js";
import { formatImageLabels, formatPerformerCaps, resolveMetadataSdk } from "../metadata-performer.js";

test("resolveMetadataSdk resolves an SDK by value", () => {
  const result = resolveMetadataSdk("scala");
  assert.ok(!("error" in result));
  assert.equal(result.value, "scala");
});

test("resolveMetadataSdk resolves C++ by its image basename cxx", () => {
  const result = resolveMetadataSdk("cxx");
  assert.ok(!("error" in result));
  assert.equal(result.value, "cpp");
});

test("resolveMetadataSdk rejects an unknown SDK", () => {
  const result = resolveMetadataSdk("banana");
  assert.ok("error" in result);
  assert.match(result.error, /Unknown SDK/);
});

test("resolveMetadataSdk resolves Python, which now publishes a performer image", () => {
  const result = resolveMetadataSdk("python");
  assert.ok(!("error" in result));
  assert.equal(result.value, "python");
});

test("formatImageLabels renders only the labels fit-cli recognises, with their raw key", () => {
  const rendered = formatImageLabels({
    "org.opencontainers.image.revision": "abc123",
    "org.opencontainers.image.version": "1.2.3",
    "some.other.label": "ignored",
  });
  assert.match(rendered, /Revision\s+org\.opencontainers\.image\.revision\s+abc123/);
  assert.match(rendered, /Version\s+org\.opencontainers\.image\.version\s+1\.2\.3/);
  assert.ok(!rendered.includes("ignored"));
});

test("formatImageLabels reports when there are no labels at all", () => {
  assert.match(formatImageLabels(null), /no labels/);
});

test("formatImageLabels reports when no recognised label is present", () => {
  assert.match(formatImageLabels({ "some.other.label": "x" }), /no labels fit-cli recognises/);
});

const CAPS_FILE: CapsFile = {
  sdk: {
    SDK_PRESERVE_EXPIRY: { number: 0, description: "" },
    SDK_KV_RANGE_SCAN: { number: 1, description: "" },
  },
  transactions: {
    EXT_TRANSACTION_ID: { number: 0, description: "" },
  },
  performer: {
    GRPC_TESTING: { number: 0, description: "" },
  },
};

function caps(overrides: Partial<PerformerCaps>): PerformerCaps {
  return { sdkCaps: [], transactionCaps: [], performerCaps: [], supportedApis: [], ...overrides };
}

test("formatPerformerCaps names every reported cap, grouped correctly", () => {
  const rendered = formatPerformerCaps(
    CAPS_FILE,
    caps({ sdkCaps: [0, 1], transactionCaps: [0], performerCaps: [0], userAgent: "java-sdk", libraryVersion: "3.5.0" }),
  );
  assert.match(rendered, /User agent:\s+java-sdk/);
  assert.match(rendered, /Library version:\s+3\.5\.0/);
  assert.match(rendered, /SDK capabilities \(2\):/);
  assert.match(rendered, /SDK_PRESERVE_EXPIRY/);
  assert.match(rendered, /SDK_KV_RANGE_SCAN/);
  assert.match(rendered, /Transactions capabilities \(1\):/);
  assert.match(rendered, /EXT_TRANSACTION_ID/);
});

test("formatPerformerCaps surfaces a cap number caps.json5 doesn't know about", () => {
  const rendered = formatPerformerCaps(CAPS_FILE, caps({ sdkCaps: [7] }));
  assert.match(rendered, /#7 \(unknown/);
});

test("formatPerformerCaps says so when a group has nothing reported", () => {
  const rendered = formatPerformerCaps(CAPS_FILE, caps({}));
  assert.match(rendered, /SDK capabilities \(0\):\s*\n\s*\(none reported\)/);
});
