/**
 * Generate GitHub-flavoured Markdown from JUnit surefire XML reports.
 * Produces a badge summary, a per-package results table, and detail blocks
 * for each failed test. Skipped tests are counted but not annotated.
 *
 * Usage:
 *   bun src/fit/shared/run-test-driver/junit-to-markdown.ts <surefire-reports-dir-or-archive.tar.gz>
 *   bun src/fit/shared/run-test-driver/junit-to-markdown.ts /tmp/fit-cli/20260622-122009
 *   bun src/fit/shared/run-test-driver/junit-to-markdown.ts /tmp/fit-cli/20260622-122009/instances/0/clusters/0/sessions/0/runs/0/surefire-reports.tar.gz
 *
 * Add --markdown to see what a GitHub Actions step summary will contain (--lean for the
 * reduced form, --bytes for just the size). See --help.
 */
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { basename, extname, join } from "node:path";
import { isMain } from "../../../util/non-fit/cli.js";
import { run } from "../../../util/non-fit/proc.js";
import { getXmlAttr } from "../../../util/non-fit/xml.js";

interface TestIssue {
  tag: "failure" | "error";
  message: string;
  body: string;
}

export interface FailingTestCase {
  classname: string;
  name: string;
  timeMs: number;
  issues: TestIssue[];
  /** Head and tail of the captured stdout, clipped at parse time — see MAX_RETAINED_STREAM_BYTES. */
  stdout?: string;
  stderr?: string;
  /** Lines dropped from the middle of stdout when it was clipped at parse time, if any. */
  stdoutOmittedLines?: number;
  stderrOmittedLines?: number;
}

/** A report too large to parse in full; its counts are read, its failure detail is not. */
export interface OversizedReport {
  filename: string;
  bytes: number;
}

export interface PackageStats {
  pkg: string;
  passed: number;
  failures: number;
  errors: number;
  skipped: number;
  timeMs: number;
}

export interface JunitMarkdownData {
  packages: PackageStats[];
  failingCases: FailingTestCase[];
  /** Reports skipped for size; counted in the totals, but with no per-failure detail. */
  oversizedReports?: OversizedReport[];
  totalPassed: number;
  totalFailures: number;
  totalErrors: number;
  totalSkipped: number;
  totalTimeMs: number;
}

/**
 * How much of a test's stdout/stderr is kept in memory.
 *
 * Rendering only ever shows a head and a tail — at most `2 * DEFAULT_OUTPUT_WINDOW_BYTES`
 * per failure — so anything beyond this is provably unreachable, and holding it is what
 * made a run cost gigabytes. Deliberately larger than the biggest render window so that
 * `truncate` always fires when clipping happened, keeping the "~N lines hidden" count
 * honest (it adds the parse-time and render-time omissions together).
 */
export const MAX_RETAINED_STREAM_BYTES = 64 * 1024;

/**
 * A single TEST-*.xml above this is not read whole. One real nightly run produced a 385 MB
 * report; V8 refuses strings beyond roughly 512 MB, so a slightly worse run would not
 * degrade, it would throw `Invalid string length` and take all reporting with it. Above the
 * threshold only the head is read — enough for the `<testsuite>` counts, which sit at the
 * very top — and the suite's failure detail is reported as unavailable.
 */
export const MAX_FULL_PARSE_BYTES = 64 * 1024 * 1024;

/** Above this a report is read through the clipping streamer rather than in one piece. */
export const MAX_UNCLIPPED_PARSE_BYTES = 8 * 1024 * 1024;

/** Enough to cover the `<testsuite ...>` element of an unreadable report. */
const OVERSIZED_HEAD_BYTES = 64 * 1024;

/**
 * Marks where a stream was clipped while the file was being read, carrying the line count
 * through to `extractTagContent` so the elision marker can report the true total. Sits
 * inside the CDATA, so it never disturbs the XML structure.
 */
const STREAM_CLIP_SENTINEL = "@@fit-cli-omitted-lines:";

/** Strip CDATA section wrappers, returning the unwrapped content. */
function unwrapCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

/**
 * Extract the (single) `<tag>...</tag>` content from a `<testcase>` body, e.g.
 * `system-out`/`system-err`, keeping only as much as could ever be rendered.
 */
function extractTagContent(inner: string, tag: string): { text: string; omittedLines: number } | undefined {
  const m = inner.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!m) return undefined;
  let content = unwrapCdata(m[1]).trim();
  if (content.length === 0) return undefined;
  // Lines already dropped by the clipping reader, if this came from a large report.
  let streamOmitted = 0;
  const sentinel = content.match(new RegExp(`${STREAM_CLIP_SENTINEL}(\\d+)@@`));
  if (sentinel) {
    streamOmitted = Number(sentinel[1]);
    content = content.replace(sentinel[0], "").trim();
  }
  if (content.length <= MAX_RETAINED_STREAM_BYTES) return { text: content, omittedLines: streamOmitted };
  const half = Math.floor(MAX_RETAINED_STREAM_BYTES / 2);
  const dropped = content.substring(half, content.length - half);
  return {
    text: content.substring(0, half) + content.substring(content.length - half),
    omittedLines: dropped.split("\n").length - 1 + streamOmitted,
  };
}

