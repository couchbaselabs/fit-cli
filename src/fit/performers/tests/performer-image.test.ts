import assert from "node:assert/strict";
import test from "node:test";
import { sdkByValue } from "../../../util/sdk/sdks.js";
import {
  analysePerformerImage,
  normalizePerformerVersion,
  performerImageName,
  performerPackageUrl,
  validatePerformerVersion,
} from "../util/performer-image.js";

test("performerPackageUrl points at the couchbase org-level GHCR package", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.equal(
    performerPackageUrl(sdk),
    "https://github.com/orgs/couchbase/packages/container/package/java-fit-performer",
  );
});

test("performerPackageUrl is the same form for non-JVM SDKs", () => {
  const sdk = sdkByValue("node");
  assert.ok(sdk);
  assert.equal(
    performerPackageUrl(sdk),
    "https://github.com/orgs/couchbase/packages/container/package/node-fit-performer",
  );
});

test("performerImageName builds a fully-qualified GHCR reference", () => {
  const sdk = sdkByValue("node");
  assert.ok(sdk);
  assert.equal(performerImageName(sdk, "4.2.0"), "ghcr.io/couchbase/node-fit-performer:4.2.0");
});

test("performerImageName builds a fully-qualified GHCR reference for JVM SDKs", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.equal(performerImageName(sdk, "4.2.0"), "ghcr.io/couchbase/java-fit-performer:4.2.0");
});

test("performerImageName defaults to main tag", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.equal(performerImageName(sdk), "ghcr.io/couchbase/java-fit-performer:main");
});

test("performerImageName defaults to main tag for non-JVM SDKs", () => {
  const sdk = sdkByValue("node");
  assert.ok(sdk);
  assert.equal(performerImageName(sdk), "ghcr.io/couchbase/node-fit-performer:main");
});

test("C++ performerImageName uses the cxx-fit-performer GHCR package", () => {
  const sdk = sdkByValue("cpp");
  assert.ok(sdk);
  assert.equal(performerImageName(sdk), "ghcr.io/couchbase/cxx-fit-performer:main");
});

test(".NET performerImageName uses the dotnet-fit-performer GHCR package", () => {
  const sdk = sdkByValue("dotnet");
  assert.ok(sdk);
  assert.equal(performerImageName(sdk), "ghcr.io/couchbase/dotnet-fit-performer:main");
});

test("analysePerformerImage maps cxx-fit-performer back to the C++ SDK", () => {
  const result = analysePerformerImage("ghcr.io/couchbase/cxx-fit-performer:main");
  assert.ok(!("error" in result));
  assert.equal(result.sdk.value, "cpp");
  assert.equal(result.tag, "main");
});

test("analysePerformerImage accepts the dotnet performer image", () => {
  const result = analysePerformerImage("dotnet-fit-performer:main");
  assert.ok(!("error" in result));
  assert.equal(result.sdk.value, "dotnet");
});

test("normalizePerformerVersion collapses blank and main to the default tag", () => {
  assert.equal(normalizePerformerVersion(""), undefined);
  assert.equal(normalizePerformerVersion(" main "), undefined);
  assert.equal(normalizePerformerVersion("4.2.0"), "4.2.0");
});

test("normalizePerformerVersion collapses main to undefined for JVM SDKs", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.equal(normalizePerformerVersion("main", sdk), undefined);
  assert.equal(normalizePerformerVersion("4.2.0", sdk), "4.2.0");
});

test("validatePerformerVersion rejects full image references", () => {
  assert.equal(validatePerformerVersion("ghcr.io/couchbase/node-fit-performer:main"), "Enter only the image tag, not a full image reference.");
  assert.equal(validatePerformerVersion("4.2.0"), true);
});

test("analysePerformerImage parses the hyphenated columnar-java SDK basename", () => {
  const parsed = analysePerformerImage("columnar-java-fit-performer:main");
  assert.ok(!("error" in parsed));
  if ("error" in parsed) return;
  assert.equal(parsed.sdk.value, "columnar-java");
  assert.equal(parsed.tag, "main");
});

test("performerImageName builds a GHCR reference for columnar-java", () => {
  const sdk = sdkByValue("columnar-java");
  assert.ok(sdk);
  assert.equal(performerImageName(sdk, "main"), "ghcr.io/couchbase/columnar-java-fit-performer:main");
});

for (const value of ["go", "node", "python", "ruby", "rust"] as const) {
  test(`${value} performerImageName uses the ${value}-fit-performer GHCR package`, () => {
    const sdk = sdkByValue(value);
    assert.ok(sdk);
    assert.equal(performerImageName(sdk), `ghcr.io/couchbase/${value}-fit-performer:main`);
  });

  test(`analysePerformerImage accepts the ${value} performer image`, () => {
    const result = analysePerformerImage(`${value}-fit-performer:main`);
    assert.ok(!("error" in result));
    if ("error" in result) return;
    assert.equal(result.sdk.value, value);
  });
}

test("analysePerformerImage rejects an image for an SDK FIT doesn't know", () => {
  const result = analysePerformerImage("php-fit-performer:main");
  assert.ok("error" in result);
  if (!("error" in result)) return;
  assert.match(result.error, /Unknown SDK "php"/);
});
