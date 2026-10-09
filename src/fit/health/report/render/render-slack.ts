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
import { testMethod, type DigestCount } from "../digest.js";

export interface SlackDigest {
  headline: string;
  thread: string;
}

/** Slack truncates long messages; keep each list readable and well inside the limit. */
const MAX_ITEMS = 15;

/** Escape the three characters Slack treats as control characters in message text. */
export function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function list(items: string[]): string[] {
  const shown = items.slice(0, MAX_ITEMS).map((i) => `• ${i}`);
  if (items.length > MAX_ITEMS) shown.push(`• _…and ${items.length - MAX_ITEMS} more (see the full report)_`);
  return shown;
}

const n = (x: number) => x.toLocaleString("en-US");
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
  const headline = [
    `*${slackEscape(sdkName)} FIT health* · as of ${shortDate(report.end)} · last ${report.classes.windowDays} days`,
    `• Failing now: *${d.failingNow.total}* (${split(d.failingNow)})`,
    ...(last ? [`• Last night: *${n(last.tests)}* tests ran (${last.bySeries.map((x) => `${n(x.tests)} ${x.series}`).join(" · ")}) · ${n(last.skipped)} skipped`] : []),
    `• Last ${recent} days: *${d.started.total}* started failing · *${d.stopped.total}* stopped · *${d.intermittent.total}* intermittent`,
    ...(caveats.length ? [`_Data: ${caveats.join("; ")}._`] : []),
    ...(reportUrl ? [`<${reportUrl}|Full report>`] : []),
  ].join("\n");

  const thread: string[] = [];
  if (d.startedGroups.length) {
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
