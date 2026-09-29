#!/usr/bin/env node
/**
 * List an opted-in SDK's nightly runs that GitHub still holds.
 *
 *   bun src/fit/health/backfill/list-runs.ts <sdk>
 *
 * GitHub's run-listing endpoints can serve stale results: on 2026-09-28 the repo-wide
 * `actions/runs?event=schedule` stopped at 2026-09-04 for a workflow that had run every
 * night since, and a per-workflow filtered listing briefly did the same before correcting
 * itself. So runs are listed per workflow, AND the most recent unfiltered runs are listed
 * too, and the two are merged: a stale filtered listing then cannot silently drop nights.
 * A gap is reported, never taken as "the nightly stopped".
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { capture } from "../../../util/non-fit/proc.js";
import { healthOptIn, type HealthOptIn } from "../registry/health-opt-ins.js";

export interface CiRun {
  runId: number;
  runAttempt: number;
  date: string;
  createdAt: string;
  workflow: string;
  branch: string;
  event: string;
  sha: string;
  status: string;
  conclusion: string | null;
}

interface ApiRun {
  id: number;
  run_attempt: number;
  created_at: string;
  head_branch: string;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
}

const JQ = ".workflow_runs[] | {id, run_attempt, created_at, head_branch, head_sha, event, status, conclusion} | tojson";

function toRun(workflow: string, r: ApiRun): CiRun {
  return {
    runId: r.id,
    runAttempt: r.run_attempt,
    date: r.created_at.slice(0, 10),
    createdAt: r.created_at,
    workflow,
    branch: r.head_branch,
    event: r.event,
    sha: r.head_sha,
    status: r.status,
    conclusion: r.conclusion,
  };
}

function parseLines(workflow: string, out: string): CiRun[] {
  return out
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => toRun(workflow, JSON.parse(l) as ApiRun));
}

/**
 * The nightly runs: scheduled, on the opted-in branch, finished. Merges both listings by
 * run id, so either can fill the other's gaps. Newest first.
 */
export function mergeNightlyRuns(filtered: CiRun[], unfiltered: CiRun[], branch: string): CiRun[] {
  const byId = new Map<number, CiRun>();
  for (const r of [...filtered, ...unfiltered]) {
    if (r.event !== "schedule" || r.branch !== branch || r.status !== "completed") continue;
    byId.set(r.runId, r);
  }
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Every attempt of every run. A listing names only a run's latest attempt, and a "re-run
 * failed jobs" attempt holds just the jobs it re-ran - the presets that passed stay in the
 * earlier attempt. So each attempt is fetched; the report keeps the newest per preset.
 */
export function allAttempts(runs: CiRun[]): CiRun[] {
  return runs.flatMap((r) => Array.from({ length: Math.max(1, r.runAttempt) }, (_, i) => ({ ...r, runAttempt: r.runAttempt - i })));
}

/** Newer nightly runs the filtered listing is missing - evidence it was served stale. */
export function staleListingGap(filtered: CiRun[], merged: CiRun[]): CiRun[] {
  const ids = new Set(filtered.map((r) => r.runId));
  const newestFiltered = filtered.filter((r) => r.event === "schedule").map((r) => r.createdAt).sort().at(-1) ?? "";
  return merged.filter((r) => !ids.has(r.runId) && r.createdAt > newestFiltered);
}

export interface NightlyListing {
  runs: CiRun[];
  /** Human-readable problems with the listing itself. */
  warnings: string[];
}

/** The branch whose runs count: the opt-in's, or the repo's default branch. */
export async function nightlyBranch(optIn: HealthOptIn): Promise<string> {
  if (optIn.branch) return optIn.branch;
  return (await capture("gh", ["api", `repos/${optIn.repo}`, "--jq", ".default_branch"])).trim();
}

export async function listNightlyRuns(optIn: HealthOptIn): Promise<NightlyListing> {
  const all: CiRun[] = [];
  const warnings: string[] = [];
  const branch = await nightlyBranch(optIn);
  for (const workflow of optIn.workflows) {
    const base = `repos/${optIn.repo}/actions/workflows/${workflow}/runs`;
    const filtered = parseLines(
      workflow,
      await capture("gh", ["api", "--paginate", `${base}?event=schedule&branch=${encodeURIComponent(branch)}&per_page=100`, "--jq", JQ]),
    );
    const unfiltered = parseLines(workflow, await capture("gh", ["api", `${base}?per_page=100`, "--jq", JQ]));
    const merged = mergeNightlyRuns(filtered, unfiltered, branch);
    const gap = staleListingGap(filtered, merged);
    if (gap.length) {
      warnings.push(`${workflow}: the filtered run listing was missing ${gap.length} recent nightly run(s) (newest ${gap[0].date}); recovered them from the unfiltered listing`);
    }
    all.push(...allAttempts(merged));
  }
  all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { runs: all, warnings };
}

if (isMain(import.meta.url)) {
  const sdk = process.argv[2];
  if (!sdk || sdk === "--help" || sdk === "-h") {
    console.log(`List an opted-in SDK's nightly runs that GitHub still holds (newest first).

Usage:
  bun src/fit/health/backfill/list-runs.ts <sdk>`);
    process.exit(sdk ? 0 : 1);
  }
  runCli(async () => {
    const optIn = healthOptIn(sdk);
    if (!optIn) throw new Error(`${sdk} has not opted in to fit health (src/fit/health/registry/health-opt-ins.ts)`);
    const { runs, warnings } = await listNightlyRuns(optIn);
    for (const w of warnings) console.warn(w);
    for (const r of runs) console.log(`${r.date}  ${r.runId}#${r.runAttempt}  ${r.conclusion ?? r.status}  ${r.workflow}  ${r.sha.slice(0, 9)}`);
    console.log(`${runs.length} nightly runs`);
  });
}
