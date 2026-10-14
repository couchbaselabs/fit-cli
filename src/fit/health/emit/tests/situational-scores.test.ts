/**
 * Unit tests for counting a negative situational score as a test failure: the runUuid kept out
 * of captured output, the scores read from results.tar, and their mapping onto the record.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/emit/tests/situational-scores.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamSectionStripper, junitOutcomes } from "../junit-outcomes.js";
import { applyNegativeScores, resultsMember, scoresFromResultsTar } from "../situational-scores.js";
import { tar, tarGz } from "./tar-fixture.js";

const U1 = "9f191a3a-a19d-455e-9728-610da8c49029";
const U2 = "7825234d-3833-4ed9-b8bc-a7dbf44326d2";
const U3 = "2b4eb169-c23a-42be-9e1f-b63dae1810c3";

/** A testcase as the situational driver's report has it: its output logs the scenario's runUuid. */
const tc = (name: string, uuid: string, inner = "") =>
  `<testcase name="${name}" classname="com.couchbase.situational.tests.cbdino_tests.CbDinoRebalanceTest">${inner}<system-out><![CDATA[${"noise\n".repeat(300)}` +
  `02:04:36.446 INFO SituationalRunner$ - Performer has finished, finalising for situationalRunUuid fd26a4e3-9896-459a-b6bd-5cdd5b84f233 and runUuid=${uuid}\n` +
  `${"more noise\n".repeat(300)}]]></system-out></testcase>`;
const suite = (...cases: string[]) => `<testsuite>${cases.join("")}</testsuite>`;

const runJson = (uuid: string) => JSON.stringify({ forDatabase: { runUuid: uuid, workload: { situational: "Rebalance from 3 to 5 nodes" } } });
const scoresJson = (score: number, reason: string) => JSON.stringify({ score, reasons: [`${score} for ${reason}`], errors: { server: 0, sdk: 0 } });

test("a test's runUuid survives the stripping of its captured output, however the stream is chunked", () => {
  const xml = suite(tc("verticalScaleOut", U1), tc("horizontalScaleOut", U2));
  for (const size of [1, 7, 64, 100_000]) {
    const s = new StreamSectionStripper();
    for (let i = 0; i < xml.length; i += size) s.push(xml.slice(i, i + size));
    const out = s.finish();
    assert.ok(!out.includes("noise"), `chunk size ${size}: output dropped`);
    const o = junitOutcomes([out]);
    assert.deepEqual(o.runUuids, { "CbDinoRebalanceTest.verticalScaleOut": [U1], "CbDinoRebalanceTest.horizontalScaleOut": [U2] }, `chunk size ${size}`);
    assert.deepEqual(o.counts, { passed: 2, failed: 0, errored: 0, skipped: 0 });
  }
});

test("results.tar: each scored scenario by runUuid; unscored ones left out; unreadable ones a warning", async () => {
  const files: [string, string, string][] = [
    ["./9f191a3a/run.json5", "0", runJson(U1)],
    ["./9f191a3a/scores.json5", "0", scoresJson(-100, "Failed as % of successful results during ramp (86.4%) < required (95.0%")],
    ["./9f191a3a/buckets.csv", "0", "timestamp\n"],
    ["./7825234d/run.json5", "0", runJson(U2)],
    ["./7825234d/scores.json5", "0", scoresJson(100, "Starting with perfect score")],
    ["./aaaaaaaa/run.json5", "0", runJson("aaaaaaaa-0000-0000-0000-000000000000")],
    ["./aaaaaaaa/scores.json5", "0", JSON.stringify({ reasons: [] })],
    ["./bbbbbbbb/scores.json5", "0", scoresJson(-50, "x")],
    ["./cccccccc/run.json5", "0", runJson(U3)],
    ["./cccccccc/scores.json5", "0", "{not json"],
  ];
  for (const [archive, gzip] of [[tar(files), false], [tarGz(files), true]] as const) {
    const { scores, warnings } = await scoresFromResultsTar(archive, gzip);
    assert.deepEqual([...scores.keys()].sort(), [U2, U1].sort());
    assert.deepEqual(scores.get(U1), { score: -100, reasons: ["-100 for Failed as % of successful results during ramp (86.4%) < required (95.0%"] });
    assert.equal(warnings.length, 2, warnings.join("\n"));
    assert.match(warnings.join("\n"), /bbbbbbbb: no run\.json5/);
    assert.match(warnings.join("\n"), /cccccccc: scores\.json5 is unparseable/);
  }
});

