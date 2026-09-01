/**
 * Helpers for writing to GitHub Actions' $GITHUB_STEP_SUMMARY, within the 1024k budget
 * past which GitHub discards the whole summary.
 *
 * Usage:
 *   bun src/fit/util/gha.ts --help
 *   bun src/fit/util/gha.ts summary <surefire-reports-dir> [...more dirs]
 *   bun src/fit/util/gha.ts summary --dir /tmp/fit-cli/20260804-002753-7c4f
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { formatArtifactsTable } from "../../util/non-fit/artifacts.js";
import { isMain } from "../../util/non-fit/cli.js";
import { fitCliInfo } from "../../util/non-fit/fit-cli-log.js";
import { parseJunitDataFromDir, renderJunitMarkdown } from "../shared/run-test-driver/junit-to-markdown.js";
import { readSituationalResultsCsv, renderSituationalResultsMarkdown } from "../shared/run-test-driver/situational-results.js";

/**
 * GitHub discards the entire step summary — not just the excess — once the file passes
 * this, leaving only a "upload aborted, supports content up to a size of 1024k" annotation.
 */
export const STEP_SUMMARY_HARD_LIMIT_BYTES = 1024 * 1024;

/**
 * What we allow ourselves to write. The headroom below the hard limit covers the
 * "Run artifacts" block prepended at the end of the run (whose S3 URI isn't known until
 * then, so it cannot be counted as it is written) plus anything else in the job writing to
 * the same file. That block is ~400 bytes, so 24k of margin is generous; the earlier 900k
 * left 124k of the cap unused, which is 12% of the budget spent on nothing.
 */
export const STEP_SUMMARY_BUDGET_BYTES = 1000 * 1024;

/**
 * Each block is appended wrapped in newlines, so it costs this much more than its own
 * length. Counted against the budget so a block that "fits" can't nudge the file past it —
 * the point of the budget is to be a strict backstop. Kept in step with
 * `wrapBlockForAppend` by a unit test.
 */
export const SUMMARY_APPEND_OVERHEAD_BYTES = 2;

/** How a per-run block is written into the summary file: separated from its neighbours. */
export function wrapBlockForAppend(block: string): string {
  return "\n" + block + "\n";
}

/**
 * Pick the richest candidate that still fits in `remaining` bytes. Candidates must be
 * ordered richest first; returns the chosen text with how many richer ones were passed
 * over, or undefined when even the leanest doesn't fit.
 *
 * Every run of a multi-run definition appends to one summary file, so without this a
 * single verbose run can consume the whole budget and cost every later run its results.
 */
export function chooseBlockWithinBudget(candidates: string[], remaining: number): { block: string; skippedRicher: number } | undefined {
  for (let i = 0; i < candidates.length; i++) {
    if (Buffer.byteLength(candidates[i], "utf8") <= remaining) {
      return { block: candidates[i], skippedRicher: i };
    }
  }
  return undefined;
}

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
  /** Local path to the collected situational-results CSV; appended as a table below the JUnit one if present. */
  situationalResultsCsv?: string;
}

/**
 * Build the collapsed `<details>` block for one run: the always-visible
 * `<summary>` line is `pathLabel (sdk) — status`, with the Metric/Value table
 * and any pre-rendered JUnit/situational markdown collapsed inside it. Pure —
 * callers own the file I/O (reading surefireDir/situationalResultsCsv) and
 * pass already-rendered markdown in, so this stays unit-testable.
 */
