/**
 * Unit tests for the weekly Slack message.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/report/tests/render-slack-weekly.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderSlackWeekly, shortName } from "../render/render-slack-weekly.js";
import { isoWeek, type Weekly, type WeeklyCard } from "../weekly.js";

const W43 = isoWeek("2026-10-19");
const dates = Array.from({ length: 7 }, (_, k) => `2026-10-${19 + k}`);

function card(sdk: string, name: string, more: Partial<WeeklyCard> = {}): WeeklyCard {
  return {
    sdk,
    name,
    product: "SDK",
    reported: true,
    days: [],
    nightsWithResults: 7,
    started: [],
    newFailing: [],
    stopped: [],
    noLongerCounted: [],
    failing: 0,
    failingBefore: 0,
    noChange: false,
    ...more,
  };
}

function weekly(cards: WeeklyCard[]): Weekly {
  return {
    generatedAt: "2026-10-26T12:00:00.000Z",
    week: W43,
    previous: isoWeek("2026-10-12"),
    dates,
    // The page's order, not the cards' (name) order: Python's row comes first here.
    sections: [{ rows: cards.map((c) => ({ language: c.sdk, name: c.name, sdks: [c.sdk] })).reverse() }],
    cards,
  };
}

const t = (test: string, more = {}) => ({ test, series: "func", where: "on-prem", since: "2026-10-21", nights: 5, ...more });

test("the headline has a line per SDK with anything to say, in the page's order", () => {
  const w = weekly([
    card("go", "Go", { started: [t("A.x"), t("A.y")], newFailing: [t("N.x")], failing: 3 }),
    card("python", "Python", { stopped: [t("C.z", { last: "2026-10-20" })], failing: 1, failingBefore: 2 }),
    card("kotlin", "Kotlin", { noChange: true }),
    card("scala", "Scala", { noChange: true }),
  ]);
  const { headline } = renderSlackWeekly(w, "https://site/w/");
  const lines = headline.split("\n");
  assert.equal(lines[0], "*FIT weekly · 2026-W43* · 19 Oct to 25 Oct · against 2026-W42");
  assert.deepEqual(lines.slice(1), [
    "• *<https://site/w/#sdk-python|Python>*: failing 2 → 1 · 1 stopped",
    "• *<https://site/w/#sdk-go|Go>*: failing 0 → 3 · 2 started · 1 new",
    "• No change: Scala, Kotlin",
    "<https://site/w/|Weekly report>",
  ]);
});

test("an SDK with no results all week says so; one missing nights shows its count", () => {
  const w = weekly([card("rust", "Rust", { reported: false, nightsWithResults: 0 }), card("go", "Go", { nightsWithResults: 5 })]);
  const { headline } = renderSlackWeekly(w);
  assert.match(headline, /^• \*Rust\*: \*no results all week\*$/m);
  assert.match(headline, /^• \*Go\*: failing 0 → 0 · 5\/7 nights$/m);
});

test("the thread has a block per SDK that moved, linked to its card, with tests grouped by class", () => {
  const w = weekly([
    card("go", "Go", { started: [t("A.x"), t("A.y"), t("B.z")], failing: 3, failingBefore: 0 }),
    card("kotlin", "Kotlin", { noChange: true }),
  ]);
  const { thread } = renderSlackWeekly(w, "https://site/w/");
  assert.match(thread, /^\*<https:\/\/site\/w\/#sdk-go\|Go SDK>\* · failing at week end 0 → 3$/m);
  assert.match(thread, /^• Started failing: 3$/m);
  assert.match(thread, /^ {3}◦ `A` x, y — since 21 Oct, on-prem$/m);
  assert.match(thread, /^ {3}◦ `B.z` — since 21 Oct, on-prem$/m);
  assert.doesNotMatch(thread, /Kotlin/);
});

test("names are escaped for Slack, and Operational Insights is shortened in the headline", () => {
  assert.equal(shortName({ name: "Go Operational Insights" }), "Go OI");
  const w = weekly([card("go", "Go", { started: [t("A<b>.x&y")], failing: 1 })]);
  const { thread } = renderSlackWeekly(w);
  assert.match(thread, /`A&lt;b&gt;.x&amp;y`/);
});

test("a quiet week says so in the thread", () => {
  const { thread } = renderSlackWeekly(weekly([card("go", "Go", { noChange: true })]));
  assert.match(thread, /No test started or stopped failing in any SDK this week/);
});