/** Parse failing/erroring <testcase> elements from a single TEST-*.xml file. */
export function parseFailingTestCases(xml: string): FailingTestCase[] {
  const cases: FailingTestCase[] = [];
  const re = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const inner = m[2] ?? "";
    // Only collect cases that have <failure> or <error> children — skip <skipped>.
    const childRe = /<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>|<(failure|error)\b([^>]*)\/>/g;
    let cm: RegExpExecArray | null;
    const issues: TestIssue[] = [];
    while ((cm = childRe.exec(inner)) !== null) {
      const tag = (cm[1] ?? cm[4]) as "failure" | "error";
      const childAttrs = cm[2] ?? cm[5] ?? "";
      const body = unwrapCdata((cm[3] ?? "").trim()).trim();
      const message = getXmlAttr(childAttrs, "message") || body.split("\n")[0]?.trim() || "";
      issues.push({ tag, message, body });
    }
    if (issues.length > 0) {
      const attrs = m[1];
      const classname = getXmlAttr(attrs, "classname");
      const name = getXmlAttr(attrs, "name");
      const timeMs = Math.round(parseFloat(getXmlAttr(attrs, "time") || "0") * 1000);
      const stdout = extractTagContent(inner, "system-out");
      const stderr = extractTagContent(inner, "system-err");
      cases.push({
        classname,
        name,
        timeMs,
        issues,
        stdout: stdout?.text,
        stderr: stderr?.text,
        ...(stdout && stdout.omittedLines > 0 ? { stdoutOmittedLines: stdout.omittedLines } : {}),
        ...(stderr && stderr.omittedLines > 0 ? { stderrOmittedLines: stderr.omittedLines } : {}),
      });
    }
  }
  return cases;
}

/** Parse suite-level stats and failing test cases from an array of {filename, xml} pairs. */
export function parseJunitData(files: Iterable<{ filename: string; xml: string; oversizedBytes?: number }>): JunitMarkdownData {
  const packageMap = new Map<string, Omit<PackageStats, "pkg">>();
  const failingCases: FailingTestCase[] = [];
  const oversizedReports: OversizedReport[] = [];

  // Iterable rather than an array so parseJunitDataFromDir can stream: holding every
  // report's XML at once cost 1.16 GB on one real run.
  for (const { filename, xml, oversizedBytes } of files) {
    const suiteMatch = xml.match(/<testsuite\b([^>]*)>/);
    if (!suiteMatch) continue;
    const attrs = suiteMatch[1];
    const suiteName = getXmlAttr(attrs, "name") || filename.replace(/^TEST-/, "").replace(/\.xml$/, "");
    const timeMs = Math.round(parseFloat(getXmlAttr(attrs, "time") || "0") * 1000);
    const tests = parseInt(getXmlAttr(attrs, "tests") || "0", 10);
    const failures = parseInt(getXmlAttr(attrs, "failures") || "0", 10);
    const errors = parseInt(getXmlAttr(attrs, "errors") || "0", 10);
    const skipped = parseInt(getXmlAttr(attrs, "skipped") || "0", 10);
    const passed = Math.max(0, tests - failures - errors - skipped);

    const dotIdx = suiteName.lastIndexOf(".");
    const pkg = dotIdx === -1 ? "(default)" : suiteName.substring(0, dotIdx);
    const existing = packageMap.get(pkg) ?? { passed: 0, failures: 0, errors: 0, skipped: 0, timeMs: 0 };
    packageMap.set(pkg, {
      passed: existing.passed + passed,
      failures: existing.failures + failures,
      errors: existing.errors + errors,
      skipped: existing.skipped + skipped,
      timeMs: existing.timeMs + timeMs,
    });

    if (oversizedBytes !== undefined) {
      // Only the head was read, so the counts above are sound but the testcase elements are
      // not all present. Record it rather than parsing a truncated document.
      oversizedReports.push({ filename, bytes: oversizedBytes });
    } else {
      failingCases.push(...parseFailingTestCases(xml));
    }
  }

  // Packages with failures/errors first, then alphabetical.
  const packages: PackageStats[] = [...packageMap.entries()]
    .sort(([pkgA, a], [pkgB, b]) => {
      const aFailed = a.failures + a.errors;
      const bFailed = b.failures + b.errors;
      if (aFailed > 0 && bFailed === 0) return -1;
      if (aFailed === 0 && bFailed > 0) return 1;
      return pkgA.localeCompare(pkgB);
    })
    .map(([pkg, s]) => ({ pkg, ...s }));

  let totalPassed = 0,
    totalFailures = 0,
    totalErrors = 0,
    totalSkipped = 0,
    totalTimeMs = 0;
  for (const s of packages) {
    totalPassed += s.passed;
    totalFailures += s.failures;
    totalErrors += s.errors;
    totalSkipped += s.skipped;
    totalTimeMs += s.timeMs;
  }

  return {
    packages,
    failingCases,
    ...(oversizedReports.length > 0 ? { oversizedReports } : {}),
    totalPassed,
    totalFailures,
    totalErrors,
    totalSkipped,
    totalTimeMs,
  };
}

