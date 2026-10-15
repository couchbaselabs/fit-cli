/**
 * Unit tests for splitting s3:// URIs.
 *
 * Run on their own:
 *   node --import tsx --test src/cloud/util/aws/tests/s3-uri.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseS3Uri } from "../s3-uri.js";

test("an s3:// URI splits into bucket and key, the key empty for a whole bucket", () => {
  assert.deepEqual(parseS3Uri("s3://fit-cli/runs/20260928-001945-4510.zip"), { bucket: "fit-cli", key: "runs/20260928-001945-4510.zip" });
  assert.deepEqual(parseS3Uri("s3://fit-cli/health-dev/"), { bucket: "fit-cli", key: "health-dev/" });
  assert.deepEqual(parseS3Uri("s3://fit-cli/"), { bucket: "fit-cli", key: "" });
  assert.deepEqual(parseS3Uri("s3://fit-cli"), { bucket: "fit-cli", key: "" });
});

test("requireKey refuses a URI that names no object; anything not s3:// is refused", () => {
  assert.throws(() => parseS3Uri("s3://fit-cli/", { requireKey: true }), /must name an object/);
  assert.throws(() => parseS3Uri("s3://fit-cli", { requireKey: true }), /must name an object/);
  assert.equal(parseS3Uri("s3://fit-cli/a", { requireKey: true }).key, "a");
  assert.throws(() => parseS3Uri("https://example.com/x.zip"), /Invalid S3 URI/);
  assert.throws(() => parseS3Uri("s3:///key"), /Invalid S3 URI/);
});
