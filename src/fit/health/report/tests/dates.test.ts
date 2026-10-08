/**
 * Unit tests for the report's calendar-day arithmetic.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/report/tests/dates.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, calendarDays, daysBetween, shortDate, startOfDay } from "../dates.js";

test("days move across month and year ends, in UTC", () => {
  assert.equal(addDays("2026-10-01", -1), "2026-09-30");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(daysBetween("2026-09-30", "2026-10-07"), 7);
  assert.equal(daysBetween("2026-10-07", "2026-09-30"), -7);
  assert.deepEqual(calendarDays("2026-09-29", "2026-10-01"), ["2026-09-29", "2026-09-30", "2026-10-01"]);
  assert.deepEqual(calendarDays(undefined, "2026-10-01"), []);
  assert.deepEqual(calendarDays("2026-10-02", "2026-10-01"), []);
  assert.equal(startOfDay("2026-10-07"), "2026-10-07T00:00:00.000Z");
  assert.equal(shortDate("2026-10-07"), "7 Oct");
});