function pctSuccess(passed: number, failed: number): string {
  const total = passed + failed;
  if (total === 0) return "-";
  return ((passed / total) * 100).toFixed(2) + "%";
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function elisionMarker(omittedLines: number): string {
  return `\n[...truncated by fit-cli to avoid Github length limits — ~${omittedLines} lines hidden; full output is in this run's ARTIFACT_DIR, fetchable via \`fit archive fetch ...\`...]\n`;
}

/**
 * Keep the head and tail of `s`, replacing the middle with a marker saying how much was
 * hidden and where to find it in full. `max` bounds the returned length *including* the
 * marker: at the historical 16k window the marker was rounding error, but the window is
 * now derived from the step-summary budget and can be small enough that ~160 bytes of
 * marker matters.
 */
/**
 * `alreadyOmittedLines` covers content dropped when the stream was clipped at parse time,
 * so the marker reports the true total rather than only what this call removed.
 * MAX_RETAINED_STREAM_BYTES is larger than any render window, so a clipped stream always
 * reaches the truncating path below and the count is never silently lost.
 */
function truncate(s: string, max = 16 * 1024, alreadyOmittedLines = 0): string {
  if (s.length <= max) {
    // Small enough to keep whole, but the reader may already have dropped part of it —
    // say so rather than presenting a clipped stream as complete.
    return alreadyOmittedLines > 0 ? s + elisionMarker(alreadyOmittedLines).trimEnd() : s;
  }
  // Two passes: the marker's length depends on the hidden line count, which depends on
  // where we cut. One refinement is enough to settle it.
  let half = Math.max(0, Math.floor((max - elisionMarker(alreadyOmittedLines).length) / 2));
  for (let pass = 0; pass < 2; pass++) {
    const omittedLines = s.substring(half, s.length - half).split("\n").length - 1 + alreadyOmittedLines;
    half = Math.max(0, Math.floor((max - elisionMarker(omittedLines).length) / 2));
  }
  if (half === 0) {
    // No room for any content alongside the marker — say what was dropped and nothing else.
    return elisionMarker(s.split("\n").length - 1 + alreadyOmittedLines).trim();
  }
  const omittedLines = s.substring(half, s.length - half).split("\n").length - 1 + alreadyOmittedLines;
  return s.substring(0, half) + elisionMarker(omittedLines) + s.substring(s.length - half);
}

/**
 * Third-party frames that appear in every FIT stack trace and carry no signal about
 * the failure. The test driver is always the Java/Maven suite in transactions-fit-performer
 * regardless of which SDK is under test, so this list is fixed rather than per-language.
 */
const FRAMEWORK_FRAME = /^\s*at\s+(org\.awaitility|okhttp3|okio|java\.base|jdk\.internal|sun\.|org\.junit|org\.opentest4j|io\.grpc|reactor\.|com\.google\.common|org\.apache\.maven|org\.testng|kotlin\.|kotlinx\.)/;

/**
 * Drop framework frames from a stack trace, keeping every non-frame line (the exception
 * header, `Caused by:`, `... N more`) and every frame that isn't third-party plumbing.
 * Runs of dropped frames are replaced by a marker so nothing disappears silently.
 *
 * On a real FIT run this cuts stack bodies by roughly 6x — a typical trace has two
 * `com.couchbase.*` frames and fourteen frames of awaitility/okhttp/JDK internals.
 * If a trace is *entirely* framework frames the original is returned unchanged, since
 * a marker on its own would tell the reader nothing.
 */
export function condenseStackTrace(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let elided = 0;
  let keptFrames = 0;
  const flush = (): void => {
    if (elided > 0) {
      out.push(`\t... ${elided} framework frame${elided === 1 ? "" : "s"} elided by fit-cli ...`);
      elided = 0;
    }
  };
  for (const line of lines) {
    if (FRAMEWORK_FRAME.test(line)) {
      elided++;
      continue;
    }
    flush();
    if (/^\s*at\s+/.test(line)) keptFrames++;
    out.push(line);
  }
  flush();
  return keptFrames === 0 ? body : out.join("\n");
}

/** Keep only the last `maxLines` lines of `s` — the failure context is usually near the end of a test's output. */
function tailLines(s: string, maxLines: number): { text: string; omittedCount: number } {
  const lines = s.split("\n");
  if (lines.length <= maxLines) return { text: s, omittedCount: 0 };
  return { text: lines.slice(-maxLines).join("\n"), omittedCount: lines.length - maxLines };
}

function removePackage(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? name : name.substring(idx + 1);
}

/**
 * Historical per-stream elision window. Retained as the default so a run with few
 * failures renders exactly as it always has.
 *
 * It bounds each stream of each failure but never their sum, which is how a 1437k
 * summary got built out of individually-elided pieces and was discarded whole: at 16k
 * per stream a failure can cost 32k, so the format only ever afforded ~32 maximally
 * verbose failures. One nightly .NET run had 136.
 */
export const DEFAULT_OUTPUT_WINDOW_BYTES = 16 * 1024;

/**
 * Smallest output window still worth rendering for a failure.
 *
 * Set from a stated preference in review: "I would much prefer to have some errors shown
 * usefully (with info), than all errors shown too briefly." The window is head+tail around
 * an elision marker of ~160 bytes, so 4k leaves roughly twenty lines at each end — enough
 * to triage from. At the previous 512 it was about two lines each end, which meant runs of
 * 300-700 failures got every failure shown and none of them usefully: the exact trade the
 * preference rules out. Below this we show fewer failures rather than thinner ones.
 */
export const MIN_OUTPUT_WINDOW_BYTES = 4 * 1024;

/**
 * Markdown scaffolding around one failure's content — heading, code fences, `<details>`
 * wrappers, separator. Measured from a rendered failure rather than estimated; only used
 * to size the output window, and the byte-accurate check in gha.ts is the real bound.
 */
const PER_FAILURE_SCAFFOLD_BYTES = 220;

export interface JunitMarkdownOptions {
  /**
   * Include the per-failure detail blocks. Set false for the badge and package table
   * only — the lean form the step-summary budget falls back to (see gha.ts).
   */
  includeFailureDetail?: boolean;
  /**
   * Bytes this run's markdown may occupy. Sizes the per-failure stdout/stderr window so
   * the total fits, rather than bounding each stream by a constant unrelated to the
   * budget. Omit to keep the historical fixed window.
   */
  budgetBytes?: number;
}

/** How much of `budgetBytes` a single failure's stdout/stderr may use, and how many failures to detail. */
export function planFailureDetail(args: {
  failureCount: number;
  /** Bytes already committed to the badge, package table and any non-failure content. */
  fixedBytes: number;
  /** Message + stack trace + markdown scaffolding, summed over all failures. */
  perFailureBytes: number;
  budgetBytes?: number;
}): { outputBudgetPerFailure: number; shownFailures: number } {
  const { failureCount, fixedBytes, perFailureBytes, budgetBytes } = args;
  const maxPerFailure = 2 * DEFAULT_OUTPUT_WINDOW_BYTES;
  if (failureCount === 0) return { outputBudgetPerFailure: maxPerFailure, shownFailures: 0 };
  if (budgetBytes === undefined) return { outputBudgetPerFailure: maxPerFailure, shownFailures: failureCount };

  // Rule 1: size the allowance to what's left after the parts we always render. This is a
  // per-failure total shared by whichever of stdout/stderr that failure actually has —
  // dividing by a fixed two streams wasted half the budget on the common case of an empty
  // stderr.
  const forOutput = budgetBytes - fixedBytes - perFailureBytes;
  const perFailure = Math.floor(forOutput / failureCount);
  if (perFailure >= MIN_OUTPUT_WINDOW_BYTES) {
    return { outputBudgetPerFailure: Math.min(perFailure, maxPerFailure), shownFailures: failureCount };
  }

  // Rule 2: the window has hit its floor, so cut how many failures are detailed rather
  // than shrinking the window into uselessness. Costs are averaged over the failures we
  // have; the byte-accurate check in gha.ts is what actually guarantees the bound.
  const averageFixed = perFailureBytes / failureCount;
  const costEach = averageFixed + MIN_OUTPUT_WINDOW_BYTES;
  const affordable = Math.floor((budgetBytes - fixedBytes) / costEach);
  return { outputBudgetPerFailure: MIN_OUTPUT_WINDOW_BYTES, shownFailures: Math.max(0, Math.min(failureCount, affordable)) };
}

/**
 * Render a JunitMarkdownData object to a GFM markdown string (for $GITHUB_STEP_SUMMARY).
 *
 * Per-test stdout and stack traces are kept — they are what makes a failure triageable —
 * but the elision window is derived from `budgetBytes` rather than fixed, so a run with
 * many failures narrows the window instead of overrunning GitHub's 1024k cap and losing
 * the summary entirely. Once the window would be too small to be useful, fewer failures
 * are detailed and the remainder is reported as a count.
 */
export function renderJunitMarkdown(data: JunitMarkdownData, options: JunitMarkdownOptions = {}): string {
  const { includeFailureDetail = true, budgetBytes } = options;
  const { packages, failingCases, totalPassed, totalFailures, totalErrors, totalSkipped, totalTimeMs } = data;
  const totalFailed = totalFailures + totalErrors;
  const lines: string[] = [];

  // Badge
  const badgeText = `tests-${totalPassed} ✅ | ${totalFailures} ❌ | ${totalErrors} 💥 | ${totalSkipped} ⏭ | ${formatTime(totalTimeMs)} ⏱️-white`;
  const badgeUrl = `https://img.shields.io/badge/${encodeURIComponent(badgeText).replace(/\+/g, "%20")}`;
  const altText = `Test results: ${totalPassed} passed, ${totalFailures} test failures, ${totalErrors} infra errors, ${totalSkipped} skipped, time: ${formatTime(totalTimeMs)}`;
  lines.push(`![${altText}](${badgeUrl})`);
  lines.push("");

  // Per-package summary table
  lines.push("<details open>");
  lines.push("<summary>Test results by package</summary>");
  lines.push("");
  lines.push("| Package | Pass | Test Fail | Infra | Skip | % Success | Time |");
  lines.push("|:---|---:|---:|---:|---:|---:|---:|");
  for (const s of packages) {
    const failed = s.failures + s.errors;
    lines.push(
      `| ${s.pkg} | ${s.passed > 0 ? `${s.passed} ✅` : ""} | ${s.failures > 0 ? `${s.failures} ❌` : ""} | ${s.errors > 0 ? `${s.errors} 💥` : ""} | ${s.skipped > 0 ? `${s.skipped} ⏭️` : ""} | ${pctSuccess(s.passed, failed)} | ${formatTime(s.timeMs)} ⏱️ |`,
    );
  }
  // Use explicit 0 for zero totals so the cell isn't bold-empty (**<empty>** = ****).
  const totalPassCell = totalPassed > 0 ? `${totalPassed} ✅` : "0";
  const totalFailureCell = totalFailures > 0 ? `${totalFailures} ❌` : "0";
  const totalErrorCell = totalErrors > 0 ? `${totalErrors} 💥` : "0";
  const totalSkipCell = totalSkipped > 0 ? `${totalSkipped} ⏭️` : "0";
  lines.push(
    `| **TOTAL** | **${totalPassCell}** | **${totalFailureCell}** | **${totalErrorCell}** | **${totalSkipCell}** | **${pctSuccess(totalPassed, totalFailed)}** | **${formatTime(totalTimeMs)} ⏱️** |`,
  );
  lines.push("");
  lines.push("</details>");
  lines.push("");

  if (data.oversizedReports && data.oversizedReports.length > 0) {
    const mb = (n: number): string => (n / (1024 * 1024)).toFixed(0);
    lines.push(
      `> ⚠️ ${data.oversizedReports.length} test report(s) were too large to render inline and are counted above but not detailed: ` +
        data.oversizedReports.map((r) => `\`${r.filename}\` (${mb(r.bytes)} MB)`).join(", ") +
        `. Read them in this run's ARTIFACT_DIR, fetchable via \`fit archive fetch ...\` (see above).`,
    );
    lines.push("");
  }

  if (!includeFailureDetail) {
    if (failingCases.length > 0) {
      lines.push(`_${failingCases.length} failing test(s) — detail omitted to stay within GitHub's step-summary limit; see the run artifacts above._`);
      lines.push("");
    }
    return lines.join("\n");
  }

  // Size the per-failure output window against what's left of the budget. The stack trace
  // and message are always rendered, so they count as committed cost before the window is
  // divided up; only stdout/stderr flex.
  const fixedBytes = Buffer.byteLength(lines.join("\n"), "utf8");
  const perFailureBytes = failingCases.reduce(
    (total, tc) =>
      total +
      PER_FAILURE_SCAFFOLD_BYTES +
      tc.issues.reduce((a, issue) => a + Buffer.byteLength(issue.message, "utf8") + Buffer.byteLength(condenseStackTrace(issue.body), "utf8"), 0),
    0,
  );
  const plan = planFailureDetail({
    failureCount: failingCases.length,
    fixedBytes,
    perFailureBytes,
    budgetBytes,
  });

  /**
   * Render the failure section for a given allowance. Predicting its exact size from the
   * inputs proved unreliable (markdown scaffolding, elision markers and multi-byte content
   * all drift), so `renderJunitMarkdown` renders, measures, and shrinks until it fits
   * rather than trusting the estimate.
   */
  const renderFailures = (outputBudgetPerFailure: number, shownFailures: number, namesListed: number): string[] => {
  const lines: string[] = [];
  for (const tc of failingCases.slice(0, shownFailures)) {
    const simpleClass = removePackage(tc.classname);
    const icon = tc.issues.some((issue) => issue.tag === "error") ? "💥" : "❌";
    lines.push(`#### ${icon} ${simpleClass}.${tc.name}`);
    lines.push("");
    for (const issue of tc.issues) {
      if (issue.message) {
        lines.push("```");
        // Windowed like everything else: normally ~60 bytes, but the driver can put a
        // whole serialized exception in here and nothing else would bound it.
        lines.push(truncate(issue.message, outputBudgetPerFailure));
        lines.push("```");
        lines.push("");
      }
      if (tc.timeMs > 0) {
        lines.push(`${formatTime(tc.timeMs)} ⏱️`);
        lines.push("");
      }
      if (issue.body) {
        lines.push("<details>");
        lines.push("<summary><b>🧵 Stack trace</b></summary>");
        lines.push("");
        lines.push("```");
        lines.push(truncate(condenseStackTrace(issue.body), outputBudgetPerFailure));
        lines.push("```");
        lines.push("");
        lines.push("</details>");
        lines.push("");
      }
    }
    // Share this failure's allowance across only the streams it actually has.
    const streams = (
      [
        ["stdout", tc.stdout, tc.stdoutOmittedLines ?? 0],
        ["stderr", tc.stderr, tc.stderrOmittedLines ?? 0],
      ] as const
    ).filter(([, output]) => Boolean(output));
    const perStream = streams.length > 0 ? Math.floor(outputBudgetPerFailure / streams.length) : outputBudgetPerFailure;
    for (const [label, output, alreadyOmitted] of streams) {
      if (!output) continue;
      lines.push("<details>");
      lines.push(`<summary><b>🖥️ Test output (${label})</b></summary>`);
      lines.push("");
      lines.push("```");
      lines.push(truncate(output, perStream, alreadyOmitted));
      lines.push("```");
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }

  const notShown = failingCases.length - shownFailures;
  if (notShown > 0) {
    lines.push(
      `_... and ${notShown} more failure(s) not shown in detail, to stay within GitHub's step-summary limit. ` +
        `All ${failingCases.length} are in this run's ARTIFACT_DIR, fetchable via \`fit archive fetch ...\` (see above)._`,
    );
    lines.push("");
    // Names are ~30 bytes each, so listing them costs little and keeps the most important
    // thing about a failure we had no room to detail: that it failed. Bounded like
    // everything else, since 5000 failures would be 150k of names on their own.
    const names = failingCases.slice(shownFailures, shownFailures + namesListed);
    if (names.length > 0) {
      lines.push("<details>");
      lines.push(`<summary>${names.length === notShown ? `The other ${notShown} failing test(s)` : `${names.length} of the other ${notShown} failing test(s)`}</summary>`);
      lines.push("");
      for (const tc of names) {
        const icon = tc.issues.some((issue) => issue.tag === "error") ? "💥" : "❌";
        lines.push(`- ${icon} ${removePackage(tc.classname)}.${tc.name}`);
      }
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
  }
    return lines;
  };

  let { outputBudgetPerFailure, shownFailures } = plan;
  let namesListed = failingCases.length - shownFailures;
  let failureLines = renderFailures(outputBudgetPerFailure, shownFailures, namesListed);
  if (budgetBytes !== undefined) {
    // Give up detail in the order it is worth least: first narrow the output window, then
    // detail fewer failures, then list fewer of their names. Bounded passes so this can
    // never loop; if even the tables overrun, gha.ts's ladder drops to a leaner block.
    for (let pass = 0; pass < 12; pass++) {
      const size = Buffer.byteLength([...lines, ...failureLines].join("\n"), "utf8");
      if (size <= budgetBytes) break;
      const overshoot = size - budgetBytes;
      if (outputBudgetPerFailure > MIN_OUTPUT_WINDOW_BYTES && shownFailures > 0) {
        const reduction = Math.max(1, Math.ceil(overshoot / shownFailures));
        outputBudgetPerFailure = Math.max(MIN_OUTPUT_WINDOW_BYTES, outputBudgetPerFailure - reduction);
      } else if (shownFailures > 0) {
        const perFailure = Math.max(1, Math.floor(size / shownFailures));
        shownFailures = Math.max(0, shownFailures - Math.max(1, Math.ceil(overshoot / perFailure)));
        namesListed = failingCases.length - shownFailures;
      } else if (namesListed > 0) {
        const perName = 40;
        namesListed = Math.max(0, namesListed - Math.max(1, Math.ceil(overshoot / perName)));
      } else {
        break;
      }
      failureLines = renderFailures(outputBudgetPerFailure, shownFailures, namesListed);
    }
  }

  return [...lines, ...failureLines].join("\n");
}

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** Render a JunitMarkdownData object as a plain-text table for terminal output. */
export function renderJunitPlainText(data: JunitMarkdownData, maxFailuresPerPackage = 3, maxOutputLines = 20): string {
  const { packages, failingCases, totalPassed, totalFailures, totalErrors, totalSkipped, totalTimeMs } = data;
  const totalFailed = totalFailures + totalErrors;
  const lines: string[] = [];

  const pkgHeader = "Package";
  const passHeader = "Pass";
  const skipHeader = "Skip";
  const failureHeader = "Test Fail";
  const errorHeader = "Infra";
  const pctHeader = "% Succ";
  const timeHeader = "Time";

  const pkgWidth = Math.max(pkgHeader.length, ...packages.map((s) => s.pkg.length), 5);
  const passWidth = Math.max(passHeader.length, String(totalPassed).length);
  const skipWidth = Math.max(skipHeader.length, String(totalSkipped).length);
  const failureWidth = Math.max(failureHeader.length, String(totalFailures).length);
  const errorWidth = Math.max(errorHeader.length, String(totalErrors).length);
  const pctWidth = Math.max(pctHeader.length, "100.00%".length);
  const timeWidth = Math.max(timeHeader.length, "H:MM:SS".length, formatTime(totalTimeMs).length);

  const sep = `${"-".repeat(pkgWidth)}-+-${"-".repeat(passWidth)}-+-${"-".repeat(skipWidth)}-+-${"-".repeat(failureWidth)}-+-${"-".repeat(errorWidth)}-+-${"-".repeat(pctWidth)}-+-${"-".repeat(timeWidth)}`;

  const row = (pkg: string, pass: string, skip: string, failure: string, error: string, pct: string, time: string, highlight = false): string => {
    const failureStr = highlight && failure !== "0" ? `${RED}${failure.padStart(failureWidth)}${RESET}` : failure.padStart(failureWidth);
    const errorStr = highlight && error !== "0" ? `${RED}${error.padStart(errorWidth)}${RESET}` : error.padStart(errorWidth);
    return `${pkg.padEnd(pkgWidth)} | ${pass.padStart(passWidth)} | ${skip.padStart(skipWidth)} | ${failureStr} | ${errorStr} | ${pct.padStart(pctWidth)} | ${time.padStart(timeWidth)}`;
  };

  const renderTable = (): void => {
    lines.push(row(pkgHeader, passHeader, skipHeader, failureHeader, errorHeader, pctHeader, timeHeader));
    lines.push(sep);
    for (const s of packages) {
      lines.push(
        row(s.pkg, String(s.passed), String(s.skipped), String(s.failures), String(s.errors), pctSuccess(s.passed, s.failures + s.errors), formatTime(s.timeMs), true),
      );
    }
    lines.push(sep);
    lines.push(row("TOTAL", String(totalPassed), String(totalSkipped), String(totalFailures), String(totalErrors), pctSuccess(totalPassed, totalFailed), formatTime(totalTimeMs), true));
  };

  renderTable();

  if (data.oversizedReports && data.oversizedReports.length > 0) {
    lines.push("");
    for (const r of data.oversizedReports) {
      lines.push(`${RED}! ${r.filename} was too large to render (${(r.bytes / (1024 * 1024)).toFixed(0)} MB) — counted above, not detailed${RESET}`);
    }
  }

  if (failingCases.length > 0) {
    lines.push("");
    lines.push("Failures:");

    // Group by package so we can cap output per package.
    const byPackage = new Map<string, FailingTestCase[]>();
    for (const tc of failingCases) {
      const dotIdx = tc.classname.lastIndexOf(".");
      const pkg = dotIdx === -1 ? "(default)" : tc.classname.substring(0, dotIdx);
      const arr = byPackage.get(pkg) ?? [];
      arr.push(tc);
      byPackage.set(pkg, arr);
    }

    for (const [pkg, cases] of byPackage) {
      const shown = cases.slice(0, maxFailuresPerPackage);
      const hidden = cases.length - shown.length;
      for (const tc of shown) {
        const simpleClass = removePackage(tc.classname);
        const icon = tc.issues.some((issue) => issue.tag === "error") ? "💥" : "❌";
        lines.push(`  ${RED}${icon} ${simpleClass}.${tc.name}${RESET}`);
        for (const issue of tc.issues) {
          if (issue.message) {
            lines.push(`    ${issue.message}`);
          }
          if (issue.body) {
            // 10 sometimes isn't quite enough to reach the relevant frame.
            for (const line of truncate(issue.body).split("\n").slice(0, 13)) {
              lines.push(`      ${line}`);
            }
          }
        }
        for (const [label, output, alreadyOmitted] of [
          ["stdout", tc.stdout, tc.stdoutOmittedLines ?? 0],
          ["stderr", tc.stderr, tc.stderrOmittedLines ?? 0],
        ] as const) {
          if (!output) continue;
          const { text, omittedCount: cut } = tailLines(output, maxOutputLines);
          const omittedCount = cut + alreadyOmitted;
          lines.push(`    Test output (${label})${omittedCount > 0 ? ` [${omittedCount} earlier line(s) omitted]` : ""}:`);
          for (const line of text.split("\n")) {
            lines.push(`      ${line}`);
          }
        }
      }
      if (hidden > 0) {
        lines.push(`  ${RED}... and ${hidden} more failure(s) in ${pkg}${RESET}`);
      }
    }

    // Repeat the summary table so it's visible without scrolling past a wall of failures.
    lines.push("");
    renderTable();
  }

  return lines.join("\n") + "\n";
}

/** Recursively collect the paths of all TEST-*.xml files under `dir`. */
function findXmlPaths(dir: string): string[] {
  const results: string[] = [];
  function walk(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(current, entry.name));
      } else if (entry.name.startsWith("TEST-") && entry.name.endsWith(".xml")) {
        results.push(join(current, entry.name));
      }
    }
  }
  walk(dir);
  return results;
}

