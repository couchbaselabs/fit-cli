/**
 * The health report as GitHub-flavoured Markdown, for the health workflow's job summary: the
 * same content as the Slack digest (report.digest) - what started and stopped failing, what
 * fails every night - plus a row per series, so the workflow run page shows the result
 * without opening an artifact.
 */
import type { HealthReport, ReportSeries } from "../build-report.js";
import { shortDate } from "../dates.js";
import { testMethod } from "../digest.js";

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

const RESULT = { p: "passed", f: "failed", e: "errored" } as const;

/** Tests, not test cases (a test can run as many cases); "-" when the night's passes aren't known. */
function testsRun(s: ReportSeries): string {
  const l = s.latest;
  if (!l || !l.usable || l.tests == null) return "-";
  return `${(l.passed! + l.failing).toLocaleString("en-US")} (${l.skipped!.toLocaleString("en-US")} skipped)`;
}

export function renderMarkdown(report: HealthReport, sdkName: string): string {
  const d = report.digest;
  const recent = report.classes.recentDays;
  const active = report.series.filter((s) => s.active);
  const lines: string[] = [
    `## ${sdkName} FIT health · as of ${shortDate(report.end)}`,
    "",
    `${report.source.records} run records over ${report.dates.length} nights (last ${report.classes.windowDays} days classified).`,
    "",
    `| Series | Failing now | Started (${recent}d) | Stopped (${recent}d) | Intermittent | Tests run, last night |`,
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...active.map((s) => `| ${s.label} | ${s.counts.always + s.counts.failing} | ${s.started.length} | ${s.stopped.length} | ${s.counts.intermittent} | ${testsRun(s)} |`),
  ];
  if (d.startedGroups.length) lines.push("", `### Started failing (last ${recent} days)`, "", ...d.startedGroups.map((g) => `- ${code(g.cls)} ${g.tests.map(testMethod).join(", ")} since ${shortDate(g.since)} (${g.where})`));
  if (d.stoppedTests.length) lines.push("", `### Stopped failing (last ${recent} days)`, "", ...d.stoppedTests.map((t) => `- ${code(t.test)} last failed ${shortDate(t.last)} (${t.where})${t.fix?.ticket ? ` - ${t.fix.ticket}` : ""}`));
  if (d.stoppedRunning.length) lines.push("", `### Stopped running (last ${recent} days)`, "", ...d.stoppedRunning.map((t) => `- ${code(t.test)} not run since ${shortDate(t.since)}, last ran ${shortDate(t.lastRan)} (${RESULT[t.lastResult]}) (${t.where})`));
  if (d.always.length) lines.push("", `### Failed every night they ran in the last ${report.classes.windowDays} days`, "", ...d.always.map((t) => `- ${code(t.test)} (${t.where})`));
  if (d.gaps.length || d.unreadableRuns.length) {
    lines.push("", `_Nights with no usable results: ${d.gaps.map(shortDate).join(", ") || "none"}. Runs with no readable log: ${d.unreadableRuns.map((r) => shortDate(r.date)).join(", ") || "none"}._`);
  }
  return lines.join("\n") + "\n";
}
