/**
 * Unit tests for building the health Pages site from one run's reports.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/report/tests/site-command.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { HealthReport } from "../build-report.js";
import { buildSite } from "../site-command.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "health-site-"));
  dirs.push(d);
  return d;
}

/** A report with one functional series that ran `test` and failed it on the last night. */
function report(sdk: string, failing: boolean): HealthReport {
  const tests = failing
    ? [{ test: "LockTest.x", cls: "always", since: "2026-10-02", lastFail: "2026-10-02", lastEpisode: { from: "2026-10-02", to: "2026-10-02", nights: 1 } }]
    : [];
  return {
    sdk,
    start: "2026-10-01",
    end: "2026-10-02",
    series: [
      {
        id: "op-onprem-func-lite|functional",
        kind: "functional",
        active: true,
        tests,
        ran: ["2026-10-02"],
        perNight: { "2026-10-02": failing ? 1 : 0 },
        testCounts: { "2026-10-02": { testCases: 10, tests: 10, passed: failing ? 9 : 10, failing: failing ? 1 : 0, skipped: 0 } },
      },
    ],
    testsSeen: { functional: { tests: ["LockTest.x"], complete: true }, situational: { tests: [], complete: true } },
  } as unknown as HealthReport;
}

function reportsDir(...reports: HealthReport[]): string {
  const dir = tmp();
  for (const r of reports) {
    mkdirSync(join(dir, `health-report-${r.sdk}`));
    writeFileSync(join(dir, `health-report-${r.sdk}`, "health-report.json"), JSON.stringify(r));
  }
  return dir;
}

/** A published site (a checkout of fit-health's site branch): path under it to contents. */
function previousSite(files: Record<string, string>): string {
  const dir = tmp();
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

test("the site has each reporting SDK's page and report, the top page, the SDK list and a redirect", async () => {
  const site = join(tmp(), "site");
  const sdks = await buildSite(reportsDir(report("go", true), report("java", false)), site);
  assert.deepEqual(sdks, ["go", "java"]);
  assert.deepEqual(readdirSync(join(site, "health")).sort(), ["go", "index.html", "java", "sdks.json"]);
  assert.ok(existsSync(join(site, ".nojekyll")));
  assert.equal(readFileSync(join(site, "health", "sdks.json"), "utf8"), '["go","java"]\n');
  for (const sdk of sdks) {
    assert.ok(existsSync(join(site, "health", sdk, "index.html")));
    assert.equal((JSON.parse(readFileSync(join(site, "health", sdk, "report.json"), "utf8")) as HealthReport).sdk, sdk);
  }
  const root = readFileSync(join(site, "index.html"), "utf8");
  assert.match(root, /url=health\//);
  assert.match(root, /noindex/);
  assert.match(readFileSync(join(site, "health", "go", "index.html"), "utf8"), /noindex/);
});

test("the reporting SDKs are compared with each other before their pages are written", async () => {
  const site = join(tmp(), "site");
  await buildSite(reportsDir(report("go", true), report("java", false)), site);
  const go = JSON.parse(readFileSync(join(site, "health", "go", "report.json"), "utf8")) as HealthReport;
  const finding = go.series[0].tests[0];
  assert.equal(finding.crossSdk?.category, "only-this-sdk");
  assert.match(readFileSync(join(site, "health", "go", "index.html"), "utf8"), /"crossSdk"/);
});

test("an SDK the published site has and this run didn't report keeps its published page; one with no page is dropped", async () => {
  const site = join(tmp(), "site");
  const previous = previousSite({
    "health/sdks.json": '["go","node","python","../x"]',
    "health/go/index.html": "stale go page",
    "health/node/index.html": "published node page",
    "health/node/report.json": JSON.stringify(report("node", false)),
  });
  const sdks = await buildSite(reportsDir(report("go", true)), site, previous);
  assert.deepEqual(sdks, ["go", "node"], "python has no published page, and ../x isn't an SDK name");
  assert.notEqual(readFileSync(join(site, "health", "go", "index.html"), "utf8"), "stale go page", "this run's report wins");
  assert.equal(readFileSync(join(site, "health", "node", "index.html"), "utf8"), "published node page");
  assert.ok(existsSync(join(site, "health", "node", "report.json")));
  assert.ok(!existsSync(join(site, "health", "python")));
  assert.match(readFileSync(join(site, "health", "index.html"), "utf8"), /"node"/);
});

test("with no published site yet, only this run's reports are published", async () => {
  const site = join(tmp(), "site");
  assert.deepEqual(await buildSite(reportsDir(report("go", false)), site, tmp()), ["go"]);
});

test("a directory that isn't an SDK report, or holds another SDK's, is skipped, and no reports at all is an error", async () => {
  const dir = reportsDir();
  mkdirSync(join(dir, "health-report-Bad_Name"));
  writeFileSync(join(dir, "health-report-Bad_Name", "health-report.json"), JSON.stringify(report("Bad_Name", false)));
  mkdirSync(join(dir, "health-report-go"));
  // A report whose own sdk isn't its directory's: its sdk would name paths outside the site.
  mkdirSync(join(dir, "health-report-java"));
  writeFileSync(join(dir, "health-report-java", "health-report.json"), JSON.stringify(report("../x", false)));
  const site = join(tmp(), "site");
  await assert.rejects(buildSite(dir, site), /no SDK reports to publish/);
  assert.ok(!existsSync(join(site, "x")));
});

test("the published site's weekly wrap-ups are kept as they are", async () => {
  const site = join(tmp(), "site");
  const previous = previousSite({
    "health/sdks.json": '["go"]',
    "health/go/index.html": "published go page",
    "health/weekly/index.json": '{"weeks":[]}',
    "health/weekly/2026-W42/index.html": "frozen week",
  });
  await buildSite(reportsDir(report("go", false)), site, previous);
  assert.equal(readFileSync(join(site, "health", "weekly", "2026-W42", "index.html"), "utf8"), "frozen week");
  assert.ok(existsSync(join(site, "health", "weekly", "index.json")));
});