/**
 * Read a report, discarding the middle of each `system-out`/`system-err` as it goes.
 *
 * Those sections are effectively all of a large report — one real run had a 385 MB report
 * of which the structure was under a megabyte — so clipping them while streaming keeps
 * every testcase while bounding memory. Reading such a file whole peaked at 2.4 GB;
 * V8 also refuses strings past roughly 512 MB, so a slightly worse report would have
 * thrown `Invalid string length` rather than degrading.
 */
function readXmlClippingOutput(path: string, retainPerEnd: number): string {
  const OPEN = /<system-(out|err)\b[^>]*>/;
  // Longest token we must not split across a chunk boundary.
  const CARRY = 64;
  const decoder = new StringDecoder("utf8");
  const fd = openSync(path, "r");
  const out: string[] = [];
  let buf = "";
  let inside: "out" | "err" | undefined;
  let head = "";
  let tail = "";
  let dropped = 0;

  const consume = (text: string): void => {
    if (head.length < retainPerEnd) {
      const room = retainPerEnd - head.length;
      head += text.substring(0, room);
      text = text.substring(room);
    }
    if (text.length === 0) return;
    tail += text;
    if (tail.length > retainPerEnd) {
      const cut = tail.substring(0, tail.length - retainPerEnd);
      dropped += cut.split("\n").length - 1;
      tail = tail.substring(tail.length - retainPerEnd);
    }
  };
  const closeSection = (): string => {
    const body = dropped > 0 ? `${head}\n${STREAM_CLIP_SENTINEL}${dropped}@@\n${tail}` : head + tail;
    head = "";
    tail = "";
    dropped = 0;
    inside = undefined;
    return body;
  };

  try {
    const chunk = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      const text = read > 0 ? decoder.write(chunk.subarray(0, read)) : decoder.end();
      buf += text;
      const atEof = read === 0;

      for (;;) {
        if (inside === undefined) {
          const m = OPEN.exec(buf);
          if (m && m.index !== undefined) {
            out.push(buf.substring(0, m.index + m[0].length));
            inside = m[1] as "out" | "err";
            buf = buf.substring(m.index + m[0].length);
            continue;
          }
          const keep = atEof ? 0 : Math.min(CARRY, buf.length);
          out.push(buf.substring(0, buf.length - keep));
          buf = buf.substring(buf.length - keep);
          break;
        }
        const closeTag = `</system-${inside}>`;
        const at = buf.indexOf(closeTag);
        if (at !== -1) {
          consume(buf.substring(0, at));
          out.push(closeSection() + closeTag);
          buf = buf.substring(at + closeTag.length);
          continue;
        }
        const keep = atEof ? 0 : Math.min(CARRY, buf.length);
        consume(buf.substring(0, buf.length - keep));
        buf = buf.substring(buf.length - keep);
        break;
      }
      if (atEof) {
        if (inside !== undefined) out.push(closeSection());
        else out.push(buf);
        break;
      }
    }
  } finally {
    closeSync(fd);
  }
  return out.join("");
}

