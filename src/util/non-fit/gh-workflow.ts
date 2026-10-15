/**
 * Dispatch a GitHub Actions `workflow_dispatch` workflow with the `gh` CLI, find the
 * run it created, wait for it, and read back its jobs and logs; also reads the dispatch
 * inputs a workflow file declares on a branch or tag.
 *
 * Run on its own:
 *   bun src/util/non-fit/gh-workflow.ts --help
 *   bun src/util/non-fit/gh-workflow.ts inputs couchbasecloud/couchbase-cloud sandbox-deploy-control-plane.yml
 *   bun src/util/non-fit/gh-workflow.ts jobs couchbasecloud/couchbase-cloud 123456789
 *   bun src/util/non-fit/gh-workflow.ts job-log couchbasecloud/couchbase-cloud 987654321 summary-step-output
 */
import { parse as parseYaml } from "yaml";
import { isMain, runCli } from "./cli.js";
import { fitCliWarn } from "./fit-cli-log.js";
import { capture, HEARTBEAT_INTERVAL_SECS, stripAnsi } from "./proc.js";
import { exponentialDelays, retryWhole } from "./retry.js";

export interface GhWorkflow {
  repo: string;
  workflow: string;
}

export function ghRunUrl(repo: string, runId: number): string {
  return `https://github.com/${repo}/actions/runs/${runId}`;
}

const GH_CALL_TIMEOUT_MS = 60_000;
const GH_LOG_TIMEOUT_MS = 5 * 60_000;

function gh(args: string[], { timeoutMs = GH_CALL_TIMEOUT_MS, quiet = true } = {}): Promise<string> {
  return capture("gh", args, process.cwd(), { quiet, timeoutMs });
}

export function workflowFilePath(workflow: GhWorkflow): string {
  return `.github/workflows/${workflow.workflow}`;
}

export function ghRunListCommand(workflow: GhWorkflow): string {
  return `gh run list --repo ${workflow.repo} --workflow ${workflow.workflow}`;
}

const isNotFound = (err: unknown): boolean => err instanceof Error && err.message.includes("HTTP 404");

function undefinedIfNotFound(err: unknown): undefined {
  if (isNotFound(err)) return undefined;
  throw err;
}

export interface WorkflowDispatchInput {
  name: string;
  description: string;
  type: string;
  options: string[];
  default: string;
  required: boolean;
}

type YamlScalar = string | number | boolean;

interface WorkflowFileInput {
  description?: YamlScalar | null;
  type?: string;
  options?: YamlScalar[];
  default?: YamlScalar | null;
  required?: boolean;
}

export function parseWorkflowDispatchInputs(workflowYaml: string): WorkflowDispatchInput[] {
  const doc = parseYaml(workflowYaml) as { on?: { workflow_dispatch?: { inputs?: Record<string, WorkflowFileInput | null> } | null } } | null;
  const inputs = doc?.on?.workflow_dispatch?.inputs ?? {};
  return Object.entries(inputs).map(([name, spec]) => {
    const type = spec?.type ?? "string";
    const options = type === "boolean" ? ["true", "false"] : (spec?.options ?? []).map(String);
    return {
      name,
      description: String(spec?.description ?? "").trim(),
      type,
      options,
      default: String(spec?.default ?? (type === "boolean" ? "false" : (options[0] ?? ""))),
      required: spec?.required === true,
    };
  });
}

export async function findRefs(repo: string, name: string): Promise<string[]> {
  const path = name.split("/").map(encodeURIComponent).join("/");
  const refs = await Promise.all(["heads", "tags"].map((kind) =>
    gh(["api", `repos/${repo}/git/ref/${kind}/${path}`]).then(() => `refs/${kind}/${name}`, undefinedIfNotFound)));
  return refs.filter((ref): ref is string => ref !== undefined);
}

export async function repoVisible(repo: string): Promise<boolean> {
  return gh(["api", `repos/${repo}`, "--jq", ".id"]).then(() => true, (err: unknown) => undefinedIfNotFound(err) ?? false);
}

export async function fetchWorkflowDispatchInputs(workflow: GhWorkflow, ref?: string): Promise<WorkflowDispatchInput[] | undefined> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const yamlText = await gh(["api", `repos/${workflow.repo}/contents/${workflowFilePath(workflow)}${query}`, "-H", "Accept: application/vnd.github.raw+json"])
    .catch(undefinedIfNotFound);
  return yamlText === undefined ? undefined : parseWorkflowDispatchInputs(yamlText);
}