export function renderRunSummaryBlock(args: {
  pathLabel: string;
  sdk: string;
  ok: boolean;
  summary?: { testsRun: number; failures: number; errors: number; skipped: number };
  /** Pre-rendered via junitToMarkdownFromDir. */
  junitMarkdown?: string;
  /** Pre-rendered via renderSituationalResultsMarkdown. */
  situationalMarkdown?: string;
}): string {
  const { pathLabel, sdk, ok, summary, junitMarkdown, situationalMarkdown } = args;
  const status =
    ok || !summary
      ? ok
        ? "✅ PASS"
        : "❌ FAIL"
      : `❌ FAIL (${summary.failures + summary.errors}/${summary.testsRun} failed)`;
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

  // Situational-only: the authoritative pass/fail signal for these scenarios comes from
  // the performer's scoring, not JUnit assertions, so this table is the more meaningful
  // one — appended below the JUnit table, matching fit-app-deployment's ordering.
  for (const markdown of [junitMarkdown, situationalMarkdown]) {
    if (!markdown) continue;
    lines.push(markdown.trimEnd());
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
export function appendRunSummaryToGhaSummary(result: RunSummary, budgetBytes: number = STEP_SUMMARY_BUDGET_BYTES): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    console.log(`[gha-summary] appendRunSummaryToGhaSummary: GITHUB_STEP_SUMMARY unset — skipping`);
    return;
  }

  const { pathLabel, sdk, ok, summary, surefireDir, situationalResultsCsv } = result;
  const sizeBefore = summaryFileSize();

  // Parsed once, rendered twice — with failure detail sized to the budget still unspent,
  // and (as a fallback if even that doesn't fit) with just the badge and package table.
  //
  // Passing the *whole* remaining budget rather than a per-run share means an early run
  // can spend more than its share when later runs turn out to be cheap. Runs stream in
  // and the total isn't known here, so this trades fairness across runs for using the
  // budget well; the ladder below still guarantees later runs get at least their tables.
  const remainingForThisRun = Math.max(0, budgetBytes - (sizeBefore < 0 ? 0 : sizeBefore) - SUMMARY_APPEND_OVERHEAD_BYTES);

  let situationalMarkdown: string | undefined;
  if (situationalResultsCsv) {
    try {
      const rows = readSituationalResultsCsv(situationalResultsCsv);
      if (rows) situationalMarkdown = renderSituationalResultsMarkdown(rows);
    } catch (err) {
      console.warn(`Warning: failed to render situational results table for "${pathLabel}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // The JUnit markdown is embedded in a block that also carries the <details> wrapper, the
  // Metric/Value table and any situational table. Measure those and hand the renderer only
  // what is genuinely left, or it sizes its elision windows to the whole remaining budget
  // and the finished block overshoots — which the ladder then rejects wholesale, costing
  // all the detail we were trying to preserve.
  const wrapperBytes = Buffer.byteLength(renderRunSummaryBlock({ pathLabel, sdk, ok, summary, situationalMarkdown }), "utf8");
  const junitBudget = Math.max(0, remainingForThisRun - wrapperBytes);

  let junitFull: string | undefined;
  let junitLean: string | undefined;
  if (surefireDir) {
    try {
      const data = parseJunitDataFromDir(surefireDir);
      junitFull = data ? renderJunitMarkdown(data, { budgetBytes: junitBudget }) : "_No JUnit reports found._\n";
      junitLean = data ? renderJunitMarkdown(data, { includeFailureDetail: false }) : junitFull;
    } catch (err) {
      console.warn(`Warning: failed to render JUnit table for "${pathLabel}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Richest first: full detail, then tables only, then just the pass/fail line. Deduped
  // because with no JUnit or situational data these collapse onto each other, and an
  // identical candidate shouldn't be reported as a distinct form we gave up.
  const candidates = [
    renderRunSummaryBlock({ pathLabel, sdk, ok, summary, junitMarkdown: junitFull, situationalMarkdown }),
    renderRunSummaryBlock({ pathLabel, sdk, ok, summary, junitMarkdown: junitLean, situationalMarkdown }),
    renderRunSummaryBlock({ pathLabel, sdk, ok, summary }),
    renderRunSummaryBlock({ pathLabel, sdk, ok }),
  ].filter((block, i, all) => all.indexOf(block) === i);

  const used = sizeBefore < 0 ? 0 : sizeBefore;
  // Leave room for the newlines the append wraps the block in, so the file cannot end up
  // past the budget by a block that measured as fitting.
  const remaining = budgetBytes - used - SUMMARY_APPEND_OVERHEAD_BYTES;
  const chosen = chooseBlockWithinBudget(candidates, remaining);
  if (!chosen) {
    console.warn(
      `Warning: step summary budget exhausted (${used} of ${budgetBytes} bytes used) — ` +
        `omitting the block for "${pathLabel}". Its results are in the run artifacts.`,
    );
    return;
  }
  if (chosen.skippedRicher > 0) {
    console.log(
      `[gha-summary] step summary at ${used} of ${budgetBytes} bytes — ` +
        `wrote a reduced block for "${pathLabel}" (dropped ${chosen.skippedRicher} richer form(s)); full detail is in the run artifacts`,
    );
  }

  try {
    appendFileSync(summaryPath, wrapBlockForAppend(chosen.block));
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
  // GHA workflow command: the runner parses "::cmd::" lines from stderr just as well
  // as stdout, so route it through fitCliInfo rather than console.log. Every command
  // is wrapped in runCli()'s end-of-run summary, including ones whose stdout must
  // stay machine-parseable (e.g. `a mini CLI's JSON output piped into jq`) — stdout must carry only
  // that command's own payload.
  fitCliInfo(`::notice title=Run artifacts (${name})::${url}`);
}

const USAGE = `Usage: bun src/fit/util/gha.ts <subcommand> [options]

Subcommands:
  summary <surefire-reports-dir> [...]  Replay the per-run step-summary appends for one or
                                        more runs against a throwaway $GITHUB_STEP_SUMMARY,
                                        showing which form the budget picked for each and how
                                        the file grows. Use this to check a run would fit
                                        under GitHub's ${STEP_SUMMARY_HARD_LIMIT_BYTES / 1024}k cap without pushing to CI.

Options:
  --dir <artifact-dir>   An unpacked run artifact directory (e.g. the contents of a
                         'fit archive fetch' zip). Every surefire-reports dir under it is
                         replayed, in the order the run produced them.
  --budget <bytes>       Override the byte budget for this replay, to exercise the
                         degradation ladder (full detail → tables only → counts → status)
                         without needing a run big enough to hit the real budget.
  --out <path>           Append to this file instead of a throwaway one. Pass
                         "$GITHUB_STEP_SUMMARY" from inside a GitHub Actions job to see
                         GitHub render the real thing.
  -h, --help             Show this help.

Examples:
  bun src/fit/util/gha.ts summary --dir /tmp/fit-cli/20260804-002753-7c4f
  bun src/fit/util/gha.ts summary --dir /tmp/fit-cli/20260804-002753-7c4f --budget 40000
  bun src/fit/util/gha.ts summary --dir ./bundle --out "$GITHUB_STEP_SUMMARY"   # inside GHA
  bun src/fit/util/gha.ts summary /tmp/fit-cli/20260804-002753-7c4f/instances/aws1/clusters/8.0-stable/sessions/dotnet-main/runs/functional/surefire-reports`;

/**
 * Recursively find every surefire-reports directory under `dir`, in lexicographic path
 * order. The order matters and is deliberately deterministic: it decides which run spends
 * the summary budget first, so a replay is reproducible.
 */
function findSurefireDirs(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(current, entry.name);
      if (entry.name === "surefire-reports") {
        found.push(full);
      } else {
        walk(full);
      }
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * A short label for a run, derived from its path within the artifact directory. Splits on
 * either separator: `findSurefireDirs` builds paths with path.join(), which yields "\" on
 * Windows, and a POSIX-only split would label every run "surefire-reports".
 */
export function labelForSurefireDir(dir: string): string {
  const parts = dir.split(/[/\\]/).filter(Boolean);
  const runsIdx = parts.lastIndexOf("runs");
  if (runsIdx >= 0 && runsIdx + 1 < parts.length) {
    const instanceIdx = parts.lastIndexOf("instances");
    const instance = instanceIdx >= 0 && instanceIdx + 1 < parts.length ? parts[instanceIdx + 1] : undefined;
    return [instance, parts[runsIdx + 1]].filter(Boolean).join(" / ");
  }
  return basename(dir);
}

function main(): void {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(argv.length === 0 ? 2 : 0);
  }
  const [subcommand, ...rest] = argv;
  if (subcommand !== "summary") {
    console.error(`Unknown subcommand "${subcommand}".\n\n${USAGE}`);
    process.exit(2);
  }

  // Pull out each value-taking flag and its value, so what remains really is positional
  // (otherwise a flag's value gets mistaken for a surefire directory).
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const VALUE_FLAGS = new Set(["--dir", "--budget", "--out"]);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (VALUE_FLAGS.has(arg)) {
      const value = rest[i + 1];
      if (value === undefined || VALUE_FLAGS.has(value)) {
        console.error(`${arg} needs a value.`);
        process.exit(2);
      }
      flags.set(arg, value);
      i++;
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option "${arg}".\n\n${USAGE}`);
      process.exit(2);
    } else {
      positional.push(arg);
    }
  }

  let budget = STEP_SUMMARY_BUDGET_BYTES;
  const budgetArg = flags.get("--budget");
  if (budgetArg !== undefined) {
    budget = Number(budgetArg);
    if (!Number.isFinite(budget) || budget <= 0) {
      console.error(`--budget needs a positive byte count (got ${budgetArg}).`);
      process.exit(2);
    }
  }

  const artifactDir = flags.get("--dir");
  let dirs: string[];
  if (artifactDir !== undefined) {
    if (!existsSync(artifactDir)) {
      console.error(`--dir needs an existing artifact directory (got ${artifactDir}).`);
      process.exit(2);
    }
    dirs = findSurefireDirs(artifactDir);
    if (dirs.length === 0) {
      console.error(`No surefire-reports directories found under ${artifactDir}.`);
      process.exit(1);
    }
  } else {
    dirs = positional;
    if (dirs.length === 0) {
      console.log(USAGE);
      process.exit(2);
    }
  }

  // Default to a throwaway file rather than any real $GITHUB_STEP_SUMMARY, so this is safe
  // to run inside a GitHub Actions job. --out opts in to writing somewhere real, and then
  // appends rather than truncating, matching how GHA steps share one summary file.
  const explicitOut = flags.get("--out");
  const summaryPath = explicitOut ?? join(mkdtempSync(join(tmpdir(), "fit-gha-summary-")), "step_summary.md");
  if (!explicitOut) writeFileSync(summaryPath, "");
  else if (!existsSync(summaryPath)) writeFileSync(summaryPath, "");
  const previous = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summaryPath;

  console.log(
    `Budget ${(budget / 1024).toFixed(1)}K${budget === STEP_SUMMARY_BUDGET_BYTES ? "" : " (overridden)"}, GitHub hard limit ${STEP_SUMMARY_HARD_LIMIT_BYTES / 1024}K.`,
  );
  console.log(`Replaying ${dirs.length} run(s) into ${summaryPath}\n`);
  try {
    for (const dir of dirs) {
      const data = parseJunitDataFromDir(dir);
      const label = labelForSurefireDir(dir);
      appendRunSummaryToGhaSummary({
        pathLabel: label,
        sdk: "replay",
        // A run with no JUnit reports is not a pass — collect-junit.ts treats "no reports
        // found" as FatalToRun, and a block reading PASS above "_No JUnit reports found._"
        // would contradict itself.
        ok: data !== undefined && data.totalFailures + data.totalErrors === 0,
        summary: data
          ? {
              testsRun: data.totalPassed + data.totalFailures + data.totalErrors,
              failures: data.totalFailures,
              errors: data.totalErrors,
              skipped: data.totalSkipped,
            }
          : undefined,
        surefireDir: dir,
      }, budget);
    }
  } finally {
    if (previous === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = previous;
  }

  const finalSize = statSync(summaryPath).size;
  if (explicitOut) console.log(`(appended to ${summaryPath} rather than a throwaway file)`);
  const verdict = finalSize <= STEP_SUMMARY_HARD_LIMIT_BYTES ? "fits" : "WOULD BE DISCARDED BY GITHUB";
  console.log(`\nFinal summary: ${finalSize} bytes (${(finalSize / 1024).toFixed(1)}K) — ${verdict}.`);
  console.log(`Headroom to the hard limit: ${((STEP_SUMMARY_HARD_LIMIT_BYTES - finalSize) / 1024).toFixed(1)}K.\n`);
  const table = formatArtifactsTable([
    { filename: summaryPath, size: `${(finalSize / 1024).toFixed(1)} KiB`, explanation: "Rendered step summary — view it as GitHub would render the markdown" },
  ]);
  if (table) console.log(table);
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
