/**
 * The Slack message for a weekly wrap-up: one message, a line per SDK with its failing count and
 * what moved, linked to the week's page. The tests themselves are on the page, not in Slack.
 *
 * Like the page, it states facts and never a verdict: counts and names, in the page's order (not
 * ranked by count). An SDK with no results all week always gets its own line: that is the one
 * thing a reader can't afford to miss.
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

type Move = "started" | "newFailing" | "stopped" | "noLongerCounted";
/** What moved, in the page's tile order, as the message names it. */
const MOVES: { key: Move; label: string }[] = [
  { key: "started", label: "started" },
  { key: "newFailing", label: "new" },
  { key: "stopped", label: "stopped" },
  { key: "noLongerCounted", label: "no longer counted" },
];

/**
 * One SDK's headline line: its failing count and what moved, or that it had no results.
 * "Python: failing 3 → 21 · 15 started · 3 new"
 */
export function sdkLine(c: WeeklyCard, nights: number, url?: string): string {
  const name = slackEscape(shortName(c));
  const label = url ? `*<${url}|${name}>*` : `*${name}*`;
  if (!c.reported || c.nightsWithResults === 0) return `• ${label}: *no results all week*`;
  const before = c.failingBefore === undefined ? "" : `${n(c.failingBefore)} → `;
  const parts = [
    `failing ${before}${n(c.failing)}`,
    ...MOVES.filter(({ key }) => c[key].length).map(({ key, label }) => `${n(c[key].length)} ${label}`),
    ...(c.nightsWithResults < nights ? [`${c.nightsWithResults}/${nights} nights`] : []),
  ];
  return `• ${label}: ${parts.join(" · ")}`;
}

/** Where a card's own section of the page is: the link opens it with its tests shown. */
const cardUrl = (weekUrl: string | undefined, c: WeeklyCard) => (weekUrl ? `${weekUrl}#sdk-${c.sdk}` : undefined);

export function renderSlackWeekly(w: Weekly, weekUrl?: string): string {
  const cards = pageOrder(w);
  const quiet = cards.filter((c) => c.noChange);
  const span = `${shortDate(w.week.start)} to ${shortDate(w.week.end)}`;
  const title = `FIT weekly · ${w.week.id}`;

  // One line per SDK with anything to say, in the page's order; the quiet ones are named together.
  return [
    `*${weekUrl ? `<${weekUrl}|${title}>` : title}* · ${span} · against ${w.previous.id}`,
    ...cards.filter((c) => !c.noChange).map((c) => sdkLine(c, w.dates.length, cardUrl(weekUrl, c))),
    ...(quiet.length ? [`• No change: ${quiet.map((c) => slackEscape(shortName(c))).join(", ")}`] : []),
    ...(weekUrl ? [`<${weekUrl}|Open the weekly report>`] : []),
  ].join("\n");
}
