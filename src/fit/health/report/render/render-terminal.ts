/**
 * The terminal view of a health report: per active series, the class counts; then what
 * started and stopped failing in the recent window (the digest); then each active series'
 * tests failing now.
 */
import type { HealthReport } from "../build-report.js";
import { CLASS_LABELS, CLASS_ORDER } from "../classify.js";

export function renderTerminal(report: HealthReport): string {
  const lines: string[] = [];
  const active = report.series.filter((s) => s.active);
  lines.push(`${report.sdk} FIT health · ${report.start} → ${report.end} · ${report.dates.length} nights · ${report.source.records} run records`);
  lines.push("");

  const shown = CLASS_ORDER.filter((c) => c !== "dormant");
  const width = Math.max(...active.map((s) => s.label.length), 10);
  const col = Math.max(...shown.map((c) => CLASS_LABELS[c].length)) + 2;
  lines.push(`${"".padEnd(width)}${shown.map((c) => CLASS_LABELS[c].padStart(col)).join("")}`);
  for (const s of active) {
    lines.push(`${s.label.padEnd(width)}${shown.map((c) => String(s.counts[c] || "·").padStart(col)).join("")}`);
  }

  // The functional series' changes, as the page and Slack list them (report.digest).
  const d = report.digest;
  lines.push("", `Started failing, last ${report.classes.recentDays} days (${d.started.total}):`);
  for (const g of d.startedGroups) for (const t of g.tests) lines.push(`  ${g.where.padEnd(26)} since ${g.since}  ${t}`);
  lines.push("", `Stopped failing, last ${report.classes.recentDays} days (${d.stoppedTests.length}):`);
  for (const t of d.stoppedTests) lines.push(`  ${t.where.padEnd(26)} last ${t.last}  ${t.test}${t.fix?.ticket ? `  (${t.fix.ticket})` : ""}`);
  if (d.stoppedRunning.length) {
    lines.push("", `Stopped running, last ${report.classes.recentDays} days (${d.stoppedRunning.length}):`);
    for (const t of d.stoppedRunning) lines.push(`  ${t.where.padEnd(26)} not run since ${t.since}  ${t.test}`);
  }

  lines.push("", "Failing now:");
  for (const s of active) {
    for (const t of s.tests.filter((x) => x.cls === "always" || x.cls === "failing")) {
      const tag = t.cls === "always" ? "always" : t.sinceFirstNight ? `since first night` : `since ${t.since}`;
      lines.push(`  ${s.short.padEnd(26)} ${tag.padEnd(17)} ${t.test}`);
    }
  }

  for (const c of report.comparisons) {
    const a = report.series.find((s) => s.id === c.a)!;
    const b = report.series.find((s) => s.id === c.b)!;
    lines.push("", `${a.short} vs ${b.short} (${c.param}), ${c.nights} common nights: red ${c.aRed} vs ${c.bRed}, both ${c.bothRed}`);
  }
  if (d.unreadableRuns.length) {
    lines.push("", `Runs with no usable log: ${d.unreadableRuns.map((r) => `${r.date} (${r.status})`).join(", ")}`);
  }
  return lines.join("\n");
}
