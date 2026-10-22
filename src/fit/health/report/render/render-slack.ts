/**
 * The Slack digest of a health report: one short headline message for the channel, and the
 * detail as a reply in its thread, so a channel reads one line per report.
 *
 * Changes, not the whole report - a nightly that is red every night makes a full list
 * noise. And it never claims more health than the data shows: every digest states the
 * window it covers and any nights with no usable results.
 *
 * Slack mrkdwn, not Markdown: *bold*, _italic_, <url|text> links.
 */
import type { HealthReport } from "../build-report.js";
import { shortDate } from "../dates.js";
import { testMethod, type DigestCount, type FailedLastNight } from "../digest.js";

export interface SlackDigest {
  headline: string;
  thread: string;
}

/** Slack truncates long messages; keep each list readable and well inside the limit. */
const MAX_ITEMS = 15;

/** Escape the three characters Slack treats as control characters in message text. */
/** "Tue 20 Oct": a night is a UTC date. */
export const weekdayDate = (date: string) => `${new Date(`${date}T00:00:00Z`).toLocaleString("en-US", { timeZone: "UTC", weekday: "short" })} ${shortDate(date)}`;

/**
 * A moment as Slack shows it in each reader's own time zone ("Wed 21 Oct at 2:38 PM"), with the
 * UTC time as the fallback for clients that can't.
 */
export function slackLocalTime(iso: string): string {
  const t = new Date(iso);
  const fallback = `${t.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return `<!date^${Math.floor(t.getTime() / 1000)}^{date_short_pretty} at {time}|${fallback}>`;
}

export function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function list(items: string[]): string[] {
  const shown = items.slice(0, MAX_ITEMS).map((i) => `• ${i}`);
  if (items.length > MAX_ITEMS) shown.push(`• _…and ${items.length - MAX_ITEMS} more (see the full report)_`);
  return shown;
}

const n = (x: number) => x.toLocaleString("en-US");
/** What a test that failed last night is, in the headline's terms. */
const KIND: Partial<Record<FailedLastNight["tests"][number]["cls"], string>> = {
  always: "persistent: fails every night",
  failing: "persistent: 3+ nights in a row",
  new: "new",
  intermittent: "intermittent",
};
const split = (c: DigestCount) => c.bySeries.map((x) => `${x.n} ${x.series}`).join(" · ");

export function renderSlackDigest(report: HealthReport, sdkName: string, reportUrl?: string): SlackDigest {
  const d = report.digest;
  const recent = report.classes.recentDays;

  // What the data can't vouch for, stated every time.
  const caveats = [
    d.gaps.length && `${d.gaps.length} night${d.gaps.length > 1 ? "s" : ""} with no usable results (${d.gaps.map(shortDate).join(", ")})`,
    d.unreadableRuns.length && `${d.unreadableRuns.length} run${d.unreadableRuns.length > 1 ? "s" : ""} with no readable log`,
  ].filter(Boolean);

  const last = d.lastNight;
  const failed = d.failedLastNight;
  const ran = last ? ` of ${n(last.tests)} run · ${n(last.skipped)} skipped${failed?.atLeast ? " (series with full results)" : ""}` : "";
  const headline = [
    `*${slackEscape(sdkName)} FIT health* · nightly run of ${weekdayDate(report.end)} (UTC date) · updated ${slackLocalTime(report.generatedAt)} · last ${report.classes.windowDays} days`,
    ...(failed
      ? [
          `• Failed last night: *${failed.atLeast ? "at least " : ""}${failed.total}*${ran} (${split(failed)})` +
            ` — ${failed.persistent} persistent · ${failed.new} new · ${failed.intermittent} intermittent`,
        ]
      : []),
    `• Last ${recent} days: *${d.started.total}* started failing · *${d.stopped.total}* stopped · last ${report.classes.windowDays} days: *${d.intermittent.total}* intermittent`,
    ...(caveats.length ? [`_Data: ${caveats.join("; ")}._`] : []),
    ...(reportUrl ? [`<${reportUrl}|Full report>`] : []),
  ].join("\n");

  const thread: string[] = [];
  if (failed?.tests.length) {
    thread.push(`*Failed last night*`);
    thread.push(...list(failed.tests.map((t) => `\`${slackEscape(t.test)}\` — ${KIND[t.cls] ?? t.cls}, ${t.where}`)));
  }
  if (d.startedGroups.length) {
    if (thread.length) thread.push("");
    thread.push(`*Started failing (last ${recent} days)*`);
    thread.push(...list(d.startedGroups.map((g) => `\`${g.cls}\` ${slackEscape(g.tests.map(testMethod).join(", "))} — since ${shortDate(g.since)}, ${g.where}`)));
  }
  if (d.stoppedTests.length) {
    thread.push("", `*Stopped failing (last ${recent} days)*`);
    thread.push(...list(d.stoppedTests.map((t) => `\`${slackEscape(t.test)}\` — last failed ${shortDate(t.last)}, ${t.where}${t.fix?.ticket ? ` (${t.fix.ticket})` : ""}`)));
  }
  if (d.stoppedRunning.length) {
    thread.push("", `*Stopped running (last ${recent} days)*`);
    thread.push(...list(d.stoppedRunning.map((t) => `\`${slackEscape(t.test)}\` — not run since ${shortDate(t.since)}, ${t.where}`)));
  }
  if (d.always.length) thread.push("", `*Failed every night they ran in the last ${report.classes.windowDays} days*`, ...list(d.always.map((t) => `\`${slackEscape(t.test)}\` — ${t.where}`)));
  for (const c of report.comparisons) {
    const a = report.series.find((s) => s.id === c.a)!;
    const b = report.series.find((s) => s.id === c.b)!;
    thread.push("", `*${a.short} vs ${b.short}*`, `• Nights with any failure: ${c.aRed}/${c.nights} vs ${c.bRed}/${c.nights} (both on ${c.bothRed})`);
  }
  if (!thread.length) thread.push(`_Nothing started or stopped failing in the last ${recent} days._`);
  return { headline, thread: thread.join("\n") };
}
