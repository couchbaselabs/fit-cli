/**
 * Unit tests for gcpFitInstanceName. Pure string building — no IO, no mocks —
 * with the clock and the random tail injected so the suite stays instant and
 * deterministic.
 *
 * Run on their own:
 *   bun test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { gcpFitInstanceName } from "../fit-instance.js";

const AT = new Date("2026-06-12T10:37:04.000Z");

/** GCP requires RFC1035: leading lowercase letter, then lowercase alphanumerics/hyphens, <= 63 chars. */
const RFC1035 = /^[a-z][a-z0-9-]*$/;

test("gcpFitInstanceName includes creator, date, time to the second, and the suffix", () => {
  assert.equal(gcpFitInstanceName("grahamp", AT, "ab12"), "fit-cli-grahamp-20260612-103704-ab12");
});

test("gcpFitInstanceName distinguishes two runs in the same minute", () => {
  // The whole point: minute resolution alone collided, and on GCP the name is
  // the identity, so a collision is a hard failure rather than a duplicate tag.
  const a = gcpFitInstanceName("runner", new Date("2026-06-12T10:37:04.000Z"), "aaaa");
  const b = gcpFitInstanceName("runner", new Date("2026-06-12T10:37:52.000Z"), "aaaa");
  assert.notEqual(a, b);
});

test("gcpFitInstanceName distinguishes two runs in the same second via the random tail", () => {
  const a = gcpFitInstanceName("runner", AT, "aaaa");
  const b = gcpFitInstanceName("runner", AT, "bbbb");
  assert.notEqual(a, b);
});

test("gcpFitInstanceName generates a distinct name each call by default", () => {
  const names = new Set(Array.from({ length: 50 }, () => gcpFitInstanceName("runner", AT)));
  assert.ok(names.size > 1, "default suffix is not random");
});

test("gcpFitInstanceName folds an unfriendly creator into an RFC1035 label", () => {
  const name = gcpFitInstanceName("Graham.Pople@Couchbase.com", AT, "ab12");
  assert.match(name, RFC1035);
  assert.ok(!name.includes("."), name);
  assert.ok(!name.includes("@"), name);
});

test("gcpFitInstanceName stays a valid RFC1035 label within 63 chars for a long creator", () => {
  const name = gcpFitInstanceName("x".repeat(200), AT, "ab12");
  assert.match(name, RFC1035);
  assert.ok(name.length <= 63, `${name.length} chars: ${name}`);
});

test("gcpFitInstanceName falls back to a placeholder when the creator folds away entirely", () => {
  const name = gcpFitInstanceName("...", AT, "ab12");
  assert.equal(name, "fit-cli-user-20260612-103704-ab12");
  assert.match(name, RFC1035);
});
