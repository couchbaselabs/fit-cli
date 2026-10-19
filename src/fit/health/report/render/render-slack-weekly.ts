/**
 * The Slack message for a weekly wrap-up: one headline for the channel, a line per SDK with its
 * failing count and what moved, and the tests per SDK as a reply in its thread.
 *
 * Like the page, it states facts and never a verdict: counts and names, in the page's order (not
 * ranked by count). An SDK with no results all week always gets its own line: that is the one
 * thing a reader can't afford to miss.
 *
 * Slack mrkdwn, not Markdown: *bold*, _italic_, <url|text> links.
 */
import { shortDate } from "../dates.js";
import type { Weekly, WeeklyCard, WeeklyTest } from "../weekly.js";
import { slackEscape, type SlackDigest } from "./render-slack.js";

/** Slack truncates long messages; keep each SDK's lists readable and well inside the limit. */
const MAX_GROUPS = 5;

const n = (x: number) => x.toLocaleString("en-US");
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;

/** "Go Operational Insights" -> "Go OI": the headline names many SDKs on one line. */
export const shortName = (c: Pick<WeeklyCard, "name">) => c.name.replace(/ Operational Insights$/, " OI");

/** The cards in the page's order: its sections, then rows, then each row's SDKs. */
export function pageOrder(w: Pick<Weekly, "sections" | "cards">): WeeklyCard[] {
  const bySdk = new Map(w.cards.map((c) => [c.sdk, c]));
  return w.sections.flatMap((s) => s.rows.flatMap((r) => r.sdks.map((sdk) => bySdk.get(sdk)).filter((c): c is WeeklyCard => !!c)));
}

type Move = "started" | "newFailing" | "stopped" | "noLongerCounted";
const MOVES: { key: Move; label: string }[] = [
  { key: "started", label: "Started failing" },
  { key: "newFailing", label: "New tests failing" },
  { key: "stopped", label: "Stopped failing" },
  { key: "noLongerCounted", label: "No longer counted" },
];

/** Short names for the headline's counts. */
const SHORT: Record<Move, string> = { started: "started", newFailing: "new", stopped: "stopped", noLongerCounted: "no longer counted" };

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
    ...MOVES.filter(({ key }) => c[key].length).map(({ key }) => `${n(c[key].length)} ${SHORT[key]}`),
    ...(c.nightsWithResults < nights ? [`${c.nightsWithResults}/${nights} nights`] : []),
  ];
  return `• ${label}: ${parts.join(" · ")}`;
}

/** A list's tests grouped by class, series and night, as on the page: one line per group. */
function groups(tests: WeeklyTest[], key: Move): string[] {
  const out: { cls: string; where: string; night?: string; nights?: number; why?: string; methods: string[] }[] = [];
  for (const t of tests) {
    const dot = t.test.indexOf(".");
    const cls = dot < 0 ? t.test : t.test.slice(0, dot);
    const night = key === "started" || key === "newFailing" ? t.since : t.last;
    let g = out.find((x) => x.cls === cls && x.where === t.where && x.night === night && x.why === t.why);
    if (!g) out.push((g = { cls, where: t.where, night, nights: t.nights, why: t.why, methods: [] }));
    if (dot >= 0) g.methods.push(t.test.slice(dot + 1));
  }
  const lines = out.slice(0, MAX_GROUPS).map((g) => {
    const methods = g.methods.length > 6 ? `${g.methods.slice(0, 6).join(", ")} and ${g.methods.length - 6} more` : g.methods.join(", ");
    const name = g.methods.length === 1 ? `\`${slackEscape(`${g.cls}.${g.methods[0]}`)}\`` : `\`${slackEscape(g.cls)}\`${methods ? ` ${slackEscape(methods)}` : " (whole class)"}`;
    const when = key === "started" || key === "newFailing"
      ? `since ${shortDate(g.night!)}`
      : [g.why, g.night ? `last failed ${shortDate(g.night)}` : ""].filter(Boolean).join(", ");
    return `   ◦ ${name} — ${[when, slackEscape(g.where)].filter(Boolean).join(", ")}`;
  });
  if (out.length > MAX_GROUPS) lines.push(`   ◦ _…and ${plural(out.length - MAX_GROUPS, "more class", "more classes")} on the page_`);
  return lines;
}

/** Where a card's own section of the page is: the link opens it with its tests shown. */
const cardUrl = (weekUrl: string | undefined, c: WeeklyCard) => (weekUrl ? `${weekUrl}#sdk-${c.sdk}` : undefined);

export function renderSlackWeekly(w: Weekly, weekUrl?: string): SlackDigest {
  const cards = pageOrder(w);
  const quiet = cards.filter((c) => c.noChange);
  const span = `${shortDate(w.week.start)} to ${shortDate(w.week.end)}`;

  // One line per SDK with anything to say, in the page's order; the quiet ones are named together.
  const headline = [
    `*FIT weekly · ${w.week.id}* · ${span} · against ${w.previous.id}`,
    ...cards.filter((c) => !c.noChange).map((c) => sdkLine(c, w.dates.length, cardUrl(weekUrl, c))),
    ...(quiet.length ? [`• No change: ${quiet.map((c) => slackEscape(shortName(c))).join(", ")}`] : []),
    ...(weekUrl ? [`<${weekUrl}|Weekly report>`] : []),
  ].join("\n");

  // The thread: each SDK that moved, with what moved, linked to its card.
  const thread: string[] = [];
  for (const c of cards) {
    const moved = MOVES.filter(({ key }) => c[key].length);
    if (!moved.length) continue;
    const name = slackEscape(c.product === "SDK" ? `${c.name} SDK` : c.name);
    const url = cardUrl(weekUrl, c);
    const before = c.failingBefore === undefined ? "" : `${n(c.failingBefore)} → `;
    if (thread.length) thread.push("");
    thread.push(`*${url ? `<${url}|${name}>` : name}* · failing at week end ${before}${n(c.failing)}`);
    for (const { key, label } of moved) thread.push(`• ${label}: ${n(c[key].length)}`, ...groups(c[key], key));
  }
  if (!thread.length) thread.push("_No test started or stopped failing in any SDK this week._");
  thread.push("", "_Started failing: failing at week end, not last week, and passed before. New tests failing: the same, but never passed. Stopped failing: failing last week, passing now. No longer counted: failing last week, and not now, without passing._");
  return { headline, thread: thread.join("\n") };
}
