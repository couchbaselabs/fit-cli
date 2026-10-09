import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseBlockWithinBudget,
  ghaNoticeCommand,
  labelForSurefireDir,
  renderRunSummaryBlock,
  STEP_SUMMARY_BUDGET_BYTES,
  STEP_SUMMARY_HARD_LIMIT_BYTES,
  SUMMARY_APPEND_OVERHEAD_BYTES,
  wrapBlockForAppend,
} from "../gha.js";

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

test("renderRunSummaryBlock: fail with summary counts shows failure count in the summary line", () => {
  const block = renderRunSummaryBlock({
    pathLabel: "aws1 / 8.0-stable / java:main / functional",
    sdk: "Java",
    ok: false,
    summary: { testsRun: 50, failures: 2, errors: 1, skipped: 0 },
  });
  assert.ok(
    block.includes("<summary>aws1 / 8.0-stable / java:main / functional (Java) — ❌ FAIL (3/50 failed)</summary>"),
  );
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

test("renderRunSummaryBlock: situationalMarkdown appears after junitMarkdown when both present", () => {
  const junit = "![badge](url)";
  const situational = "### 📊 Situational Test Results";
  const block = renderRunSummaryBlock({ pathLabel: "aws1", sdk: "Java", ok: true, junitMarkdown: junit, situationalMarkdown: situational });
  assert.ok(block.indexOf(junit) < block.indexOf(situational), "junit table should come before situational table");
});

test("renderRunSummaryBlock: situationalMarkdown alone (no junitMarkdown) still renders", () => {
  const situational = "### 📊 Situational Test Results";
  const block = renderRunSummaryBlock({ pathLabel: "aws1", sdk: "Java", ok: true, situationalMarkdown: situational });
  assert.ok(block.includes(situational));
});

test("renderRunSummaryBlock: all-absent case produces a clean minimal block", () => {
  const block = renderRunSummaryBlock({ pathLabel: "aws1", sdk: "Java", ok: true });
  assert.equal(
    block,
    ["<details>", "<summary>aws1 (Java) — ✅ PASS</summary>", "", "</details>", ""].join("\n"),
  );
});

test("chooseBlockWithinBudget: takes the richest candidate when there is room", () => {
  const chosen = chooseBlockWithinBudget(["rich", "lean", "x"], 100);
  assert.deepEqual(chosen, { block: "rich", skippedRicher: 0 });
});

test("chooseBlockWithinBudget: falls back past candidates that do not fit", () => {
  const chosen = chooseBlockWithinBudget(["aaaaaaaaaa", "bbbbb", "c"], 5);
  assert.deepEqual(chosen, { block: "bbbbb", skippedRicher: 1 });
});

test("chooseBlockWithinBudget: returns undefined when even the leanest does not fit", () => {
  assert.equal(chooseBlockWithinBudget(["aaa", "bb"], 1), undefined);
});

test("chooseBlockWithinBudget: a candidate exactly filling the remaining budget fits", () => {
  const chosen = chooseBlockWithinBudget(["abcde"], 5);
  assert.deepEqual(chosen, { block: "abcde", skippedRicher: 0 });
});

test("chooseBlockWithinBudget: measures bytes not characters, so multi-byte content is not undercounted", () => {
  // "✅" is 3 bytes in UTF-8 but one JS character — budgeting on .length would let 3x too much through.
  assert.equal(chooseBlockWithinBudget(["✅"], 2), undefined);
  assert.deepEqual(chooseBlockWithinBudget(["✅"], 3), { block: "✅", skippedRicher: 0 });
});

test("chooseBlockWithinBudget: a zero or negative remaining budget admits nothing non-empty", () => {
  assert.equal(chooseBlockWithinBudget(["a"], 0), undefined);
  assert.equal(chooseBlockWithinBudget(["a"], -50_000), undefined);
});

test("step summary budget leaves headroom under GitHub's hard limit", () => {
  assert.ok(
    STEP_SUMMARY_BUDGET_BYTES < STEP_SUMMARY_HARD_LIMIT_BYTES,
    "budget must sit below the limit at which GitHub discards the whole summary",
  );
});

test("SUMMARY_APPEND_OVERHEAD_BYTES matches what wrapBlockForAppend actually adds", () => {
  // If these drift apart the budget stops being a strict bound, which is its whole job.
  for (const block of ["", "x", "<details>\n<summary>a</summary>\n</details>\n", "✅ multi-byte"]) {
    const added = Buffer.byteLength(wrapBlockForAppend(block), "utf8") - Buffer.byteLength(block, "utf8");
    assert.equal(added, SUMMARY_APPEND_OVERHEAD_BYTES, `overhead mismatch for block ${JSON.stringify(block)}`);
  }
});

test("wrapBlockForAppend separates a block from its neighbours", () => {
  assert.equal(wrapBlockForAppend("BLOCK"), "\nBLOCK\n");
});

test("labelForSurefireDir: derives instance and run from a POSIX path", () => {
  assert.equal(
    labelForSurefireDir("/tmp/fit-cli/run/instances/aws1/clusters/8.0-stable/sessions/dotnet-main/runs/functional/surefire-reports"),
    "aws1 / functional",
  );
});

test("labelForSurefireDir: handles Windows separators too", () => {
  // findSurefireDirs builds paths with path.join(), so on Windows they arrive backslashed;
  // a POSIX-only split labelled every run "surefire-reports".
  assert.equal(
    labelForSurefireDir("C:\\tmp\\fit-cli\\run\\instances\\aws1\\clusters\\8.0-stable\\sessions\\dotnet-main\\runs\\functional\\surefire-reports"),
    "aws1 / functional",
  );
});

test("labelForSurefireDir: falls back to the directory name when the path has no runs segment", () => {
  assert.equal(labelForSurefireDir("/somewhere/else/surefire-reports"), "surefire-reports");
});

test("labelForSurefireDir: omits the instance when the path has no instances segment", () => {
  assert.equal(labelForSurefireDir("/tmp/whatever/runs/functional/surefire-reports"), "functional");
});

test("ghaNoticeCommand: plain title and message", () => {
  assert.equal(ghaNoticeCommand("CNG run skipped", "aws1 / rust:main / func: skipped."), "::notice title=CNG run skipped::aws1 / rust:main / func: skipped.");
});

test("ghaNoticeCommand: escapes the title's colons and commas, and newlines and % in both", () => {
  assert.equal(ghaNoticeCommand("a: b, c%", "50%\nnext"), "::notice title=a%3A b%2C c%25::50%25%0Anext");
});
