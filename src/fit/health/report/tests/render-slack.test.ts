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
  assert.match(d.headline, /^\*\.NET FIT health\* · nightly run of Mon 28 Sep \(UTC date\) · updated <!date\^\d+\^\{date_short_pretty\} at \{time\}\|\d{4}-\d\d-\d\d \d\d:\d\d UTC> · last 30 days/);
  assert.match(d.headline, /Failed last night: \*3\* of 3 run · 0 skipped \(3 on-prem\) — 3 persistent · 0 new · 0 intermittent/);
  assert.match(d.thread, /^\*Failed last night\*\n• `Chronic\.always` — persistent: fails every night, on-prem/);
  assert.match(d.headline, /\*2\* started failing/);
  // Started and stopped are counted over the recent window, intermittent over the whole one.
  assert.match(d.headline, /Last 14 days: \*2\* started failing · \*\d+\* stopped · last 30 days: \*\d+\* intermittent/);
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
  const expired: RunManifest = { schema: 1, sdk: "dotnet", runId: 99, runAttempt: 1, date: "2026-09-21", ci: { repo: "couchbase/couchbase-net-client", runId: 99, runAttempt: 1 }, status: "expired", records: [] };
  const d = renderSlackDigest(buildHealthReport("dotnet", [...rs, aborted], [expired], { end: "2026-09-28" }), ".NET");
  assert.match(d.headline, /_Data: 1 night with no usable results \(20 Sep\); 1 run with no readable log\._/);
});

test("a quiet fortnight says so rather than posting an empty thread", () => {
  const d = renderSlackDigest(buildHealthReport("dotnet", days(28).map((d) => rec(d)), [], { end: "2026-09-28" }), ".NET");
  assert.equal(d.thread, "_Nothing started or stopped failing in the last 14 days._");
  assert.doesNotMatch(d.headline, /Full report/);
});

test("a clean night says so, with what passed where", () => {
  const rs = days(28).map((d) => {
    const r = rec(d);
    for (const t of ["A.one", "A.two", "A.three"]) addOutcome(r.tests, t, "p");
    addOutcome(r.tests, "A.skip", "s");
    return r;
  });
  const d = renderSlackDigest(buildHealthReport("dotnet", rs, [], { end: "2026-09-28" }), ".NET");
  assert.match(d.headline, /• ✓ Last night was clean: all \*3\* passed · 1 skipped \(on-prem 3\)/);
  assert.doesNotMatch(d.headline, /Failed last night|full results/);
});

test("0 failed isn't clean while a counted preset gave no full results, and the post says which", () => {
  const capellaPe = { preset: "op-capella-pe-sit-lite", kind: "situational" as const, cluster: "Capella:8.0", params: { privateEndpoint: true } };
  const cng = { preset: "op-cng-func-lite" };
  const rs = days(28).flatMap((d) => [
    rec(d),
    // Capella PE ran every night but the last; CNG left only its CI log last night.
    ...(d === "2026-09-28" ? [] : [rec(d, [], capellaPe)]),
    rec(d, [], d === "2026-09-28" ? { ...cng, source: "run-log-scrape", passesKnown: false } : cng),
  ]);
  const d = renderSlackDigest(buildHealthReport("dotnet", rs, [], { end: "2026-09-28" }), ".NET");
  // A CI log names failures only, so its 0 is a minimum.
  assert.match(d.headline, /Failed last night: \*at least 0\*/);
  assert.match(d.headline, /• Not clean: no full results last night from CNG \(CI log only\) · Capella PE \(no results\)\n/);
  assert.doesNotMatch(d.headline, /was clean/);
  // With a failure, the night isn't clean anyway: the missing preset is still named.
  const failing = [...rs.filter((r) => r.date !== "2026-09-28" || r.preset !== "op-onprem-func-lite"), rec("2026-09-28", ["A.b"])];
  const f = renderSlackDigest(buildHealthReport("dotnet", failing, [], { end: "2026-09-28" }), ".NET");
  assert.match(f.headline, /• No full results last night from .*Capella PE \(no results\)/);
});

test("a night with no usable results is stated, not left out", () => {
  const rs = [...days(27).map((d) => rec(d)), rec("2026-09-28", [], { outcome: "aborted", counts: undefined, abortedAt: "FatalToCluster" })];
  const d = renderSlackDigest(buildHealthReport("dotnet", rs, [], { end: "2026-09-28" }), ".NET");
  assert.match(d.headline, /• Last night: no usable results/);
  assert.doesNotMatch(d.headline, /Failed last night|was clean/);
});

test("long lists are cut short, and Slack's control characters are escaped", () => {
  const many = Array.from({ length: 20 }, (_, i) => `C${i}.t`);
  const rs = days(28).map((d, i) => rec(d, i >= 25 ? many : []));
  const d = renderSlackDigest(buildHealthReport("dotnet", rs, [], { end: "2026-09-28" }), ".NET");
  assert.match(d.thread, /…and 5 more \(see the full report\)/);
  assert.equal(slackEscape("a<b>&c"), "a&lt;b&gt;&amp;c");
});

test("the digest posts to a configured channel only when asked, with --slack", () => {
  assert.equal(slackDecision({}, "C1").post, false);
  assert.deepEqual(slackDecision({ slack: true }, "C1"), { post: true, channel: "C1" });
  // No channel configured: never posts, even with --slack.
  assert.equal(slackDecision({ slack: true }, undefined).post, false);
  // An explicit channel is itself a request to post (it is how a DM test is done).
  assert.deepEqual(slackDecision({ "slack-channel": "U9" }, undefined), { post: true, channel: "U9" });
  assert.equal(slackDecision({ slack: true, "no-slack": true }, "C1").post, false);
  const dry = slackDecision({ "slack-dry-run": true }, "C1");
  assert.ok(!dry.post && dry.dryRun);
});
