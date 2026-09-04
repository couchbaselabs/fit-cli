import assert from "node:assert/strict";
import { test } from "node:test";
import { renderSlackRunSummary } from "../util/slack-results.js";

test("renderSlackRunSummary marks an all-pass run with a ✅ header and fallback", () => {
  const { text, blocks } = renderSlackRunSummary({
    title: "op-func-lite",
    passed: true,
    results: [
      { label: "aws1 / java:main / func", sdk: "java:main", ok: true, testsRun: 412, failures: 0, errors: 0, skipped: 0, durationMs: 842000 },
    ],
  });
  assert.match(text, /^✅ op-func-lite/);
  const header = blocks[0] as { type: string; text: { text: string } };
  assert.equal(header.type, "header");
  assert.match(header.text.text, /^✅ op-func-lite/);
});

test("renderSlackRunSummary formats durations with hours and rounds to the minute", () => {
  const durations = [
    { durationMs: 45_000, expect: "45s" },
    { durationMs: 71 * 60_000 + 59_000, expect: "1h12m" }, // 71m59s rounds up to 1h12m
    { durationMs: 35 * 60_000 + 6_000, expect: "35m" },
    { durationMs: 3 * 60 * 60_000, expect: "3h00m" },
  ];
  for (const { durationMs, expect } of durations) {
    const { blocks } = renderSlackRunSummary({
      title: "x",
      passed: true,
      results: [{ label: "l", sdk: "s", ok: true, durationMs }],
    });
    assert.match(JSON.stringify(blocks), new RegExp(expect), `durationMs=${durationMs} should render "${expect}"`);
  }
});

