/**
 * Step: deploy a Capella sandbox control plane by dispatching couchbase-cloud's
 * `sandbox/deploy-control-plane` GitHub Actions workflow, wait for it, and show the two
 * summaries it produces — or, if it fails, the errors from the jobs that failed.
 *
 * Asking for the inputs (askSandboxDeployInputs) is kept apart from deploying with them
 * (deploySandbox), which returns the sandbox as data for a flow that goes on to use it.
 * Following a run (followSandboxDeploy) also works for one already dispatched, which is
 * how to re-check a finished deploy's summaries or failures without deploying again.
 *
 * Run on its own:
 *   bun src/fit/sandbox/deploy/deploy-sandbox.ts
 *   bun src/fit/sandbox/deploy/deploy-sandbox.ts --auto
 *   bun src/fit/sandbox/deploy/deploy-sandbox.ts follow <run-id or run URL>
 *   bun src/fit/sandbox/deploy/deploy-sandbox.ts --help
 */
import { writeFileSync } from "node:fs";
import type { Detail, RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliError, fitCliWarn, runScriptPrefix } from "../../../util/non-fit/fit-cli-log.js";
import {
  dispatchWorkflow,
  extractJobErrorExcerpt,
  extractStepSummaryOutput,
  fetchJobLog,
  fetchWorkflowDispatchInputs,
  ghRunUrl,
  jobLogLines,
  parseRunIdFromUrl,
  waitForRunCompletion,
  type GhJobSummary,
  type GhWorkflow,
  type WorkflowDispatchInput,
} from "../../../util/non-fit/gh-workflow.js";
import { createLogFile } from "../../../util/non-fit/proc.js";
import { confirm, input, qualifyPromptId, select } from "../../../util/non-fit/prompts.js";
import { extractInteractiveFlag, extractReplayFlag, markNonInteractiveByDefault } from "../../../util/non-fit/replay.js";

export const SANDBOX_DEPLOY_WORKFLOW: GhWorkflow = {
  repo: "couchbasecloud/couchbase-cloud",
  workflow: "sandbox-deploy-control-plane.yml",
};
const SANDBOX_DEPLOY_ORG = SANDBOX_DEPLOY_WORKFLOW.repo.split("/")[0];

export const FIT_CLI_INPUT_DEFAULTS: Readonly<Record<string, string>> = {
  type: "sbx",
  branch: "main",
  "reserved-hours": "10",
};

const REPORT_SUMMARY_JOB = "summary";
const REPORT_SUMMARY_STEP = /^Report Summary \((?<sandboxId>[^)]+)\)$/;
const OUTPUT_SUMMARY_JOB = "output-summary";

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "startup_failure"]);

export interface DeployedSandbox {
  sandboxId: string;
  uiUrl: string;
  runUrl: string;
}

function acceptsValue(workflowInput: WorkflowDispatchInput, value: string): boolean {
  return workflowInput.options.length === 0 || workflowInput.options.includes(value);
}

export function applyFitCliDefaults(
  inputs: readonly WorkflowDispatchInput[],
  overrides: Readonly<Record<string, string>> = FIT_CLI_INPUT_DEFAULTS,
): { inputs: WorkflowDispatchInput[]; unapplied: string[] } {
  const unapplied = Object.entries(overrides)
    .filter(([name, value]) => {
      const workflowInput = inputs.find((candidate) => candidate.name === name);
      return !workflowInput || !acceptsValue(workflowInput, value);
    })
    .map(([name]) => name);
  return {
    inputs: inputs.map((workflowInput) => {
      const ours = Object.hasOwn(overrides, workflowInput.name) ? overrides[workflowInput.name] : undefined;
      return ours !== undefined && acceptsValue(workflowInput, ours) ? { ...workflowInput, default: ours } : workflowInput;
    }),
    unapplied,
  };
}

export function selectedSandboxId(jobs: readonly GhJobSummary[]): string | undefined {
  const summaryJob = jobs.find((job) => job.name === REPORT_SUMMARY_JOB);
  for (const step of summaryJob?.steps ?? []) {
    const sandboxId = REPORT_SUMMARY_STEP.exec(step.name)?.groups?.sandboxId;
    if (sandboxId) return sandboxId;
  }
  return undefined;
}