export async function fetchRunWorkflowPath(repo: string, runId: number): Promise<string | undefined> {
  return (await gh(["api", `repos/${repo}/actions/runs/${runId}`, "--jq", ".path"]).catch(undefinedIfNotFound))?.trim().replace(/@.*$/, "");
}

export function parseRunIdFromUrl(text: string): number | undefined {
  const runId = /\/actions\/runs\/(\d+)/.exec(text)?.[1];
  return runId === undefined ? undefined : Number(runId);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const RUN_STATUS_RETRY_DELAYS_MS = exponentialDelays({ attempts: 6, baseMs: 5_000, maxMs: 60_000 });
const JOB_LOG_RETRY_DELAYS_MS = exponentialDelays({ attempts: 3, baseMs: 5_000, maxMs: 10_000 });

export async function dispatchWorkflow(
  workflow: GhWorkflow,
  fields: Readonly<Record<string, string>>,
  ref?: string,
): Promise<number | undefined> {
  let output: string;
  try {
    output = await gh(
      ["workflow", "run", workflow.workflow, "--repo", workflow.repo, ...(ref ? ["--ref", ref] : []), ...Object.entries(fields).flatMap(([key, value]) => ["--raw-field", `${key}=${value}`])],
      { quiet: false },
    );
  } catch (err) {
    throw new Error(
      `Dispatching ${workflow.workflow} failed (cause below). If it timed out, GitHub may still have accepted it, so check` +
        ` ${ghRunListCommand(workflow)} before dispatching again.`,
      { cause: err },
    );
  }
  return parseRunIdFromUrl(output);
}

export interface GhStepSummary {
  name: string;
  status: string;
  conclusion: string;
}

export interface GhJobSummary {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string;
  url: string;
  steps: GhStepSummary[];
}

export interface GhRunSnapshot {
  status: string;
  conclusion: string;
  createdAt: string;
  jobs: GhJobSummary[];
}

const RUN_SNAPSHOT_JQ =
  "{status, conclusion, createdAt, jobs: [.jobs[] | {databaseId, name, status, conclusion, url, steps: [.steps[] | {name, status, conclusion}]}]}";

export async function fetchRunSnapshot(repo: string, runId: number): Promise<GhRunSnapshot> {
  const stdout = await gh(["run", "view", String(runId), "--repo", repo, "--json", "status,conclusion,createdAt,jobs", "--jq", RUN_SNAPSHOT_JQ]);
  return JSON.parse(stdout) as GhRunSnapshot;
}

export function formatRunHeartbeat(snapshot: Pick<GhRunSnapshot, "status" | "createdAt" | "jobs">, now: number): string {
  const running = snapshot.jobs.filter((job) => job.status === "in_progress").map((job) => job.name);
  const totalSecs = Math.max(0, Math.floor((now - Date.parse(snapshot.createdAt)) / 1000));
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  const elapsed = mins > 0 ? `${mins}m${String(secs).padStart(2, "0")}s` : `${secs}s`;
  const status = snapshot.status === "waiting" ? "waiting for an approval" : snapshot.status.replace(/_/g, " ");
  return `  ...${status} (${elapsed} elapsed)${running.length > 0 ? `: ${running.join(", ")}` : ""}`;
}

export async function waitForRunCompletion(
  repo: string,
  runId: number,
  onPoll?: (snapshot: GhRunSnapshot) => void,
): Promise<GhRunSnapshot> {
  for (;;) {
    const snapshot = await retryWhole(() => fetchRunSnapshot(repo, runId), {
      delaysMs: RUN_STATUS_RETRY_DELAYS_MS,
      shouldRetry: (err) => !isNotFound(err),
      onRetry: (err, waitMs) => fitCliWarn(`Couldn't check run ${runId} (${err.message}); retrying in ${waitMs / 1000}s.`),
    });
    onPoll?.(snapshot);
    if (snapshot.status === "completed") {
      return snapshot;
    }
    console.log(formatRunHeartbeat(snapshot, Date.now()));
    await sleep(HEARTBEAT_INTERVAL_SECS * 1000);
  }
}

export async function fetchJobLog(repo: string, jobId: number): Promise<string> {
  return retryWhole(() => gh(["api", `repos/${repo}/actions/jobs/${jobId}/logs`], { timeoutMs: GH_LOG_TIMEOUT_MS }), {
    delaysMs: JOB_LOG_RETRY_DELAYS_MS,
  });
}

const JOB_LOG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

export function jobLogLines(jobLog: string): string[] {
  return stripAnsi(jobLog)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.replace(JOB_LOG_TIMESTAMP, ""));
}

