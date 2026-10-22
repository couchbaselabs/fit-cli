/**
 * The Slack message for a weekly wrap-up: one message, grouped as the page's summary is, by where
 * each SDK stands at the week's end. Its first line, which is what a notification shows, counts
 * the SDKs in each state. Each failing SDK has a line: its failing count of the tests run, the
 * change since last week, its flaky tests. The flaky-only, clean and no-results SDKs are named on
 * a line per state. The tests themselves are on the page, not in Slack.
 *
 * The SDKs are in the page's order within a state, not ranked by count.
 *
 * Slack mrkdwn, not Markdown: *bold*, _italic_, <url|text> links.
 */
import { shortDate } from "../dates.js";
import type { Weekly, WeeklyCard } from "../weekly.js";
import { slackEscape } from "./render-slack.js";

const n = (x: number) => x.toLocaleString("en-US");

/** "Go Operational Insights" -> "Go OI": the headline names many SDKs on one line. */
export const shortName = (c: Pick<WeeklyCard, "name">) => c.name.replace(/ Operational Insights$/, " OI");

/** The cards in the page's order: its sections, then rows, then each row's SDKs. */
export function pageOrder(w: Pick<Weekly, "sections" | "cards">): WeeklyCard[] {
  const bySdk = new Map(w.cards.map((c) => [c.sdk, c]));
  return w.sections.flatMap((s) => s.rows.flatMap((r) => r.sdks.map((sdk) => bySdk.get(sdk)).filter((c): c is WeeklyCard => !!c)));
}

/** Where an SDK stands at the week's end, as the page's badges say it. */
export type WeeklyState = "fail" | "flaky" | "pass" | "none";
export const stateOf = (c: WeeklyCard): WeeklyState => (!c.reported || !c.nightsWithResults ? "none" : c.failing ? "fail" : c.flaky.length ? "flaky" : "pass");

/** Each state's emoji and word. The emoji differ in shape as well as color, so they read without color. */
const STATES: Record<WeeklyState, { emoji: string; word: string }> = {
  fail: { emoji: ":x:", word: "failing" },
  flaky: { emoji: ":warning:", word: "flaky only" },
  pass: { emoji: ":white_check_mark:", word: "clean" },
  none: { emoji: ":heavy_minus_sign:", word: "no results all week" },
};

const nightsNote = (c: WeeklyCard, nights: number) => (c.nightsWithResults < nights ? `${c.nightsWithResults}/${nights} nights` : "");

/** The change since last week, in words: Slack text has no color, so the arrow's shape and the word carry it. */
function moveText(c: WeeklyCard): string {
  if (c.failingBefore === undefined) return "";
  const d = c.failing - c.failingBefore;
  return d === 0 ? "same as last week" : `${d > 0 ? "▲" : "▼"} ${n(Math.abs(d))} ${d > 0 ? "more" : "fewer"} than last week`;
}

/** A failing SDK's line: "• C++: *124 failing* of 1,629 · 1 more flaky · ▲ 3 more than last week" */
export function failingLine(c: WeeklyCard, nights: number, url?: string): string {
  const name = slackEscape(shortName(c));
  const parts = [
    `*${n(c.failing)} failing*${c.testsRun ? ` of ${n(c.testsRun)}` : ""}`,
    // Not in the failing count, as "more" says.
    c.flaky.length ? `${n(c.flaky.length)} more flaky` : "",
    moveText(c),
    nightsNote(c, nights),
  ].filter(Boolean);
  return `• ${url ? `<${url}|${name}>` : name}: ${parts.join(" · ")}`;
}

/** An SDK named in a one-line group: its flaky count, and its nights if some had no results. */
function groupName(c: WeeklyCard, nights: number, url?: string): string {
  const name = slackEscape(shortName(c));
  const st = stateOf(c);
  const notes = [st === "flaky" ? n(c.flaky.length) : "", st === "none" ? "" : nightsNote(c, nights)].filter(Boolean);
  return `${url ? `<${url}|${name}>` : name}${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

/** Where a card's own section of the page is: the link opens it with its tests shown. */
const cardUrl = (weekUrl: string | undefined, c: WeeklyCard) => (weekUrl ? `${weekUrl}#sdk-${c.sdk}` : undefined);

export function renderSlackWeekly(w: Weekly, weekUrl?: string): string {
  const cards = pageOrder(w);
  const nights = w.dates.length;
  const by = (st: WeeklyState) => cards.filter((c) => stateOf(c) === st);
  const span = `${shortDate(w.week.start)} to ${shortDate(w.week.end)}`;
  const title = `FIT weekly · ${w.week.id}`;

  // The first line is what a notification shows: the week's answer, not only its title.
  const counts = (["fail", "flaky", "pass", "none"] as const)
    .filter((st) => by(st).length)
    .map((st) => `${STATES[st].emoji} ${by(st).length} ${STATES[st].word}`);
  const failing = by("fail");
  // The failing SDKs a line each, the rest a line per state; all in the page's order, not ranked.
  const groups = (["flaky", "pass", "none"] as const)
    .filter((st) => by(st).length)
    .map((st) => `${STATES[st].emoji} *${STATES[st].word[0].toUpperCase()}${STATES[st].word.slice(1)}:* ${by(st).map((c) => groupName(c, nights, cardUrl(weekUrl, c))).join(", ")}`);
  return [
    `*${weekUrl ? `<${weekUrl}|${title}>` : title}*: ${counts.join("  ")}`,
    `_${span}, against ${w.previous.id}_`,
    ...(failing.length ? ["", `${STATES.fail.emoji} *Failing*`, ...failing.map((c) => failingLine(c, nights, cardUrl(weekUrl, c)))] : []),
    ...(groups.length ? ["", ...groups] : []),
    ...(weekUrl ? ["", `<${weekUrl}|Open the weekly report>`] : []),
  ].join("\n");
}