export function parseOutputSummaryUiUrl(outputSummary: readonly string[]): string | undefined {
  const heading = outputSummary.findIndex((line) => line.trim() === "#### UI");
  const line = heading >= 0 ? outputSummary.slice(heading + 1).find((candidate) => candidate.trim() !== "")?.trim() : undefined;
  if (!line || !URL.canParse(line)) return undefined;
  const url = new URL(line);
  return url.protocol === "https:" ? url.origin : undefined;
}

export function renderReportSummary(headBranch: string, inputs: Readonly<Record<string, string>>): string[] {
  return ["### Branch", `\`refs/heads/${headBranch}\``, "### Inputs", "```json", JSON.stringify(inputs, null, 2), "```"];
}

export function failedJobs(jobs: readonly GhJobSummary[]): GhJobSummary[] {
  return jobs.filter((job) => FAILED_CONCLUSIONS.has(job.conclusion));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const PROMPT_MESSAGES: Readonly<Record<string, string>> = {
  "cloud-id": "Sandbox to deploy to, e.g. sbx-25 (leave empty to pick a free one of the chosen type)",
};

export function promptMessage(workflowInput: WorkflowDispatchInput): string {
  return Object.hasOwn(PROMPT_MESSAGES, workflowInput.name)
    ? PROMPT_MESSAGES[workflowInput.name]
    : `${workflowInput.name} — ${workflowInput.description || "(no description)"}`;
}

async function askInputs(inputs: readonly WorkflowDispatchInput[], promptIdPrefix?: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const workflowInput of inputs) {
    const promptId = qualifyPromptId(`sandbox.deploy.${workflowInput.name}`, promptIdPrefix);
    const message = promptMessage(workflowInput);
    values[workflowInput.name] = workflowInput.options.length > 0
      ? await select<string>({
          promptId,
          message,
          choices: workflowInput.options.map((option) => ({ name: option, value: option })),
          default: workflowInput.default,
        })
      : (await input({
          promptId,
          message,
          default: workflowInput.default,
          validate: (value) => !workflowInput.required || value.trim() !== "" || `${workflowInput.name} is required.`,
        })).trim();
  }
  return values;
}

function printBlock(title: string, lines: readonly string[]): void {
  console.log(`\n── ${title} ──\n${lines.join("\n")}\n`);
}

async function reportFailedJobs(jobs: readonly GhJobSummary[]): Promise<void> {
  const failed = failedJobs(jobs);
  if (failed.length === 0) {
    fitCliError("No job reports a failure — the run may have been cancelled before any job started.");
    return;
  }
  const logs = await Promise.allSettled(
    failed.map((job) => (job.steps.length > 0 ? fetchJobLog(SANDBOX_DEPLOY_WORKFLOW.repo, job.databaseId) : Promise.resolve(undefined))),
  );
  for (const [i, job] of failed.entries()) {
    const failedSteps = job.steps.filter((step) => FAILED_CONCLUSIONS.has(step.conclusion)).map((step) => step.name);
    fitCliError(`✗ ${job.name} (${job.conclusion}) — ${job.url}`);
    const fetched = logs[i];
    let excerpt: string[];
    if (fetched.status === "rejected") {
      excerpt = [`(couldn't fetch this job's log: ${errorMessage(fetched.reason)} — see ${job.url})`];
    } else if (fetched.value === undefined) {
      excerpt = ["(the job never started, so it has no log)"];
    } else {
      excerpt = extractJobErrorExcerpt(fetched.value);
      try {
        const logPath = createLogFile(`gha-job-${job.name.replace(/[^A-Za-z0-9._-]+/g, "-")}`);
        writeFileSync(logPath, jobLogLines(fetched.value).join("\n"));
        excerpt.push("", `Full job log: ${logPath}`);
      } catch (err) {
        excerpt.push("", `(couldn't save the full job log: ${errorMessage(err)})`);
      }
    }
    printBlock(failedSteps.length > 0 ? `${job.name}: ${failedSteps.join(", ")}` : job.name, excerpt);
  }
}

