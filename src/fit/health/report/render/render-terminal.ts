/**
 * The terminal view of a health report: per active series, the class counts, then what
 * started and stopped failing in the last two weeks, then the tests failing now.
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

  const started = active.flatMap((s) => s.started.map((t) => ({ ...t, series: s.short })));
  const stopped = active.flatMap((s) => s.stopped.map((t) => ({ ...t, series: s.short })));
  lines.push("", `Started failing, last 14 days (${started.length}):`);
  for (const t of started) {
    lines.push(`  ${t.series.padEnd(26)} since ${t.since}  ${t.test}`);
  }
  lines.push("", `Stopped failing, last 14 days (${stopped.length}):`);
  for (const t of stopped) lines.push(`  ${t.series.padEnd(26)} last ${t.last}  ${t.test}${t.fix?.ticket ? `  (${t.fix.ticket})` : ""}`);
  const stoppedRunning = active.flatMap((s) => s.stoppedRunning.map((t) => ({ ...t, series: s.short })));
  if (stoppedRunning.length) {
    lines.push("", `Stopped running, last 14 days (${stoppedRunning.length}):`);
    for (const t of stoppedRunning) lines.push(`  ${t.series.padEnd(26)} not run since ${t.since}  ${t.test}`);
  }

  lines.push("", "Failing now:");
  for (const s of active) {
    for (const t of s.tests.filter((x) => x.cls === "always" || x.cls === "failing")) {
      const tag = t.cls === "always" ? "always" : `since ${t.since}`;
      lines.push(`  ${s.short.padEnd(26)} ${tag.padEnd(17)} ${t.test}`);
    }
  }

  for (const c of report.comparisons) {
    const a = report.series.find((s) => s.id === c.a)!;
    const b = report.series.find((s) => s.id === c.b)!;
    lines.push("", `${a.short} vs ${b.short} (${c.param}), ${c.nights} common nights: red ${c.aRed} vs ${c.bRed}, both ${c.bothRed}`);
  }
  if (report.source.unreadableRuns.length) {
    lines.push("", `Runs with no usable log: ${report.source.unreadableRuns.map((r) => `${r.date} (${r.status})`).join(", ")}`);
  }
  return lines.join("\n");
}
