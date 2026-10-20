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
    newlyFailing: [],
    noLongerFailing: [],
    flaky: [],
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

test("one message: a line per SDK with anything to say, in the page's order, and the page linked", () => {
  const w = weekly([
    card("go", "Go", { newlyFailing: [t("A.x"), t("A.y"), t("N.x")], failing: 3 }),
    card("python", "Python", { noLongerFailing: [t("C.z", { last: "2026-10-20" })], failing: 1, failingBefore: 2 }),
    card("java", "Java", { noChange: true, failing: 4, failingBefore: 4, flaky: [t("F.x")] }),
    card("kotlin", "Kotlin", { noChange: true }),
    card("scala", "Scala", { noChange: true }),
  ]);
  assert.deepEqual(renderSlackWeekly(w, "https://site/w/").split("\n"), [
    "*<https://site/w/|FIT weekly · 2026-W43>* · 19 Oct to 25 Oct · against 2026-W42",
    "• *<https://site/w/#sdk-java|Java>*: 4 failing (no change) · 1 flaky",
    "• *<https://site/w/#sdk-python|Python>*: 1 failing (▼1)",
    "• *<https://site/w/#sdk-go|Go>*: 3 failing (▲3)",
    "• No change, nothing flaky: Scala, Kotlin",
    "<https://site/w/|Open the weekly report>",
  ]);
});

test("with no address for the site, the message has no links", () => {
  const text = renderSlackWeekly(weekly([card("go", "Go", { newlyFailing: [t("A.x")], failing: 1 })]));
  assert.doesNotMatch(text, /<|>/);
  assert.match(text, /^\*FIT weekly · 2026-W43\* · /);
});

test("an SDK with no results all week says so; one missing nights shows its count", () => {
  const w = weekly([card("rust", "Rust", { reported: false, nightsWithResults: 0 }), card("go", "Go", { nightsWithResults: 5 })]);
  const text = renderSlackWeekly(w);
  assert.match(text, /^• \*Rust\*: \*no results all week\*$/m);
  assert.match(text, /^• \*Go\*: 0 failing \(no change\) · 5\/7 nights$/m);
});

test("names are escaped for Slack, and Operational Insights is shortened", () => {
  assert.equal(shortName({ name: "Go Operational Insights" }), "Go OI");
  const text = renderSlackWeekly(weekly([card("go", "A<b>&c", { newlyFailing: [t("A.x")], failing: 1 })]));
  assert.match(text, /\*A&lt;b&gt;&amp;c\*/);
});
