/**
 * Unit tests for writing the weekly wrap-up into the site: frozen weeks, the index and latest/.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/report/tests/weekly-command.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { readWeeks, reportsAt, writeIndex, writeWeek } from "../weekly-command.js";
import { buildWeekly, isoWeek, isoWeekById, type WeekEntry } from "../weekly.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "health-weekly-"));
  dirs.push(d);
  return d;
}

const week = (date: string) => buildWeekly([{ sdk: "go", name: "Go" }], isoWeek(date), new Date("2026-10-26T12:00:00Z"));

test("a week id parses back to its week; anything else doesn't", () => {
  assert.deepEqual(isoWeekById("2026-W43"), { id: "2026-W43", start: "2026-10-19", end: "2026-10-25" });
  assert.deepEqual(isoWeekById("2026-W01"), { id: "2026-W01", start: "2025-12-29", end: "2026-01-04" });
  assert.equal(isoWeekById("2026-W53")?.id, "2026-W53");
  assert.equal(isoWeekById("2025-W53"), undefined, "2025 has 52 weeks");
  assert.equal(isoWeekById("2026-43"), undefined);
});

test("a week is frozen: written once, then left alone unless rebuilt", async () => {
  const dir = tmp();
  assert.equal(await writeWeek(dir, week("2026-10-19")), true);
  writeFileSync(join(dir, "2026-W43", "index.html"), "frozen");
  assert.equal(await writeWeek(dir, week("2026-10-19")), false);
  assert.equal(readFileSync(join(dir, "2026-W43", "index.html"), "utf8"), "frozen");
  assert.equal(await writeWeek(dir, week("2026-10-19"), true), true);
  assert.notEqual(readFileSync(join(dir, "2026-W43", "index.html"), "utf8"), "frozen");
});

test("the index lists every week oldest first, and latest/ is the newest week's page", async () => {
  const dir = tmp();
  await writeWeek(dir, week("2026-10-19"));
  await writeWeek(dir, week("2026-10-12"));
  const weeks = await writeIndex(dir);
  assert.deepEqual(
    weeks.map((w) => w.id),
    ["2026-W42", "2026-W43"],
  );
  assert.deepEqual((JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as { weeks: WeekEntry[] }).weeks[1], {
    id: "2026-W43",
    start: "2026-10-19",
    end: "2026-10-25",
    changed: 1,
    sdks: 1,
  });
  assert.equal(readFileSync(join(dir, "latest", "index.html"), "utf8"), readFileSync(join(dir, "2026-W43", "index.html"), "utf8"));
  assert.match(readFileSync(join(dir, "index.html"), "utf8"), /"2026-W43".*"2026-W42"/s, "the page lists newest first");
});

test("a directory that isn't a week, or a week with no data, is left out of the index", async () => {
  const dir = tmp();
  await writeWeek(dir, week("2026-10-19"));
  await writeIndex(dir);
  writeFileSync(join(dir, "notes.txt"), "x");
  rmSync(join(dir, "2026-W43", "week.json"));
  assert.deepEqual(readWeeks(dir), []);
});

test("an SDK whose every log was unreadable still reports, so its nights show as unreadable", () => {
  const manifest = {
    schema: 1 as const,
    sdk: "go",
    runId: 7,
    runAttempt: 1,
    date: "2026-10-21",
    ci: { repo: "r", runId: 7, runAttempt: 1 },
    status: "fetch_failed" as const,
    records: [],
  };
  const r = reportsAt(["go", [], [manifest], {}], ["2026-10-25"]).get("2026-10-25");
  assert.deepEqual(r?.source.unreadableRuns.map((u) => [u.date, u.status]), [["2026-10-21", "fetch_failed"]]);
  assert.equal(reportsAt(["go", [], [], {}], ["2026-10-25"]).get("2026-10-25"), undefined);
});
