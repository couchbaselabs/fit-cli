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

test("one message, grouped by where each SDK stands, the counts first, in the page's order", () => {
  const w = weekly([
    card("go", "Go", { newlyFailing: [t("A.x"), t("A.y"), t("N.x")], failing: 3, testsRun: 1200 }),
    card("python", "Python", { failing: 1, failingBefore: 2, flaky: [t("F.y")] }),
    card("java", "Java", { noChange: true, failing: 4, failingBefore: 4 }),
    card("dotnet", ".NET", { flaky: [t("F.x"), t("F.z")] }),
    card("kotlin", "Kotlin", { noChange: true }),
    card("rust", "Rust", { reported: false, nightsWithResults: 0 }),
  ]);
  assert.deepEqual(renderSlackWeekly(w, "https://site/w/").split("\n"), [
    "*<https://site/w/|FIT weekly · 2026-W43>*: :x: 3 failing  :warning: 1 flaky only  :white_check_mark: 1 clean  :heavy_minus_sign: 1 no results all week",
    "_19 Oct to 25 Oct, against 2026-W42_",
    "",
    ":x: *Failing*",
    "• <https://site/w/#sdk-java|Java>: *4 failing* · same as last week",
    "• <https://site/w/#sdk-python|Python>: *1 failing* · 1 more flaky · ▼ 1 fewer than last week",
    "• <https://site/w/#sdk-go|Go>: *3 failing* of 1,200 · ▲ 3 more than last week",
    "",
    ":warning: *Flaky only:* <https://site/w/#sdk-dotnet|.NET> (2)",
    ":white_check_mark: *Clean:* <https://site/w/#sdk-kotlin|Kotlin>",
    ":heavy_minus_sign: *No results all week:* <https://site/w/#sdk-rust|Rust>",
    "",
    "<https://site/w/|Open the weekly report>",
  ]);
});

test("with no address for the site, the message has no links", () => {
  const text = renderSlackWeekly(weekly([card("go", "Go", { newlyFailing: [t("A.x")], failing: 1 })]));
  assert.doesNotMatch(text, /<|>/);
  assert.match(text, /^\*FIT weekly · 2026-W43\*: :x: 1 failing$/m);
});

test("a failing SDK with no failure last week says nothing of a change; missing nights are noted", () => {
  const w = weekly([card("go", "Go", { failing: 2, failingBefore: undefined, nightsWithResults: 5 }), card("dotnet", ".NET", { flaky: [t("F.x")], nightsWithResults: 6 })]);
  const text = renderSlackWeekly(w);
  assert.match(text, /^• Go: \*2 failing\* · 5\/7 nights$/m);
  assert.match(text, /^:warning: \*Flaky only:\* \.NET \(1, 6\/7 nights\)$/m);
});

test("an SDK with a report but no results all week is not clean", () => {
  const text = renderSlackWeekly(weekly([card("go", "Go", { nightsWithResults: 0 })]));
  assert.match(text, /^\*FIT weekly · 2026-W43\*: :heavy_minus_sign: 1 no results all week$/m);
  assert.doesNotMatch(text, /clean/);
});

test("names are escaped for Slack, and Operational Insights is shortened", () => {
  assert.equal(shortName({ name: "Go Operational Insights" }), "Go OI");
  const text = renderSlackWeekly(weekly([card("go", "A<b>&c", { failing: 1 })]));
  assert.match(text, /• A&lt;b&gt;&amp;c:/);
});
