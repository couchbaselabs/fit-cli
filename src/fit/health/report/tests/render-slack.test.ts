/**
 * Unit tests for the Slack digest of a health report.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/report/tests/render-slack.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_RECORD_SCHEMA, addOutcome, type RunRecord } from "../../record/run-record.js";
import type { RunManifest } from "../../record/run-manifest.js";
import { buildHealthReport } from "../build-report.js";
import { renderSlackDigest, slackEscape } from "../render/render-slack.js";
import { slackDecision } from "../report.js";

let runId = 1;
function rec(date: string, failing: string[] = [], over: Partial<RunRecord> = {}): RunRecord {
  const tests = {};
  for (const t of failing) addOutcome(tests, t, "f");
  return {
    schema: RUN_RECORD_SCHEMA,
    source: "run-archive-junit",
    sdk: "dotnet",
    preset: "op-onprem-func-lite",
    kind: "functional",
    cluster: "8.5-stable",
    params: {},
    date,
    ci: { repo: "r", runId: runId++, runAttempt: 1 },
    outcome: failing.length ? "tests_failed" : "passed",
    counts: { passed: 100, failed: failing.length, errored: 0, skipped: 0 },
    passesKnown: true,
    tests,
    ...over,
  };
}
const days = (n: number) => Array.from({ length: n }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);

test("the headline states the counts, and the thread lists what changed", () => {
  const rs = days(28).map((d, i) => rec(d, [...(i >= 24 ? ["LockTest.upsert", "LockTest.touch"] : []), "Chronic.always"]));
  const report = buildHealthReport("dotnet", rs, [], { end: "2026-09-28" });
  const d = renderSlackDigest(report, ".NET", "https://example.com/report");
  assert.match(d.headline, /^\*\.NET FIT health\* · as of 28 Sep · last 30 days/);
  assert.match(d.headline, /Failing now: \*3\* \(3 on-prem\)/);
  assert.match(d.headline, /\*2\* started failing/);
  // A report covers its own SDK only: no claims about other SDKs.
  assert.doesNotMatch(d.headline + d.thread, /Java|other SDK/);
  assert.match(d.headline, /<https:\/\/example\.com\/report\|Full report>/);
  // Two tests of one class that broke the same night are one line.
  assert.match(d.thread, /• `LockTest` touch, upsert — since 25 Sep, on-prem/);
  assert.match(d.thread, /Failed every night they ran[\s\S]*`Chronic\.always` — on-prem/);
});

test("nights with no usable results are always stated, never passed over", () => {
  const rs = days(28).filter((d) => d !== "2026-09-20").map((d) => rec(d, ["A.b"]));
  const aborted = rec("2026-09-20", [], { outcome: "aborted", counts: undefined, abortedAt: "FatalToCluster" });
  const expired: RunManifest = { schema: 1, sdk: "dotnet", runId: 99, runAttempt: 1, date: "2026-09-21", status: "expired", records: [] };
  const d = renderSlackDigest(buildHealthReport("dotnet", [...rs, aborted], [expired], { end: "2026-09-28" }), ".NET");
  assert.match(d.headline, /_Data: 1 night with no usable results \(20 Sep\); 1 run with no readable log\._/);
});

test("a quiet fortnight says so rather than posting an empty thread", () => {
  const d = renderSlackDigest(buildHealthReport("dotnet", days(28).map((d) => rec(d)), [], { end: "2026-09-28" }), ".NET");
  assert.equal(d.thread, "_Nothing started or stopped failing in the last 14 days._");
  assert.doesNotMatch(d.headline, /Full report/);
});

test("long lists are cut short, and Slack's control characters are escaped", () => {
  const many = Array.from({ length: 20 }, (_, i) => `C${i}.t`);
  const rs = days(28).map((d, i) => rec(d, i >= 25 ? many : []));
  const d = renderSlackDigest(buildHealthReport("dotnet", rs, [], { end: "2026-09-28" }), ".NET");
  assert.match(d.thread, /…and 5 more \(see the full report\)/);
  assert.equal(slackEscape("a<b>&c"), "a&lt;b&gt;&amp;c");
});

test("a configured channel posts automatically in CI, but a local run must ask with --slack", () => {
  const ci = { GITHUB_ACTIONS: "true" };
  assert.deepEqual(slackDecision([], "C1", ci), { post: true, channel: "C1" });
  assert.equal(slackDecision([], "C1", {}).post, false);
  assert.deepEqual(slackDecision(["--slack"], "C1", {}), { post: true, channel: "C1" });
  // No channel configured: never posts, even with --slack or in CI.
  assert.equal(slackDecision(["--slack"], undefined, ci).post, false);
  // An explicit channel is itself a request to post (it is how a DM test is done).
  assert.deepEqual(slackDecision(["--slack-channel", "U9"], undefined, {}), { post: true, channel: "U9" });
  assert.equal(slackDecision(["--no-slack"], "C1", ci).post, false);
  const dry = slackDecision(["--slack-dry-run"], "C1", ci);
  assert.ok(!dry.post && dry.dryRun);
});