test("renderSlackRunSummary marks failures with ❌ and includes a failing-tests code block", () => {
  const { text, blocks } = renderSlackRunSummary({
    title: "op-capella-sit-lite",
    passed: false,
    results: [
      {
        label: "aws1 / java:main / func",
        sdk: "java:main",
        ok: false,
        testsRun: 388,
        failures: 3,
        errors: 0,
        skipped: 0,
        durationMs: 1001000,
        failingTests: [{ name: "ReplaceTest.concurrentReplace", detail: "assertion failed" }],
      },
    ],
  });
  assert.match(text, /^❌ op-capella-sit-lite — 1\/1 run failed/);
  const serialized = JSON.stringify(blocks);
  assert.match(serialized, /ReplaceTest\.concurrentReplace/);
  assert.match(serialized, /```/);
});

test("renderSlackRunSummary shows a failing test's full detail rather than cutting it off at 80 chars", () => {
  const longDetail =
    "Situational test 'Rebalance from 5 to 3 nodes' scored -100 (reasons: [\"-100 for exceeding the maximum allowed duration of 600s\"])";
  assert.ok(longDetail.length > 80, "fixture must exceed the old 80-char cutoff to be a meaningful test");
  const { blocks } = renderSlackRunSummary({
    title: "op-multi-lite",
    passed: false,
    results: [
      {
        label: "aws1 / java:main / situational:standard-qe+PE",
        sdk: "java:main",
        ok: false,
        testsRun: 5,
        failures: 1,
        errors: 0,
        skipped: 0,
        failingTests: [{ name: "CbDinoRebalanceTest.horizontalScaleInFrom5To3Nodes", detail: longDetail }],
      },
    ],
  });
  assert.match(JSON.stringify(blocks), /scored -100 \(reasons: \[\\"-100 for exceeding the maximum allowed duration of 600s\\"\]\)/);
});

test("renderSlackRunSummary adds a GitHub Actions run link when provided", () => {
  const { blocks } = renderSlackRunSummary({
    title: "x",
    passed: true,
    results: [{ label: "l", sdk: "s", ok: true }],
    ghaRunUrl: "https://github.com/o/r/actions/runs/42",
  });
  assert.match(JSON.stringify(blocks), /actions\/runs\/42/);
});

test("renderSlackRunSummary combines rows from multiple presets into one message", () => {
  // This is the shape a preset-group run (run.ts) produces: rows from several
  // presets, gathered into a single SlackRunSummaryInput rather than one per preset.
  const { text, blocks } = renderSlackRunSummary({
    title: "op-multi-lite",
    passed: false,
    results: [
      { label: "aws1 / java:main / func", sdk: "java:main", ok: true, testsRun: 412, failures: 0, errors: 0, skipped: 0 },
      {
        label: "aws2 / go:main / func",
        sdk: "go:main",
        ok: false,
        testsRun: 200,
        failures: 1,
        errors: 0,
        skipped: 0,
        failingTests: [{ name: "TxnTest.timeout" }],
      },
      // A preset that crashed before producing any test results (run.ts's catch branch).
      { label: "op-crashed-preset", sdk: "op-crashed-preset", ok: false },
    ],
  });
  assert.match(text, /^❌ op-multi-lite — 2\/3 runs failed/);
  const serialized = JSON.stringify(blocks);
  assert.match(serialized, /java:main/);
  assert.match(serialized, /go:main/);
  assert.match(serialized, /op-crashed-preset/);
  assert.match(serialized, /TxnTest\.timeout/);
});

test("renderSlackRunSummary drops failing-test detail once a large failing group nears the block limit", () => {
  // Slack's chat.postMessage hard-rejects a message over 50 blocks (invalid_blocks). A
  // preset group with many failing presets must degrade (drop failing-test detail first)
  // rather than build a message that fails to post at all.
  const results = Array.from({ length: 40 }, (_, i) => ({
    label: `preset-${i}`,
    sdk: `sdk-${i}`,
    ok: false,
    testsRun: 10,
    failures: 2,
    errors: 0,
    skipped: 0,
    failingTests: [{ name: `Test${i}.case`, detail: "assertion failed" }],
  }));
  const { blocks } = renderSlackRunSummary({ title: "big-group", passed: false, results });
  assert.ok(blocks.length <= 48, `expected <= 48 blocks, got ${blocks.length}`);
  // Every result must still be represented once detail is dropped — none silently lost.
  assert.equal(blocks.length, 1 + results.length);
  assert.doesNotMatch(JSON.stringify(blocks), /Test0\.case/);
});

test("renderSlackRunSummary truncates rows once even dropping failing-test detail isn't enough", () => {
  // With MAX_TOTAL_BLOCKS=48 and no footer, budget for rows is 47 — one block per row
  // after detail is dropped, so 60 rows must trigger truncation.
  const results = Array.from({ length: 60 }, (_, i) => ({
    label: `preset-${i}`,
    sdk: `sdk-${i}`,
    ok: false,
    testsRun: 10,
    failures: 2,
    errors: 0,
    skipped: 0,
    failingTests: [{ name: `Test${i}.case`, detail: "assertion failed" }],
  }));
  const { blocks } = renderSlackRunSummary({ title: "huge-group", passed: false, results });
  assert.ok(blocks.length <= 48, `expected <= 48 blocks, got ${blocks.length}`);
  const serialized = JSON.stringify(blocks);
  assert.match(serialized, /and \d+ more result/);
  // First row present, last row dropped — confirms truncation, not just detail-dropping.
  assert.match(serialized, /`preset-0`/);
  assert.doesNotMatch(serialized, /`preset-59`/);
});

test("renderSlackRunSummary flags a crashed/no-result row without a misleading '0 failed'", () => {
  const { blocks } = renderSlackRunSummary({
    title: "op-multi-lite",
    passed: false,
    results: [{ label: "op-crashed-preset", sdk: "op-crashed-preset", ok: false }],
  });
  const serialized = JSON.stringify(blocks);
  assert.doesNotMatch(serialized, /0 failed/);
  assert.match(serialized, /no results/);
});

test("renderSlackRunSummary shows the likely cause on a crashed row when one was found", () => {
  const { blocks } = renderSlackRunSummary({
    title: "op-multi-lite",
    passed: false,
    results: [
      { label: "op-crashed-preset", sdk: "op-crashed-preset", ok: false, failureSnippet: "unknown flag: --capella-create-pool" },
    ],
  });
  const serialized = JSON.stringify(blocks);
  assert.match(serialized, /likely cause/);
  assert.match(serialized, /unknown flag: --capella-create-pool/);
});

test("renderSlackRunSummary falls back to 'see logs' when no cause was found, without a stray 'undefined'", () => {
  const { blocks } = renderSlackRunSummary({
    title: "op-multi-lite",
    passed: false,
    results: [{ label: "op-crashed-preset", sdk: "op-crashed-preset", ok: false }],
  });
  const serialized = JSON.stringify(blocks);
  assert.match(serialized, /see logs/);
  assert.doesNotMatch(serialized, /undefined/);
});