function dropTrailingBlankLines(lines: readonly string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return lines.slice(0, end);
}

const RUNNER_TRAILER = /^(?:##\[group\]|Post job cleanup\.$|Cleaning up orphan processes$|Evaluate and set job outputs$|A job (?:started|completed) hook has been configured)/;

export function extractStepSummaryOutput(jobLog: string): string[] {
  const lines = jobLogLines(jobLog);
  for (const [scriptStart, line] of lines.entries()) {
    if (!line.startsWith("##[group]Run ")) continue;
    const scriptEnd = lines.indexOf("##[endgroup]", scriptStart);
    if (scriptEnd < 0) return [];
    if (!lines.slice(scriptStart, scriptEnd).some((scriptLine) => scriptLine.includes("GITHUB_STEP_SUMMARY"))) continue;
    const outputEnd = lines.findIndex((outputLine, i) => i > scriptEnd && RUNNER_TRAILER.test(outputLine));
    return dropTrailingBlankLines(lines.slice(scriptEnd + 1, outputEnd < 0 ? undefined : outputEnd));
  }
  return [];
}

const ERROR_CONTEXT_LINES = 20;
const ERROR_EXCERPT_MAX_LINES = 80;
const NO_ERROR_TAIL_LINES = 30;

export function extractJobErrorExcerpt(jobLog: string): string[] {
  const lines = dropTrailingBlankLines(jobLogLines(jobLog));
  const errorAt = lines.flatMap((line, i) => (line.startsWith("##[error]") ? [i] : []));
  if (errorAt.length === 0) {
    return lines.slice(-NO_ERROR_TAIL_LINES);
  }

  const excerpt: string[] = [];
  let shownUpTo = -1;
  for (const end of errorAt) {
    const start = Math.max(end - ERROR_CONTEXT_LINES, shownUpTo + 1);
    if (start > shownUpTo + 1 && excerpt.length > 0) excerpt.push("…");
    excerpt.push(...lines.slice(start, end + 1));
    shownUpTo = end;
  }
  return excerpt.length > ERROR_EXCERPT_MAX_LINES ? ["…", ...excerpt.slice(-(ERROR_EXCERPT_MAX_LINES - 1))] : excerpt;
}

function helpText(): string {
  return `Inspect GitHub Actions workflows and runs through the gh CLI.

Usage:
  bun src/util/non-fit/gh-workflow.ts inputs <owner/repo> <workflow-file>
  bun src/util/non-fit/gh-workflow.ts jobs <owner/repo> <run-id>
  bun src/util/non-fit/gh-workflow.ts job-log <owner/repo> <job-id> [summary-step-output|error-excerpt]

Subcommands:
  inputs    Print a workflow's dispatch inputs, with the defaults GitHub's form would use.
  jobs      Print a run's status and each job's conclusion.
  job-log   Print a job's log, or just the output of its step that writes the step summary,
            or its error excerpt.`;
}

if (isMain(import.meta.url)) {
  const [subcommand, repo, id, mode] = process.argv.slice(2);
  const help = process.argv.includes("--help") || process.argv.includes("-h");
  if (help || !subcommand || !repo || !id) {
    (help ? console.log : console.error)(helpText());
    process.exit(help ? 0 : 2);
  }
  runCli(async () => {
    if (subcommand === "inputs") {
      const inputs = await fetchWorkflowDispatchInputs({ repo, workflow: id });
      if (!inputs) throw new Error(`${id} not found in ${repo}.`);
      for (const input of inputs) {
        console.log(`${input.name} [${input.type}] default=${JSON.stringify(input.default)}${input.options.length > 0 ? ` options=${input.options.join("|")}` : ""}`);
      }
      return;
    }
    if (subcommand === "jobs") {
      const snapshot = await fetchRunSnapshot(repo, Number(id));
      console.log(`${snapshot.status} ${snapshot.conclusion}`);
      for (const job of snapshot.jobs) console.log(`  ${job.name.padEnd(40)} ${job.status} ${job.conclusion} ${job.url}`);
      return;
    }
    if (subcommand === "job-log") {
      const log = await fetchJobLog(repo, Number(id));
      const lines = mode === "summary-step-output" ? extractStepSummaryOutput(log) : mode === "error-excerpt" ? extractJobErrorExcerpt(log) : jobLogLines(log);
      console.log(lines.join("\n"));
      return;
    }
    console.error(`Unknown subcommand: ${subcommand}\n`);
    console.error(helpText());
    process.exit(2);
  });
}
