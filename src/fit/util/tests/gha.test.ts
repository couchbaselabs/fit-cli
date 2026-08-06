import test from "node:test";
import assert from "node:assert/strict";
import { renderRunSummaryBlock } from "../gha.js";

test("renderRunSummaryBlock: collapsed details wrapper, no open attribute", () => {
  const block = renderRunSummaryBlock({ pathLabel: "aws1 / 8.0-stable / java:main / functional", sdk: "Java", ok: true });
  assert.ok(block.startsWith("<details>"), "should start with <details>");
  assert.ok(block.trimEnd().endsWith("</details>"), "should end with </details>");
  assert.ok(!block.includes("<details open"), "should not be open by default");
});

test("renderRunSummaryBlock: pass shows tick emoji in the summary line", () => {
  const block = renderRunSummaryBlock({ pathLabel: "aws1 / 8.0-stable / java:main / functional", sdk: "Java", ok: true });
  assert.ok(block.includes("<summary>aws1 / 8.0-stable / java:main / functional (Java) — ✅ PASS</summary>"));
});

test("renderRunSummaryBlock: fail shows cross emoji in the summary line", () => {
  const block = renderRunSummaryBlock({ pathLabel: "aws1 / 8.0-stable / java:main / functional", sdk: "Java", ok: false });
  assert.ok(block.includes("<summary>aws1 / 8.0-stable / java:main / functional (Java) — ❌ FAIL</summary>"));
});

test("renderRunSummaryBlock: blank line immediately follows </summary>", () => {
  const block = renderRunSummaryBlock({ pathLabel: "aws1", sdk: "Java", ok: true });
  const lines = block.split("\n");
  const summaryIdx = lines.findIndex((l) => l.startsWith("<summary>"));
  assert.ok(summaryIdx >= 0, "should contain a <summary> line");
  assert.equal(lines[summaryIdx + 1], "", "line after <summary> should be blank");
});

test("renderRunSummaryBlock: with summary counts renders Metric/Value table", () => {
  const block = renderRunSummaryBlock({
    pathLabel: "aws1",
    sdk: "Java",
    ok: true,
    summary: { testsRun: 5818, failures: 0, errors: 0, skipped: 379 },
  });
  assert.ok(block.includes("| Metric | Value |"));
  assert.ok(block.includes("| Tests run | 5818 |"));
  assert.ok(block.includes("| Failures | 0 |"));
  assert.ok(block.includes("| Errors | 0 |"));
  assert.ok(block.includes("| Skipped | 379 |"));
});

test("renderRunSummaryBlock: without summary, no Metric/Value table", () => {
  const block = renderRunSummaryBlock({ pathLabel: "aws1", sdk: "Java", ok: true });
  assert.ok(!block.includes("| Metric | Value |"));
});

test("renderRunSummaryBlock: junitMarkdown appears inside the outer details, structurally intact", () => {
  const junit = "<details>\n<summary>Test results by package</summary>\n\n| Package | Pass |\n|:---|---:|\n| com.example | 1 |\n\n</details>\n";
  const block = renderRunSummaryBlock({ pathLabel: "aws1", sdk: "Java", ok: true, junitMarkdown: junit });

  // Nested details survives intact: one outer <details>, one inner <details>, matching closing tags.
  assert.equal((block.match(/<details>/g) ?? []).length, 2, "should contain outer + inner <details>");
  assert.equal((block.match(/<\/details>/g) ?? []).length, 2, "should contain matching closing tags");
  assert.ok(block.includes("Test results by package"), "inner summary text should be preserved");

  const outerOpen = block.indexOf("<details>");
  const innerOpen = block.indexOf("<details>", outerOpen + 1);
  const innerClose = block.indexOf("</details>", innerOpen);
  const outerClose = block.lastIndexOf("</details>");
  assert.ok(outerOpen < innerOpen && innerOpen < innerClose && innerClose < outerClose, "inner block must nest fully inside outer block");
});

test("renderRunSummaryBlock: with situationalScores renders one row per bundle", () => {
  const block = renderRunSummaryBlock({
    pathLabel: "aws1",
    sdk: "Java",
    ok: true,
    situationalScores: [
      { label: "Sanity test", scores: { score: 100, reasons: ["100 for Starting with perfect score"], errors: { sdk: 1, server: 2 } } },
      { label: "Rebalance test", scores: { reasons: ["Not applicable: no situation was executed during this run."], errors: { sdk: 0, server: 0 } } },
    ],
  });
  assert.ok(block.includes("| Test Case | Score | SDK Errors | Server Errors |"));
  assert.ok(block.includes("| Sanity test | 100 | 1 | 2 |"));
  assert.ok(block.includes("| Rebalance test | N/A | 0 | 0 |"));
});

test("renderRunSummaryBlock: summary table and situationalScores table are both present, distinct", () => {
  const block = renderRunSummaryBlock({
    pathLabel: "aws1",
    sdk: "Java",
    ok: true,
    summary: { testsRun: 1, failures: 0, errors: 0, skipped: 0 },
    situationalScores: [{ label: "Sanity test", scores: { score: 100, reasons: [], errors: { sdk: 0, server: 0 } } }],
  });
  assert.ok(block.includes("| Metric | Value |"), "JUnit summary table should still render");
  assert.ok(block.includes("| Test Case | Score | SDK Errors | Server Errors |"), "situational scores table should also render");
});

test("renderRunSummaryBlock: without situationalScores, no scores table", () => {
  const block = renderRunSummaryBlock({ pathLabel: "aws1", sdk: "Java", ok: true });
  assert.ok(!block.includes("Test Case"));
});

test("renderRunSummaryBlock: empty situationalScores array renders no scores table", () => {
  const block = renderRunSummaryBlock({ pathLabel: "aws1", sdk: "Java", ok: true, situationalScores: [] });
  assert.ok(!block.includes("Test Case"));
});

test("renderRunSummaryBlock: all-absent case produces a clean minimal block", () => {
  const block = renderRunSummaryBlock({ pathLabel: "aws1", sdk: "Java", ok: true });
  assert.equal(
    block,
    ["<details>", "<summary>aws1 (Java) — ✅ PASS</summary>", "", "</details>", ""].join("\n"),
  );
});
