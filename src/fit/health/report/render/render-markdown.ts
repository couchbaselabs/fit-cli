/**
 * The health report as GitHub-flavoured Markdown, for the health workflow's job summary: the
 * same content as the Slack digest - headline counts, what started and stopped failing, what
 * fails every night - so the workflow run page shows the result without opening an artifact.
 */
import type { HealthReport, ReportSeries } from "../build-report.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

const RESULT = { p: "passed", f: "failed", e: "errored" } as const;

/** Tests, not test cases (a test can run as many cases); "-" when the night's passes aren't known. */
function testsRun(s: ReportSeries): string {
  const l = s.latest;
  if (!l || !l.usable || l.tests == null) return "-";
  return `${(l.passed! + l.failing).toLocaleString("en-US")} (${l.skipped!.toLocaleString("en-US")} skipped)`;
}

export function renderMarkdown(report: HealthReport, sdkName: string): string {
  const active = report.series.filter((s) => s.active);
  const func = active.filter((s) => s.kind === "functional");
  const failingNow = (s: ReportSeries) => s.counts.always + s.counts.failing;
  const lines: string[] = [
    `## ${sdkName} FIT health · as of ${day(report.end)}`,
    "",
    `${report.source.records} run records over ${report.dates.length} nights (last ${report.classes.windowDays} days classified).`,
    "",
    "| Series | Failing now | Started (14d) | Stopped (14d) | Intermittent | Tests run, last night |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...active.map((s) => `| ${s.label} | ${failingNow(s)} | ${s.started.length} | ${s.stopped.length} | ${s.counts.intermittent} | ${testsRun(s)} |`),
  ];
  const started = func.flatMap((s) => s.started.map((t) => ({ ...t, where: s.short })));
  const stopped = func.flatMap((s) => s.stopped.map((t) => ({ ...t, where: s.short })));
  if (started.length) lines.push("", "### Started failing (last 14 days)", "", ...started.map((t) => `- ${code(t.test)} since ${day(t.since)} (${t.where})`));
  if (stopped.length) lines.push("", "### Stopped failing (last 14 days)", "", ...stopped.map((t) => `- ${code(t.test)} last failed ${day(t.last)} (${t.where})${t.fix?.ticket ? ` - ${t.fix.ticket}` : ""}`));
  const stoppedRunning = func.flatMap((s) => s.stoppedRunning.map((t) => ({ ...t, where: s.short })));
  if (stoppedRunning.length) lines.push("", "### Stopped running (last 14 days)", "", ...stoppedRunning.map((t) => `- ${code(t.test)} not run since ${day(t.since)}, last ran ${day(t.lastRan)} (${RESULT[t.lastResult]}) (${t.where})`));
  const always = func.flatMap((s) => s.tests.filter((t) => t.cls === "always").map((t) => `- ${code(t.test)} (${s.short})`));
  if (always.length) lines.push("", `### Failed every night they ran in the last ${report.classes.windowDays} days`, "", ...always);
  if (report.blackout.length || report.source.unreadableRuns.length) {
    lines.push("", `_Nights with no usable results: ${report.blackout.map(day).join(", ") || "none"}. Runs with no readable log: ${report.source.unreadableRuns.map((r) => day(r.date)).join(", ") || "none"}._`);
  }
  return lines.join("\n") + "\n";
}
