/**
 * Pure Block Kit renderer for a FIT run summary posted to a Slack thread. Takes a
 * plain, IO-free input shape (the orchestrator in ../post-run-summary.ts maps the
 * run's RunResultSummary[] + parsed JUnit data into it) so this stays unit
 * testable — see ../tests/slack-results.test.ts.
 *
 * Slack has no native multi-column table for chat.postMessage, so the failing-test
 * list uses a monospace code block (aligned columns); the rest is proper Block Kit
 * (header, section fields, context) so it reads as a polished message, not raw text.
 */

/** One run's outcome (one row of the definition's run matrix). */
export interface SlackRunResult {
  /** Rich path label, e.g. "aws1 / cbdino1 / java:main / func". */
  label: string;
  sdk: string;
  ok: boolean;
  testsRun?: number;
  failures?: number;
  errors?: number;
  skipped?: number;
  durationMs?: number;
  /** Failing test cases, most useful first; rendered as an aligned code block. */
  failingTests?: { name: string; detail?: string }[];
  /**
   * One-line "why", hunted out of the failing terminal output's tail (see
   * `extractFailureTail`/`likelyCauseLine` in `../../util/gha.ts`) for a preset that
   * crashed before producing any test counts. Shown in place of the bare "see logs".
   */
  failureSnippet?: string;
}

export interface SlackRunSummaryInput {
  /** Header label — the preset or definition name, e.g. "op-capella-sit-lite". */
  title: string;
  results: SlackRunResult[];
  /** Overall pass/fail across all results. */
  passed: boolean;
  /** Link back to the GitHub Actions run, when running under CI. */
  ghaRunUrl?: string;
}

const MAX_FAILING_TESTS = 15;
// Slack's chat.postMessage hard-rejects a message over 50 blocks (invalid_blocks) — leave
// headroom for the header/footer and stay well clear of that, rather than risk a preset
// group with many presets/failures silently failing to post at all.
const MAX_TOTAL_BLOCKS = 48;

/** Formats e.g. "1h12m", "16m", "45s" — seconds are dropped once a run runs a minute or more. */
function fmtDuration(ms?: number): string {
  if (ms === undefined) return "";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** One-line count summary for a single run, e.g. "412 run · 3 failed · 0 skipped · 16m41s". */
function countsLine(result: SlackRunResult): string {
  // A preset that crashed or was never reached (e.g. a group member that threw before
  // producing a RunResultSummary) has no counts at all — "0 failed" next to a ❌ would
  // misleadingly read as "ran clean".
  if (!result.ok && result.testsRun === undefined && result.failures === undefined && result.errors === undefined) {
    return result.failureSnippet
      ? `no results — likely cause: \`${result.failureSnippet.replace(/`/g, "'")}\``
      : "no results — see logs";
  }
  const parts: string[] = [];
  if (result.testsRun !== undefined) parts.push(`${result.testsRun} run`);
  const failed = (result.failures ?? 0) + (result.errors ?? 0);
  parts.push(`${failed} failed`);
  if (result.skipped) parts.push(`${result.skipped} skipped`);
  const dur = fmtDuration(result.durationMs);
  if (dur) parts.push(dur);
  return parts.join(" · ");
}

// Detail text is capped, not dropped — Slack's per-section text limit is 3000 chars and
// MAX_FAILING_TESTS keeps this to at most 15 lines, so there's plenty of headroom to show
// the whole failure reason rather than cutting it off mid-sentence.
const MAX_DETAIL_CHARS = 300;

/** Render the failing tests of one result as an aligned monospace code block, or "" if none. */
function failingTestsBlock(result: SlackRunResult): string {
  const tests = result.failingTests ?? [];
  if (tests.length === 0) return "";
  const shown = tests.slice(0, MAX_FAILING_TESTS);
  const nameWidth = Math.max(...shown.map((t) => t.name.length));
  const lines = shown.map((t) => {
    if (!t.detail) return t.name.padEnd(nameWidth);
    const normalized = t.detail.replace(/\s+/g, " ");
    const detail = normalized.length > MAX_DETAIL_CHARS ? `${normalized.slice(0, MAX_DETAIL_CHARS)}…` : normalized;
    return `${t.name.padEnd(nameWidth)}  ${detail}`;
  });
  if (tests.length > shown.length) {
    lines.push(`… and ${tests.length - shown.length} more`);
  }
  return "```\n" + lines.join("\n") + "\n```";
}

/**
 * Build the Block Kit blocks + a plain-text fallback for a run summary. The
 * fallback text is what shows in notifications and in any client that can't
 * render blocks.
 */
export function renderSlackRunSummary(input: SlackRunSummaryInput): { text: string; blocks: unknown[] } {
  const overallEmoji = input.passed ? "✅" : "❌";
  const failedRuns = input.results.filter((r) => !r.ok).length;
  const fallback = input.passed
    ? `${overallEmoji} ${input.title} — passed (${input.results.length} run${input.results.length === 1 ? "" : "s"})`
    : `${overallEmoji} ${input.title} — ${failedRuns}/${input.results.length} run${input.results.length === 1 ? "" : "s"} failed`;

  const header = {
    type: "header",
    text: { type: "plain_text", text: `${overallEmoji} ${input.title}`.slice(0, 150), emoji: true },
  };

  const footerBlocks: unknown[] = input.ghaRunUrl
    ? [{ type: "context", elements: [{ type: "mrkdwn", text: `🔗 <${input.ghaRunUrl}|GitHub Actions run>` }] }]
    : [];

  // Each result renders as one or two blocks (a summary section, plus an optional
  // failing-tests block) — grouped so dropping/truncating below can't split a result
  // across a boundary.
  let resultGroups: unknown[][] = input.results.map((result) => {
    const emoji = result.ok ? "✅" : "❌";
    const group: unknown[] = [
      { type: "section", text: { type: "mrkdwn", text: `${emoji} *${result.sdk}* · \`${result.label}\`\n${countsLine(result)}` } },
    ];
    const failing = failingTestsBlock(result);
    if (failing) group.push({ type: "section", text: { type: "mrkdwn", text: failing } });
    return group;
  });

  const totalBlocks = (groups: unknown[][]): number => groups.reduce((n, g) => n + g.length, 0);
  const budget = MAX_TOTAL_BLOCKS - 1 /* header */ - footerBlocks.length;

  // A large preset group (many presets, several failing) can otherwise exceed Slack's
  // 50-block limit and have chat.postMessage reject the whole message outright — worse
  // than the per-preset noise this is meant to replace. Degrade gracefully instead:
  // drop failing-test detail first, then truncate the result list itself.
  if (totalBlocks(resultGroups) > budget) {
    resultGroups = resultGroups.map((g) => (g.length > 1 ? [g[0]] : g));
  }
  let truncatedBlock: unknown;
  if (totalBlocks(resultGroups) > budget) {
    const keep = Math.max(0, budget - 1);
    truncatedBlock = {
      type: "section",
      text: { type: "mrkdwn", text: `… and ${resultGroups.length - keep} more result(s) not shown — see the full run for details.` },
    };
    resultGroups = resultGroups.slice(0, keep);
  }

  const blocks: unknown[] = [header, ...resultGroups.flat(), ...(truncatedBlock ? [truncatedBlock] : []), ...footerBlocks];

  return { text: fallback, blocks };
}
