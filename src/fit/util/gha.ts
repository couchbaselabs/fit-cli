import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { junitToMarkdownFromDir } from "../shared/run-test-driver/junit-to-markdown.js";
import { renderScoresMarkdownTable, type SituationalScoreRow } from "../shared/run-test-driver/situational-results.js";

/** Current size of the $GITHUB_STEP_SUMMARY file in bytes, or -1 if missing/unset. */
function summaryFileSize(): number {
  const p = process.env.GITHUB_STEP_SUMMARY;
  if (!p || !existsSync(p)) return -1;
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
}
interface RunSummary {
  /** Rich path label (`aws1 / cbdino1 / java:main / func`), precomputed by the run loop. */
  pathLabel: string;
  sdk: string;
  ok: boolean;
  summary?: { testsRun: number; failures: number; errors: number; skipped: number };
  /** Local path to the surefire-reports dir for this run; appended as a JUnit table if present. */
  surefireDir?: string;
  /** Situational runs only: one row per `results/<runUuid>/` bundle's `scores.json5`. */
  situationalScores?: readonly SituationalScoreRow[];
}

/**
 * Build the collapsed `<details>` block for one run: the always-visible
 * `<summary>` line is `pathLabel (sdk) — status`, with the Metric/Value table
 * and any pre-rendered JUnit markdown collapsed inside it. Pure — callers own
 * the file I/O (reading surefireDir) and pass already-rendered markdown in,
 * so this stays unit-testable.
 */
export function renderRunSummaryBlock(args: {
  pathLabel: string;
  sdk: string;
  ok: boolean;
  summary?: { testsRun: number; failures: number; errors: number; skipped: number };
  /** Situational runs only: one row per `results/<runUuid>/` bundle's `scores.json5`. */
  situationalScores?: readonly SituationalScoreRow[];
  /** Pre-rendered via junitToMarkdownFromDir. */
  junitMarkdown?: string;
}): string {
  const { pathLabel, sdk, ok, summary, situationalScores, junitMarkdown } = args;
  const status = ok ? "✅ PASS" : "❌ FAIL";
  const lines: string[] = [];

  lines.push("<details>");
  lines.push(`<summary>${pathLabel} (${sdk}) — ${status}</summary>`);
  lines.push("");

  if (summary) {
    lines.push("| Metric | Value |");
    lines.push("|---|---|");
    lines.push(`| Tests run | ${summary.testsRun} |`);
    lines.push(`| Failures | ${summary.failures} |`);
    lines.push(`| Errors | ${summary.errors} |`);
    lines.push(`| Skipped | ${summary.skipped} |`);
    lines.push("");
  }

  if (situationalScores && situationalScores.length > 0) {
    lines.push(renderScoresMarkdownTable(situationalScores).trimEnd());
    lines.push("");
  }

  if (junitMarkdown) {
    lines.push(junitMarkdown.trimEnd());
    lines.push("");
  }

  lines.push("</details>");
  lines.push("");

  return lines.join("\n");
}

/**
 * Append a per-run result block to $GITHUB_STEP_SUMMARY. No-ops outside GHA.
 * Collapsed by default — one `<details>` block per run, its `<summary>` line
 * showing the pass/fail status so it's visible without expanding.
 */
export function appendRunSummaryToGhaSummary(result: RunSummary): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    console.log(`[gha-summary] appendRunSummaryToGhaSummary: GITHUB_STEP_SUMMARY unset — skipping`);
    return;
  }

  const { pathLabel, sdk, ok, summary, surefireDir, situationalScores } = result;
  const sizeBefore = summaryFileSize();

  let junitMarkdown: string | undefined;
  if (surefireDir) {
    try {
      junitMarkdown = junitToMarkdownFromDir(surefireDir);
    } catch (err) {
      console.warn(`Warning: failed to render JUnit table for "${pathLabel}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const block = renderRunSummaryBlock({ pathLabel, sdk, ok, summary, situationalScores, junitMarkdown });
  try {
    appendFileSync(summaryPath, "\n" + block + "\n");
    console.log(`[gha-summary] wrote per-run block for "${pathLabel}" to ${summaryPath} (file ${sizeBefore} → ${summaryFileSize()} bytes)`);
  } catch (err) {
    console.warn(`Warning: failed to append per-run GHA step summary block for "${pathLabel}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Prepend a "Run artifacts" section to the top of $GITHUB_STEP_SUMMARY with the
 * `fit archive fetch` command (and install instructions) so reviewers can pull the
 * run down locally. Collapsed by default. Prepended rather than appended since the
 * S3 URI is only known once the run finishes, after the per-run blocks are already
 * written — this is the only way to get it to the top of the summary. No-ops outside
 * GHA or when GITHUB_STEP_SUMMARY is unset.
 */
export function appendArtifactFetchToGhaSummary(s3Uri: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const block = [
    "<details>",
    "<summary>📦 Run artifacts (S3)</summary>",
    "",
    "Artifacts uploaded — download locally with:",
    "",
    "```sh",
    `fit archive fetch ${s3Uri}`,
    "```",
    "",
    "Don't have `fit` installed yet?",
    "",
    "```sh",
    "curl -fsSL https://raw.githubusercontent.com/couchbaselabs/fit-cli/main/install.sh | bash",
    "```",
    "",
    "</details>",
    "",
  ].join("\n");

  const existing = existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "";
  writeFileSync(summaryPath, block + "\n" + existing);
}

/**
 * Emits a GHA notice annotation with a direct link to the artifact bundle for
 * this run. Links to the S3 zip when available (preferred — survives beyond the
 * GHA retention window), otherwise falls back to the GHA run page.
 */
export function emitGhaArtifactNotice(s3Uri?: string): void {
  const { GITHUB_RUN_ID, GITHUB_REPOSITORY } = process.env;
  if (!GITHUB_RUN_ID || !GITHUB_REPOSITORY) return;

  const url = s3Uri ?? `https://github.com/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
  const name = `fit-cli-run-${GITHUB_RUN_ID}`;
  // GHA workflow command: printed to stdout, parsed by the runner.
  console.log(`::notice title=Run artifacts (${name})::${url}`);
}