async function readOutputSummary(jobs: readonly GhJobSummary[]): Promise<string[]> {
  const outputJob = jobs.find((job) => job.name === OUTPUT_SUMMARY_JOB);
  if (!outputJob) return [];
  try {
    return extractStepSummaryOutput(await fetchJobLog(SANDBOX_DEPLOY_WORKFLOW.repo, outputJob.databaseId));
  } catch (err) {
    fitCliWarn(`Couldn't fetch the ${OUTPUT_SUMMARY_JOB} job's log: ${errorMessage(err)}`);
    return [];
  }
}

export async function askSandboxDeployInputs(promptIdPrefix?: string): Promise<Record<string, string> | undefined> {
  const workflow = SANDBOX_DEPLOY_WORKFLOW;
  console.log(
    `\nThis deploys a Capella sandbox control plane by dispatching ${workflow.workflow} on ${workflow.repo}` +
      ` (needs gh authorised for the ${SANDBOX_DEPLOY_ORG} org).\nThe inputs below are read from the` +
      ` workflow itself, with its defaults except for ${Object.keys(FIT_CLI_INPUT_DEFAULTS).join(", ")}.\n`,
  );
  const workflowInputs = await fetchWorkflowDispatchInputs(workflow);
  if (workflowInputs.length === 0) {
    throw new Error(`Found no workflow_dispatch inputs in ${workflow.workflow} on ${workflow.repo} — has the workflow moved or changed shape?`);
  }
  const { inputs, unapplied } = applyFitCliDefaults(workflowInputs);
  if (unapplied.length > 0) {
    fitCliWarn(
      `The workflow no longer takes fit-cli's default for ${unapplied.map((name) => `${name}=${FIT_CLI_INPUT_DEFAULTS[name]}`).join(", ")}` +
        `; its own default is used instead.`,
    );
  }
  const values = await askInputs(inputs, promptIdPrefix);

  printBlock("Inputs", Object.entries(values).map(([name, value]) => `  ${name.padEnd(28)} ${value === "" ? "(empty)" : value}`));
  const proceed = await confirm({
    promptId: qualifyPromptId("sandbox.deploy.confirm", promptIdPrefix),
    message: "Deploy the sandbox with these inputs?",
    default: true,
  });
  if (!proceed) {
    console.log("Not deploying.");
    return undefined;
  }
  return values;
}

export async function followSandboxDeploy(runId: number, values?: Readonly<Record<string, string>>): Promise<DeployedSandbox> {
  const runUrl = ghRunUrl(SANDBOX_DEPLOY_WORKFLOW.repo, runId);
  console.log(`\nFollowing run: ${runUrl}\n`);
  console.log(
    "Waiting for it to finish — it applies Terraform for the VPC, EKS, Kubernetes and every Capella service," +
      " so expect a long wait. Ctrl-C only stops fit-cli waiting; the deploy carries on in GitHub Actions.",
  );

  let sandboxId: string | undefined;
  const finished = await waitForRunCompletion(SANDBOX_DEPLOY_WORKFLOW.repo, runId, (snapshot) => {
    if (sandboxId) return;
    sandboxId = selectedSandboxId(snapshot.jobs);
    if (sandboxId) console.log(`  Deploying to sandbox ${sandboxId}`);
  });

  if (values) {
    printBlock("Report Summary", renderReportSummary(finished.headBranch, values));
  }

  if (finished.conclusion !== "success") {
    fitCliError(`Sandbox deploy finished with conclusion "${finished.conclusion}": ${runUrl}`);
    await reportFailedJobs(finished.jobs);
    throw new Error(`Sandbox deploy${sandboxId ? ` of ${sandboxId}` : ""} failed — see the failed jobs above and ${runUrl}`);
  }

  const outputSummary = await readOutputSummary(finished.jobs);
  printBlock(
    "Output Summary",
    outputSummary.length > 0 ? outputSummary : [`(the ${OUTPUT_SUMMARY_JOB} job's output couldn't be read — see ${runUrl})`],
  );
  const uiUrl = parseOutputSummaryUiUrl(outputSummary);
  if (!sandboxId || !uiUrl) {
    throw new Error(`The sandbox deployed, but fit-cli couldn't read its ${sandboxId ? "UI URL" : "id"} back from ${runUrl}`);
  }
  console.log(`✓ Sandbox ${sandboxId} deployed: ${uiUrl}`);
  return { sandboxId, uiUrl, runUrl };
}

