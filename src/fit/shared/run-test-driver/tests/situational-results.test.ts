import test from "node:test";
import assert from "node:assert/strict";
import { parseSituationalResultsCsv, renderSituationalResultsMarkdown, renderSituationalResultsPlainText } from "../situational-results.js";

const CSV = `2026-06-15T11:49:04.123+01:00,Scale up from 1 to 4,Passed,https://performance-sdk.couchbase.com/results/situational/a/run/1
2026-06-15T12:10:22.456+01:00,Scale up from 2 to 4 nodes,Failed,https://performance-sdk.couchbase.com/results/situational/a/run/2
`;

test("parseSituationalResultsCsv: parses rows and skips blank lines", () => {
  const rows = parseSituationalResultsCsv(CSV);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    timestamp: "2026-06-15T11:49:04.123+01:00",
    testCase: "Scale up from 1 to 4",
    status: "Passed",
    url: "https://performance-sdk.couchbase.com/results/situational/a/run/1",
  });
  assert.equal(rows[1].status, "Failed");
});

test("parseSituationalResultsCsv: empty input yields no rows", () => {
  assert.deepEqual(parseSituationalResultsCsv(""), []);
  assert.deepEqual(parseSituationalResultsCsv("\n\n"), []);
});

test("renderSituationalResultsMarkdown: emits heading, table, and a results link per row", () => {
  const rows = parseSituationalResultsCsv(CSV);
  const md = renderSituationalResultsMarkdown(rows);
  assert.ok(md.includes("### 📊 Situational Test Results"));
  assert.ok(md.includes("| Timestamp | Test Case | Status | Detailed Report |"));
  // Fractional seconds and offset are stripped, "T" becomes a space.
  assert.ok(md.includes("2026-06-15 11:49:04"));
  assert.ok(md.includes("✅ Passed"));
  assert.ok(md.includes("❌ Failed"));
  assert.ok(md.includes("[View Detailed Results](https://performance-sdk.couchbase.com/results/situational/a/run/1)"));
});

test("renderSituationalResultsMarkdown: unknown status falls back to a warning emoji", () => {
  const md = renderSituationalResultsMarkdown([{ timestamp: "2026-01-01T00:00:00Z", testCase: "x", status: "Errored", url: "https://x" }]);
  assert.ok(md.includes("⚠️ Errored"));
});

test("renderSituationalResultsPlainText: prints a padded table with the raw URL", () => {
  const rows = parseSituationalResultsCsv(CSV);
  const text = renderSituationalResultsPlainText(rows);
  assert.ok(text.includes("Timestamp"));
  assert.ok(text.includes("Test Case"));
  assert.ok(text.includes("Scale up from 1 to 4"));
  assert.ok(text.includes("https://performance-sdk.couchbase.com/results/situational/a/run/2"));
});

test("renderSituationalResultsPlainText: reports when there are no rows", () => {
  assert.equal(renderSituationalResultsPlainText([]), "No situational test results found.\n");
});
