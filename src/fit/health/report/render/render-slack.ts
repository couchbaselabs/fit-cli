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
import type { HealthReport, ReportSeries } from "../build-report.js";
import { addDays, shortDate } from "../dates.js";

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

/** Group tests of one class that changed on the same night, as the page does. */
function grouped<T extends { test: string }>(items: (T & { where: string })[], key: (t: T) => string): { cls: string; tests: string[]; first: T & { where: string } }[] {
  const out: { cls: string; tests: string[]; first: T & { where: string } }[] = [];
  for (const t of items) {
    const dot = t.test.indexOf(".");
    const cls = dot < 0 ? t.test : t.test.slice(0, dot);
    const g = out.find((x) => x.cls === cls && key(x.first) === key(t) && x.first.where === t.where);
    if (g) g.tests.push(t.test);
    else out.push({ cls, tests: [t.test], first: t });
  }
  return out;
}

/** The method part of each test id; a bare class name is a class-level error. */
const methods = (tests: string[]) => tests.map((t) => (t.includes(".") ? t.slice(t.indexOf(".") + 1) : "(whole class)"));

/** "Last night: 2,412 tests ran (1,584 on-prem · 828 CNG) · 410 skipped", counted in tests, not test cases. */
export function lastNightTests(series: ReportSeries[]): string[] {
  // Only nights that are last night and usable: a preset that missed it, or had a bad one, isn't counted.
  const known = series.filter((s) => s.latest?.usable && s.latest.tests != null);
  if (!known.length) return [];
  const ran = (s: ReportSeries) => s.latest!.passed! + s.latest!.failing;
  const n = (x: number) => x.toLocaleString("en-US");
  const total = known.reduce((a, s) => a + ran(s), 0);
  const skipped = known.reduce((a, s) => a + s.latest!.skipped!, 0);
  return [`• Last night: *${n(total)}* tests ran (${known.map((s) => `${n(ran(s))} ${s.short}`).join(" · ")}) · ${n(skipped)} skipped`];
}

export function renderSlackDigest(report: HealthReport, sdkName: string, reportUrl?: string): SlackDigest {
  const func = report.series.filter((s) => s.active && s.kind === "functional");
  const sum = (f: (s: ReportSeries) => number) => func.reduce((a, s) => a + f(s), 0);
  const split = (f: (s: ReportSeries) => number) => func.map((s) => `${f(s)} ${s.short}`).join(" · ");
  const failingNow = (s: ReportSeries) => s.counts.always + s.counts.failing;

  const started = func.flatMap((s) => s.started.map((t) => ({ ...t, where: s.short })));
  const stopped = func.flatMap((s) => s.stopped.map((t) => ({ ...t, where: s.short })));

  // What the data can't vouch for, stated every time.
  const recent = report.classes.recentDays;
  const windowStart = addDays(report.end, -(report.classes.windowDays - 1));
  const gaps = report.blackout.filter((d) => d >= windowStart);
  const unreadable = report.source.unreadableRuns.filter((r) => r.date >= windowStart);
  const caveats = [
    gaps.length && `${gaps.length} night${gaps.length > 1 ? "s" : ""} with no usable results (${gaps.map(shortDate).join(", ")})`,
    unreadable.length && `${unreadable.length} run${unreadable.length > 1 ? "s" : ""} with no readable log`,
  ].filter(Boolean);

  const headline = [
    `*${slackEscape(sdkName)} FIT health* · as of ${shortDate(report.end)} · last ${report.classes.windowDays} days`,
    `• Failing now: *${sum(failingNow)}* (${split(failingNow)})`,
    ...lastNightTests(func),
    `• Last ${recent} days: *${started.length}* started failing · *${stopped.length}* stopped · *${sum((s) => s.counts.intermittent)}* intermittent`,
    ...(caveats.length ? [`_Data: ${caveats.join("; ")}._`] : []),
    ...(reportUrl ? [`<${reportUrl}|Full report>`] : []),
  ].join("\n");

  const thread: string[] = [];
  if (started.length) {
    thread.push(`*Started failing (last ${recent} days)*`);
    thread.push(
      ...list(
        grouped(started, (t) => t.since).map((g) => {
          return `\`${g.cls}\` ${slackEscape(methods(g.tests).join(", "))} — since ${shortDate(g.first.since)}, ${g.first.where}`;
        }),
      ),
    );
  }
  if (stopped.length) {
    thread.push("", `*Stopped failing (last ${recent} days)*`);
    thread.push(...list(stopped.map((t) => `\`${slackEscape(t.test)}\` — last failed ${shortDate(t.last)}, ${t.where}${t.fix?.ticket ? ` (${t.fix.ticket})` : ""}`)));
  }
  const stoppedRunning = func.flatMap((s) => s.stoppedRunning.map((t) => ({ ...t, where: s.short })));
  if (stoppedRunning.length) {
    thread.push("", `*Stopped running (last ${recent} days)*`);
    thread.push(...list(stoppedRunning.map((t) => `\`${slackEscape(t.test)}\` — not run since ${shortDate(t.since)}, ${t.where}`)));
  }
  const chronic = func.flatMap((s) => s.tests.filter((t) => t.cls === "always").map((t) => `\`${slackEscape(t.test)}\` — ${s.short}`));
  if (chronic.length) thread.push("", `*Failed every night they ran in the last ${report.classes.windowDays} days*`, ...list(chronic));
  for (const c of report.comparisons) {
    const a = report.series.find((s) => s.id === c.a)!;
    const b = report.series.find((s) => s.id === c.b)!;
    thread.push("", `*${a.short} vs ${b.short}*`, `• Nights with any failure: ${c.aRed}/${c.nights} vs ${c.bRed}/${c.nights} (both on ${c.bothRed})`);
  }
  if (!thread.length) thread.push(`_Nothing started or stopped failing in the last ${recent} days._`);
  return { headline, thread: thread.join("\n") };
}