/** Read just the first `bytes` of a file, for reports too large to hold whole. */
function readHead(path: string, bytes: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Yield one report at a time so only one is in memory at once, reading oversized ones by
 * the head alone.
 */
function* readXmlFiles(paths: readonly string[]): Generator<{ filename: string; xml: string; oversizedBytes?: number }> {
  for (const path of paths) {
    const filename = basename(path);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    if (size > MAX_UNCLIPPED_PARSE_BYTES) {
      // Clip stdout/stderr as the file is read, so every testcase survives at bounded cost.
      const xml = readXmlClippingOutput(path, MAX_RETAINED_STREAM_BYTES);
      // If the structure alone is still unreasonable the report is genuinely unusable, so
      // fall back to counts only rather than risking the heap on it.
      if (xml.length > MAX_FULL_PARSE_BYTES) {
        yield { filename, xml: readHead(path, OVERSIZED_HEAD_BYTES), oversizedBytes: size };
      } else {
        yield { filename, xml };
      }
    } else {
      yield { filename, xml: readFileSync(path, "utf8") };
    }
  }
}

/** Parse all TEST-*.xml files recursively under `dir`. Returns undefined if none found. */
export function parseJunitDataFromDir(dir: string): JunitMarkdownData | undefined {
  const paths = findXmlPaths(dir);
  return paths.length === 0 ? undefined : parseJunitData(readXmlFiles(paths));
}

/**
 * Read all TEST-*.xml files recursively under `dir` and return a GFM
 * markdown string suitable for appending to $GITHUB_STEP_SUMMARY.
 */
export function junitToMarkdownFromDir(dir: string, options: JunitMarkdownOptions = {}): string {
  const data = parseJunitDataFromDir(dir);
  return data ? renderJunitMarkdown(data, options) : "_No JUnit reports found._\n";
}

/**
 * Read all TEST-*.xml files recursively under `dir` and return a plain-text
 * table suitable for printing to the terminal.
 */
export function junitToPlainTextFromDir(dir: string): string {
  const data = parseJunitDataFromDir(dir);
  return data ? renderJunitPlainText(data) : "No JUnit reports found.\n";
}

const USAGE = `Usage: bun src/fit/shared/run-test-driver/junit-to-markdown.ts [options] <surefire-reports-dir-or-archive.tar.gz>

Render JUnit surefire reports the way fit-cli does.

Options:
  --markdown     Emit the GitHub-flavoured markdown written to $GITHUB_STEP_SUMMARY,
                 rather than the terminal table. Use this to see what a GHA run will show.
  --lean         With --markdown, emit the reduced form (badge + package table, no
                 per-failure detail) that the step-summary budget falls back to.
  --bytes        Print the rendered size instead of the content — handy for checking
                 a run against GitHub's 1024k step-summary cap.
  -h, --help     Show this help.

Examples:
  bun src/fit/shared/run-test-driver/junit-to-markdown.ts /tmp/fit-cli/20260622-122009
  bun src/fit/shared/run-test-driver/junit-to-markdown.ts --markdown --bytes /tmp/fit-cli/20260804-002753-7c4f/instances/aws1/clusters/8.0-stable/sessions/dotnet-main/runs/functional/surefire-reports
  bun src/fit/shared/run-test-driver/junit-to-markdown.ts --markdown .../surefire-reports.tar.gz`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  // Reject unknown options rather than ignoring them: silently dropping a typo like
  // "--markdwon" would print the terminal table while the caller believed they were
  // looking at the markdown GitHub will render.
  const KNOWN_FLAGS = new Set(["--markdown", "--lean", "--bytes"]);
  const unknown = argv.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    console.error(`Unknown option(s): ${unknown.join(", ")}\n\n${USAGE}`);
    process.exit(2);
  }
  const asMarkdown = argv.includes("--markdown");
  const lean = argv.includes("--lean");
  const bytesOnly = argv.includes("--bytes");
  const positional = argv.filter((a) => !a.startsWith("-"));
  if (positional.length !== 1) {
    console.log(USAGE);
    process.exit(2);
  }
  if (lean && !asMarkdown) {
    console.error("--lean only applies with --markdown (the terminal renderer has no lean form).");
    process.exit(2);
  }

  const input = positional[0];
  if (!existsSync(input)) {
    console.error(`Not found: ${input}`);
    process.exit(1);
  }

  const render = (dir: string): string => (asMarkdown ? junitToMarkdownFromDir(dir, { includeFailureDetail: !lean }) : junitToPlainTextFromDir(dir));
  const emit = (text: string): void => {
    if (bytesOnly) {
      console.log(`${Buffer.byteLength(text, "utf8")} bytes (${(Buffer.byteLength(text, "utf8") / 1024).toFixed(1)}K)`);
    } else {
      process.stdout.write(text);
    }
  };

  if (extname(input) === ".gz") {
    const tmpDir = mkdtempSync(join(tmpdir(), "fit-junit-markdown-"));
    try {
      await run("tar", ["-xzf", input, "-C", tmpDir]);
      emit(render(tmpDir));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  } else {
    emit(render(input));
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