export async function deploySandbox(values: Readonly<Record<string, string>>): Promise<DeployedSandbox> {
  return followSandboxDeploy(await dispatchWorkflow(SANDBOX_DEPLOY_WORKFLOW, values), values);
}

function sandboxDetails(sandbox: DeployedSandbox): RunOutput {
  const details: Detail[] = [
    { label: "GitHub Actions run", value: sandbox.runUrl },
    { label: "Sandbox", value: sandbox.sandboxId },
    { label: "Sandbox UI", value: sandbox.uiUrl },
  ];
  return { artifacts: [], details };
}

export async function runSandboxDeploy(): Promise<RunOutput> {
  const values = await askSandboxDeployInputs();
  return values ? sandboxDetails(await deploySandbox(values)) : { artifacts: [], details: [] };
}

export function withoutPromptSessionFlags(argv: string[]): string[] {
  return extractInteractiveFlag(extractReplayFlag(argv).positionals).positionals;
}

const AUTO_FLAG = "--auto";

export function parseDeployArgs(argv: string[]): { auto: boolean; unexpected: string[] } {
  const positionals = withoutPromptSessionFlags(argv);
  return { auto: positionals.includes(AUTO_FLAG), unexpected: positionals.filter((arg) => arg !== AUTO_FLAG) };
}

export function applyDeployAutoFlag(argv: string[]): void {
  if (parseDeployArgs(argv).auto) markNonInteractiveByDefault();
}

function helpText(): string {
  return `Deploy a Capella sandbox control plane through couchbase-cloud's GitHub Actions workflow.

Usage:
  ${runScriptPrefix("sandbox")} deploy [${AUTO_FLAG}]
  ${runScriptPrefix("sandbox")} deploy --help

  ${AUTO_FLAG}    Ask nothing: deploy straight away with the defaults below.

Asks for each input of ${SANDBOX_DEPLOY_WORKFLOW.workflow} (read live from
${SANDBOX_DEPLOY_WORKFLOW.repo}, so the options always match the workflow), dispatches
it, and waits for it to finish. On success it prints the workflow's Report and Output
summaries; on failure, the errors from each failed job, with their full logs saved as
artifacts.

fit-cli's own defaults (every other input defaults to the workflow's):
${Object.entries(FIT_CLI_INPUT_DEFAULTS).map(([name, value]) => `  ${name.padEnd(16)} ${value}`).join("\n")}

On CI (CI=true) it asks nothing even without ${AUTO_FLAG}.

Requires gh, authorised (SSO) for the ${SANDBOX_DEPLOY_ORG} org.`;
}

export async function runSandboxDeployMain(argv: string[]): Promise<RunOutput | void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(helpText());
    return;
  }
  if (parseDeployArgs(argv).unexpected.length > 0) {
    console.error(helpText());
    process.exit(2);
  }
  return runSandboxDeploy();
}

if (isMain(import.meta.url)) {
  applyDeployAutoFlag(process.argv.slice(2));
  runCli(async () => {
    const [subcommand, runRef, ...extra] = withoutPromptSessionFlags(process.argv.slice(2));
    if (subcommand !== "follow") {
      return runSandboxDeployMain(process.argv.slice(2));
    }
    const runId = runRef === undefined ? undefined : /^\d+$/.test(runRef) ? Number(runRef) : parseRunIdFromUrl(runRef);
    if (runId === undefined || extra.length > 0) {
      console.error("Usage: bun src/fit/sandbox/deploy/deploy-sandbox.ts follow <run-id or run URL>");
      process.exit(2);
    }
    return sandboxDetails(await followSandboxDeploy(runId));
  });
}