test("a negative score fails its test; a positive one, or one no test claims, changes nothing", () => {
  const junit = junitOutcomes([suite(tc("verticalScaleOut", U1), tc("horizontalScaleOut", U2), tc("horizontalScaleIn", U3, "<failure/>"))]);
  const scores = new Map([
    [U1, { score: -100, reasons: ["-100 for ramp"] }],
    [U2, { score: 100, reasons: ["100 for Starting with perfect score"] }],
    [U3, { score: -50, reasons: ["-50 for rebound"] }],
    ["dddddddd-0000-0000-0000-000000000000", { score: -100, reasons: [] }],
  ]);
  const { failures, warnings } = applyNegativeScores(junit, scores);
  assert.deepEqual(failures, {
    "CbDinoRebalanceTest.verticalScaleOut": { score: -100, reasons: ["-100 for ramp"] },
    "CbDinoRebalanceTest.horizontalScaleIn": { score: -50, reasons: ["-50 for rebound"] },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /dddddddd-.* scored -100, but no test names it/);
  // verticalScaleOut moves from passed to failed; horizontalScaleIn had already failed.
  assert.deepEqual(junit.tests.CbDinoRebalanceTest, { p: ["horizontalScaleOut"], f: ["horizontalScaleIn", "verticalScaleOut"] });
  assert.deepEqual(junit.counts, { passed: 1, failed: 2, errored: 0, skipped: 0 });
});

test("a situational upgrade with a negative score is a failing record that says why", async () => {
  const { upgradeRecord } = await import("../archive-junit.js");
  const { RUN_RECORD_SCHEMA, failingTests } = await import("../../record/run-record.js");
  const scraped = {
    schema: RUN_RECORD_SCHEMA, source: "run-log-scrape" as const, sdk: "java", preset: "op-capella-pe-sit-lite", kind: "situational" as const,
    cluster: "Capella:8.0", params: {}, date: "2026-10-13", ci: { repo: "r", runId: 1, runAttempt: 1 }, outcome: "passed" as const,
    counts: { passed: 2, failed: 0, errored: 0, skipped: 0 }, passesKnown: false, tests: {},
  };
  const reports = tarGz([["./TEST-a.xml", "0", suite(tc("verticalScaleOut", U1), tc("horizontalScaleOut", U2))]]);
  const results = tar([
    ["./9f191a3a/run.json5", "0", runJson(U1)],
    ["./9f191a3a/scores.json5", "0", scoresJson(-100, "ramp")],
    ["./7825234d/run.json5", "0", runJson(U2)],
    ["./7825234d/scores.json5", "0", scoresJson(100, "Starting with perfect score")],
  ]);
  const up = await upgradeRecord(scraped, reports, "s3://fit-cli/runs/x.zip", "a/surefire-reports.tar.gz", { tar: results, gzip: false });
  assert.ok(!("reason" in up));
  assert.equal(up.record.outcome, "tests_failed");
  assert.deepEqual(failingTests(up.record), ["CbDinoRebalanceTest.verticalScaleOut"]);
  assert.deepEqual(up.record.scoreFailures, { "CbDinoRebalanceTest.verticalScaleOut": { score: -100, reasons: ["-100 for ramp"] } });
  assert.deepEqual(up.warnings, []);

  // Results that can't be read are a warning: the record keeps JUnit's outcomes.
  const cut = await upgradeRecord(scraped, reports, "s3://fit-cli/runs/x.zip", "a/surefire-reports.tar.gz", { tar: results.subarray(0, 700), gzip: false });
  assert.ok(!("reason" in cut));
  assert.equal(cut.record.outcome, "passed");
  assert.equal(cut.record.scoreFailures, undefined);
  assert.equal(cut.warnings.length, 1);
  assert.match(cut.warnings[0], /situational results could not be read .*JUnit's outcomes kept/);

  // Without results (an archive from before they were kept), the outcomes are JUnit's alone.
  const plain = await upgradeRecord(scraped, reports, "s3://fit-cli/runs/x.zip", "a/surefire-reports.tar.gz");
  assert.ok(!("reason" in plain));
  assert.equal(plain.record.outcome, "passed");
  assert.equal(plain.record.scoreFailures, undefined);
});

test("the results member is the one beside the run's own surefire tarball", () => {
  const dir = "instances/aws1/clusterless-sessions/java-main/runs/situational-standard-qe-v8.0/";
  assert.deepEqual(resultsMember([`${dir}surefire-reports.tar.gz`, `${dir}results.tar`], `${dir}surefire-reports.tar.gz`), { member: `${dir}results.tar`, gzip: false });
  assert.deepEqual(resultsMember([`${dir}results.tar.gz`], `${dir}surefire-reports.tar.gz`), { member: `${dir}results.tar.gz`, gzip: true });
  assert.equal(resultsMember(["other/results.tar"], `${dir}surefire-reports.tar.gz`), undefined);
});
