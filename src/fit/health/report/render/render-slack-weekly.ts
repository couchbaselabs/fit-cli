/**
 * The Slack message for a weekly wrap-up: one message, a line per SDK with its failing count, the
 * change since last week and its flaky tests, linked to the week's page. The tests themselves are
 * on the page, not in Slack.
 *
 * The SDKs are in the page's order, not ranked by count. An SDK with no results all week always
 * gets its own line: that is the one thing a reader can't afford to miss.
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

/**
 * One SDK's line: its failing count and the change since last week, its flaky tests, or that it
 * had no results. "Python: 21 failing (▲18) · 2 flaky · 6/7 nights"
 */
export function sdkLine(c: WeeklyCard, nights: number, url?: string): string {
  const name = slackEscape(shortName(c));
  const label = url ? `*<${url}|${name}>*` : `*${name}*`;
  if (!c.reported || c.nightsWithResults === 0) return `• ${label}: *no results all week*`;
  const d = c.failingBefore === undefined ? undefined : c.failing - c.failingBefore;
  const move = d === undefined ? "" : d === 0 ? " (no change)" : ` (${d > 0 ? "▲" : "▼"}${n(Math.abs(d))})`;
  const parts = [
    `${n(c.failing)} failing${move}`,
    ...(c.flaky.length ? [`${n(c.flaky.length)} flaky`] : []),
    ...(c.nightsWithResults < nights ? [`${c.nightsWithResults}/${nights} nights`] : []),
  ];
  return `• ${label}: ${parts.join(" · ")}`;
}

/** Where a card's own section of the page is: the link opens it with its tests shown. */
const cardUrl = (weekUrl: string | undefined, c: WeeklyCard) => (weekUrl ? `${weekUrl}#sdk-${c.sdk}` : undefined);

export function renderSlackWeekly(w: Weekly, weekUrl?: string): string {
  const cards = pageOrder(w);
  // Nothing moved and nothing flaky: named together on one line.
  const isQuiet = (c: WeeklyCard) => c.noChange && !c.flaky.length;
  const quiet = cards.filter(isQuiet);
  const span = `${shortDate(w.week.start)} to ${shortDate(w.week.end)}`;
  const title = `FIT weekly · ${w.week.id}`;

  // One line per SDK with anything to say, in the page's order; the quiet ones are named together.
  return [
    `*${weekUrl ? `<${weekUrl}|${title}>` : title}* · ${span} · against ${w.previous.id}`,
    ...cards.filter((c) => !isQuiet(c)).map((c) => sdkLine(c, w.dates.length, cardUrl(weekUrl, c))),
    ...(quiet.length ? [`• No change, nothing flaky: ${quiet.map((c) => slackEscape(shortName(c))).join(", ")}`] : []),
    ...(weekUrl ? [`<${weekUrl}|Open the weekly report>`] : []),
  ].join("\n");
}
