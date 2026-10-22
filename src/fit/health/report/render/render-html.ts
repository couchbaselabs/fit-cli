/**
 * Render a health report as a self-contained HTML page: the template plus the report JSON,
 * nothing fetched at view time except fonts.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HealthReport } from "../build-report.js";
import type { Overview } from "../overview.js";
import type { WeekEntry, Weekly } from "../weekly.js";

/**
 * Dev mode (bun run): read the template from disk. Compiled binary (/$bunfs/): embedded via a
 * static import() call - the path and options must be literals for `bun build --compile` to
 * see and embed it (same convention as presets/*.json5 in generate-preset.ts).
 */
async function loadTemplate(): Promise<string> {
  if (!import.meta.url.includes("/$bunfs/")) {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "health-report.template.html"), "utf8");
  }
  return (await import("./health-report.template.html", { with: { type: "text" } })).default;
}

/**
 * Fill the template. The JSON is made safe to sit inside a <script> element. `testsSeen` is
 * left out: only other SDKs' reports read it, and it is the largest part the page never uses.
 */
export function fillTemplate(template: string, report: HealthReport, sdkName: string): string {
  const { testsSeen: _unused, ...page } = report;
  const json = JSON.stringify(page).replace(/</g, "\\u003c");
  return template.replaceAll("__SDK_NAME__", sdkName).replace("/*__DATA__*/null", () => json);
}

export async function renderHtml(report: HealthReport, sdkName: string): Promise<string> {
  return fillTemplate(await loadTemplate(), report, sdkName);
}

async function loadOverviewTemplate(): Promise<string> {
  if (!import.meta.url.includes("/$bunfs/")) {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "health-overview.template.html"), "utf8");
  }
  return (await import("./health-overview.template.html", { with: { type: "text" } })).default;
}

export function fillOverviewTemplate(template: string, overview: Overview): string {
  const json = JSON.stringify(overview).replace(/</g, "\\u003c");
  return template.replace("/*__DATA__*/null", () => json);
}

/** The site's top page: every SDK's last nights, one chart each. */
export async function renderOverviewHtml(overview: Overview): Promise<string> {
  return fillOverviewTemplate(await loadOverviewTemplate(), overview);
}

async function loadWeeklyTemplate(): Promise<string> {
  if (!import.meta.url.includes("/$bunfs/")) {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "health-weekly.template.html"), "utf8");
  }
  return (await import("./health-weekly.template.html", { with: { type: "text" } })).default;
}

export function fillWeeklyTemplate(template: string, weekly: Weekly): string {
  const json = JSON.stringify(weekly).replace(/</g, "\\u003c");
  return template.replaceAll("__WEEK__", weekly.week.id).replace("/*__DATA__*/null", () => json);
}

/** A week's wrap-up page: each SDK's week against the week before. */
export async function renderWeeklyHtml(weekly: Weekly): Promise<string> {
  return fillWeeklyTemplate(await loadWeeklyTemplate(), weekly);
}

async function loadWeeklyIndexTemplate(): Promise<string> {
  if (!import.meta.url.includes("/$bunfs/")) {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "health-weekly-index.template.html"), "utf8");
  }
  return (await import("./health-weekly-index.template.html", { with: { type: "text" } })).default;
}

/** The list of every week's wrap-up, newest first. */
export async function renderWeeklyIndexHtml(weeks: WeekEntry[]): Promise<string> {
  const json = JSON.stringify({ weeks }).replace(/</g, "\\u003c");
  return (await loadWeeklyIndexTemplate()).replace("/*__DATA__*/null", () => json);
}
