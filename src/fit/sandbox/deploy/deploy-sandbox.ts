/**
 * Step: deploy a Capella sandbox control plane by dispatching couchbase-cloud's
 * `sandbox/deploy-control-plane` GitHub Actions workflow, wait for it, and show the two
 * summaries it produces — or, if it fails, the errors from the jobs that failed.
 *
 * Asking for the inputs (askSandboxDeployInputs) is kept apart from deploying with them
 * (deploySandbox), which returns the sandbox as data for a flow that goes on to use it.
 * Following a run (followSandboxDeploy) also works for one already dispatched, which is
 * how to re-check a finished deploy's Output Summary or failures without deploying again.
 * Its Report Summary is shown only for a run fit-cli dispatched: it lists the dispatched
 * inputs, which GitHub doesn't report for a run.
 *
 * Run on its own:
 *   bun src/fit/sandbox/deploy/deploy-sandbox.ts
 *   bun src/fit/sandbox/deploy/deploy-sandbox.ts --auto
 *   bun src/fit/sandbox/deploy/deploy-sandbox.ts follow <run-id or run URL>
 *   bun src/fit/sandbox/deploy/deploy-sandbox.ts --help
 */
import { writeFileSync } from "node:fs";
import { parseKeyValueFlag } from "../../definition/generate-preset/generate-preset.js";
import type { RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliError, fitCliWarn, runScriptPrefix } from "../../../util/non-fit/fit-cli-log.js";
import {
  dispatchWorkflow,
  extractJobErrorExcerpt,
  extractStepSummaryOutput,
  fetchJobLog,
  fetchRunWorkflowPath,
  fetchWorkflowDispatchInputs,
  findRefs,
  ghRunListCommand,
  ghRunUrl,
  jobLogLines,
  parseRunIdFromUrl,
  repoVisible,
  waitForRunCompletion,
  workflowFilePath,
  type GhJobSummary,
  type GhWorkflow,
  type WorkflowDispatchInput,
} from "../../../util/non-fit/gh-workflow.js";
import { createLogFile } from "../../../util/non-fit/proc.js";
import { input, qualifyPromptId, select } from "../../../util/non-fit/prompts.js";
import { defaultsToNonInteractive, extractInteractiveFlag, extractReplayFlag, markNonInteractiveByDefault } from "../../../util/non-fit/replay.js";

export const SANDBOX_DEPLOY_WORKFLOW: GhWorkflow = {
  repo: "couchbasecloud/couchbase-cloud",
  workflow: "sandbox-deploy-control-plane.yml",
};
const GH_AUTH = `gh authorised (SSO) for the ${SANDBOX_DEPLOY_WORKFLOW.repo.split("/")[0]} org`;

export const FIT_CLI_INPUT_DEFAULTS: Readonly<Record<string, string>> = {
  type: "sbx",
  "reserved-hours": "10",
};

const DEFAULT_GHA_BRANCH = "main";
const AUTO_FLAG = "--auto";

export const sandboxCommand = (args: string): string => `${runScriptPrefix("sandbox")} ${args}`;
export const deployUsage = (): string => sandboxCommand(`deploy [${AUTO_FLAG}] [--gha-ref <branch-or-tag>] [--input <name>=<value>]...`);
export const followUsage = (): string => sandboxCommand("follow <run-id or run URL>");
export const DEPLOY_SUMMARY = "Deploy a Capella sandbox control plane through GitHub Actions and print its summaries.";
export const FOLLOW_SUMMARY = "Pick a deploy run up again (e.g. after Ctrl-C) and report it, without deploying.";

export interface SandboxDeployRequest { ref: string; fullRef: string; values: Record<string, string> }

export interface SandboxDeployOptions { ref?: string; inputs?: Readonly<Record<string, string>>; promptIdPrefix?: string }

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

export function renderReportSummary(ref: string, inputs: Readonly<Record<string, string>>): string[] {
  return ["### Branch", `\`${ref}\``, "### Inputs", "```json", JSON.stringify(inputs, null, 2), "```"];
}

export function failed<T extends { conclusion: string }>(items: readonly T[]): T[] {
  return items.filter((item) => FAILED_CONCLUSIONS.has(item.conclusion));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const PROMPT_MESSAGES: Readonly<Record<string, string>> = {
  "cloud-id": "Sandbox to deploy to, e.g. sbx-25 (leave empty to pick a free one of the chosen type)",
  "image-tag": "Container image tag for the Capella services",
  // `branch` also takes a branch or tag, but it only picks the Terraform checked out (the GHA branch or tag
  // picks the workflow), so we take just a full commit hash to keep the two apart.
  branch: "Full commit hash to deploy (leave empty for the latest on the GHA branch or tag)",
};

export function promptMessage(workflowInput: WorkflowDispatchInput): string {
  return Object.hasOwn(PROMPT_MESSAGES, workflowInput.name)
    ? PROMPT_MESSAGES[workflowInput.name]
    : `${workflowInput.name} — ${workflowInput.description || "(no description)"}`;
}

export function validateInput(workflowInput: WorkflowDispatchInput, value: string): true | string {
  if (workflowInput.required && value === "") return `${workflowInput.name} is required.`;
  if (workflowInput.name === "branch" && !/^([0-9a-f]{40})?$/i.test(value)) return "Enter a full 40-character commit hash, or leave it empty.";
  return true;
}

export const isYes = (answer: string): boolean => ["y", "yes"].includes(answer.trim().toLowerCase());

async function askTrimmed(config: Parameters<typeof input>[0]): Promise<string> {
  const { validate } = config;
  return (await input({ ...config, validate: validate && ((value) => validate(value.trim())) })).trim();
}

async function askInputs(inputs: readonly WorkflowDispatchInput[], promptIdPrefix?: string): Promise<Record<string, string>> {
  const values = Object.create(null) as Record<string, string>;
  for (const workflowInput of inputs) {
    const promptId = qualifyPromptId(`sandbox.deploy.input.${workflowInput.name}`, promptIdPrefix);
    const message = promptMessage(workflowInput);
    values[workflowInput.name] = workflowInput.options.length > 0
      ? await select<string>({
          promptId,
          message,
          choices: workflowInput.options.map((option) => ({ name: option, value: option })),
          default: workflowInput.default,
        })
      : await askTrimmed({
          promptId,
          message,
          default: workflowInput.default,
          validate: (value) => validateInput(workflowInput, value),
        });
  }
  return values;
}

function printBlock(title: string, lines: readonly string[]): void {
  console.log(`\n── ${title} ──\n${lines.join("\n")}\n`);
}

async function reportFailedJobs(jobs: readonly GhJobSummary[]): Promise<void> {
  const failedJobs = failed(jobs);
  if (failedJobs.length === 0) {
    fitCliError("No job reports a failure — the run may have been cancelled before any job started.");
    return;
  }
  const logs = await Promise.allSettled(
    failedJobs.map((job) => (job.steps.length > 0 ? fetchJobLog(SANDBOX_DEPLOY_WORKFLOW.repo, job.databaseId) : Promise.resolve(undefined))),
  );
  for (const [i, job] of failedJobs.entries()) {
    const failedSteps = failed(job.steps).map((step) => step.name);
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

interface GhaRef { ref: string; fullRef: string; inputs: WorkflowDispatchInput[] }

async function findGhaRefs(workflow: GhWorkflow, name: string): Promise<GhaRef[] | string> {
  const shortName = name.replace(/^refs\/(?:heads|tags)\//, "");
  const all = await findRefs(workflow.repo, shortName);
  const refs = all.filter((fullRef) => name === shortName || fullRef === name);
  if (refs.length === 0) {
    if (!(await repoVisible(workflow.repo))) {
      throw new Error(`gh can't see ${workflow.repo}: check gh auth status; this needs ${GH_AUTH}.`);
    }
    return `${workflow.repo} has no branch or tag named ${name}`;
  }
  const found = await Promise.all(refs.map(async (fullRef) => ({
    ref: all.length === 1 ? shortName : fullRef,
    fullRef,
    inputs: await fetchWorkflowDispatchInputs(workflow, fullRef) ?? [],
  })));
  const runnable = found.filter((ghaRef) => ghaRef.inputs.length > 0);
  return runnable.length > 0 ? runnable : `${workflow.workflow} isn't on ${name}, or takes no workflow_dispatch inputs there`;
}

const shellQuote = (arg: string): string => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);

export async function askSandboxDeployInputs(
  { ref: givenRef, inputs: given = {}, promptIdPrefix }: SandboxDeployOptions = {},
): Promise<SandboxDeployRequest | undefined> {
  const workflow = SANDBOX_DEPLOY_WORKFLOW;
  const defaults = { ...FIT_CLI_INPUT_DEFAULTS, ...given };
  console.log(
    `\nThis deploys a Capella sandbox control plane by dispatching ${workflow.workflow} on ${workflow.repo}` +
      ` (needs ${GH_AUTH}).\nThe inputs below are read from the` +
      ` workflow itself, with its defaults except for ${Object.keys(defaults).join(", ")}.\n`,
  );
  let lookup: { name: string; found: Promise<GhaRef[] | string> } | undefined;
  const lookUp = (name: string) => (lookup?.name === name ? lookup : (lookup = { name, found: findGhaRefs(workflow, name) })).found;
  const name = await askTrimmed({
    promptId: qualifyPromptId("sandbox.deploy.gha-branch", promptIdPrefix),
    message: `GHA branch or tag — the ${workflow.repo} branch or tag to run ${workflow.workflow} from`,
    default: givenRef ?? DEFAULT_GHA_BRANCH,
    validate: async (value) => {
      if (value === "") return "A branch or tag is required.";
      const found = await lookUp(value).catch(() => true);
      return typeof found === "string" ? found : true;
    },
  });
  const found = await lookUp(name);
  if (typeof found === "string") throw new Error(found);
  const fullRef = found.length === 1 ? found[0].fullRef : await select<string>({
    promptId: qualifyPromptId("sandbox.deploy.gha-ref-kind", promptIdPrefix),
    message: `${name} is both a branch and a tag — which one?`,
    choices: found.map((ghaRef) => ({ name: ghaRef.fullRef.startsWith("refs/tags/") ? "Tag" : "Branch", value: ghaRef.fullRef })),
  });
  const chosen = found.find((ghaRef) => ghaRef.fullRef === fullRef);
  if (!chosen) throw new Error(`${fullRef} isn't one of ${found.map((ghaRef) => ghaRef.fullRef).join(", ")}.`);
  const { ref, inputs: workflowInputs } = chosen;

  const problems = Object.entries(given).flatMap(([key, value]) => {
    const workflowInput = workflowInputs.find((candidate) => candidate.name === key);
    const problem = !workflowInput
      ? "no such input"
      : acceptsValue(workflowInput, value) ? validateInput(workflowInput, value) : `takes ${workflowInput.options.join(", ")}`;
    return problem === true ? [] : [`--input ${key}=${value} (${problem})`];
  });
  if (problems.length > 0) throw new Error(`${workflow.workflow} on ${ref} doesn't take ${problems.join("; ")}`);
  const { inputs, unapplied } = applyFitCliDefaults(workflowInputs, defaults);
  if (unapplied.length > 0) {
    fitCliWarn(
      `The workflow no longer takes fit-cli's default for ${unapplied.map((key) => `${key}=${FIT_CLI_INPUT_DEFAULTS[key]}`).join(", ")}` +
        `; its own default is used instead.`,
    );
  }
  const values = await askInputs(inputs, promptIdPrefix);

  printBlock("Inputs", Object.entries(values).map(([name, value]) => `  ${name.padEnd(28)} ${value === "" ? "(empty)" : value}`));
  const changed = applyFitCliDefaults(workflowInputs).inputs.filter((workflowInput) => values[workflowInput.name] !== workflowInput.default);
  const repro = [
    ...(ref === DEFAULT_GHA_BRANCH ? [] : ["--gha-ref", ref]),
    ...changed.flatMap((workflowInput) => ["--input", `${workflowInput.name}=${values[workflowInput.name]}`]),
  ];
  console.log(`The same deploy without questions: ${[sandboxCommand(`deploy ${AUTO_FLAG}`), ...repro.map(shellQuote)].join(" ")}\n`);
  const answer = await askTrimmed({
    promptId: qualifyPromptId("sandbox.deploy.confirm", promptIdPrefix),
    message: "Deploy the sandbox with these inputs? (y/N)",
    default: defaultsToNonInteractive() ? "yes" : "",
  });
  if (!isYes(answer)) {
    console.log("Not deploying.");
    return undefined;
  }
  return { ref, fullRef, values };
}

export async function followSandboxDeploy(runId: number, request?: SandboxDeployRequest): Promise<DeployedSandbox> {
  const runUrl = ghRunUrl(SANDBOX_DEPLOY_WORKFLOW.repo, runId);
  const pickUp = `the deploy carries on in GitHub Actions, and ${sandboxCommand(`follow ${runUrl}`)} picks it up again`;
  console.log(`\nFollowing run: ${runUrl}\n`);
  console.log(
    "Waiting for it to finish — it applies Terraform for the VPC, EKS, Kubernetes and every Capella service," +
      ` so expect a long wait. Ctrl-C only stops fit-cli waiting; ${pickUp}.`,
  );

  let sandboxId: string | undefined;
  const finished = await waitForRunCompletion(SANDBOX_DEPLOY_WORKFLOW.repo, runId, (snapshot) => {
    if (sandboxId) return;
    sandboxId = selectedSandboxId(snapshot.jobs);
    if (sandboxId) console.log(`  Deploying to sandbox ${sandboxId}`);
  }).catch((err: unknown) => {
    throw new Error(`Lost track of ${runUrl} (cause below); ${pickUp}.`, { cause: err });
  });

  printBlock(
    "Report Summary",
    request
      ? renderReportSummary(request.fullRef, request.values)
      : ["(shown only when this session dispatched the run: it lists the dispatch inputs, which GitHub doesn't report)"],
  );

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

export async function deploySandbox(request: SandboxDeployRequest): Promise<DeployedSandbox> {
  const runId = await dispatchWorkflow(SANDBOX_DEPLOY_WORKFLOW, request.values, request.ref);
  if (runId === undefined) {
    throw new Error(
      `Dispatched the deploy, but gh didn't say which run it started (upgrade gh to fix this). Find it with` +
        ` ${ghRunListCommand(SANDBOX_DEPLOY_WORKFLOW)}, then pick it up with ${followUsage()}.`,
    );
  }
  return followSandboxDeploy(runId, request);
}

function sandboxDetails({ runUrl, sandboxId, uiUrl }: DeployedSandbox): RunOutput {
  return {
    artifacts: [],
    details: [{ label: "GitHub Actions run", value: runUrl }, { label: "Sandbox", value: sandboxId }, { label: "Sandbox UI", value: uiUrl }],
  };
}

export async function runSandboxDeploy(options: SandboxDeployOptions = {}): Promise<RunOutput> {
  const request = await askSandboxDeployInputs(options);
  return request ? sandboxDetails(await deploySandbox(request)) : { artifacts: [], details: [] };
}

export function commandArgs(argv: string[]): string[] {
  return extractInteractiveFlag(extractReplayFlag(argv).positionals).positionals.map((arg) => arg.trim());
}

export function parseDeployArgs(argv: string[]): { auto: boolean; ref?: string; inputs: Record<string, string> } {
  const args = commandArgs(argv);
  const parsed = { auto: false, ref: undefined as string | undefined, inputs: Object.create(null) as Record<string, string> };
  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1];
    if (args[i] === AUTO_FLAG) parsed.auto = true;
    else if (args[i] === "--gha-ref" && next && !next.startsWith("-")) parsed.ref = args[++i];
    else if (args[i] === "--input" && next !== undefined) {
      const [key, value] = parseKeyValueFlag("--input", args[++i]);
      parsed.inputs[key.trim()] = value.trim();
    } else throw new Error(args[i] === "--gha-ref" || args[i] === "--input" ? `${args[i]} needs a value.` : `Unexpected argument: ${args[i]}`);
  }
  return parsed;
}

export function parseFollowArgs(argv: string[]): number {
  const [runRef, ...extra] = commandArgs(argv);
  if (runRef === undefined || extra.length > 0) throw new Error("Expected one run id or run URL.");
  if (/^\d+$/.test(runRef)) return Number(runRef);
  const runId = parseRunIdFromUrl(runRef);
  if (runId === undefined || !runRef.startsWith(ghRunUrl(SANDBOX_DEPLOY_WORKFLOW.repo, runId))) {
    throw new Error(`Not a ${SANDBOX_DEPLOY_WORKFLOW.repo} run id or run URL: ${runRef}`);
  }
  return runId;
}

function parseArgsOrExit<T>(argv: string[], parse: (argv: string[]) => T, helpText: () => string): T | undefined {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(helpText());
    return undefined;
  }
  try {
    return parse(argv);
  } catch (err) {
    console.error(`${errorMessage(err)}\n\n${helpText()}`);
    process.exit(2);
  }
}

function deployHelpText(): string {
  return `${DEPLOY_SUMMARY}

Usage:
  ${deployUsage()}
  ${sandboxCommand("deploy --help")}

  ${AUTO_FLAG}                     Ask nothing: deploy straight away with the defaults.
  --gha-ref <branch-or-tag>  Default for the GHA branch or tag (otherwise ${DEFAULT_GHA_BRANCH}).
  --input <name>=<value>     Default for one of the workflow's inputs (repeatable), named as in
                             the Inputs list shown before the deploy is confirmed.

Examples:
  ${sandboxCommand("deploy")}
      Ask for everything, with the defaults pre-filled.
  ${sandboxCommand(`deploy ${AUTO_FLAG}`)}
      Deploy from ${DEFAULT_GHA_BRANCH} with every default, without asking.
  ${sandboxCommand(`deploy ${AUTO_FLAG} --gha-ref my-branch --input reserved-hours=5 --input image-tag=my-branch`)}
      Deploy my-branch's workflow and service images for 5 hours, without asking.
  ${followUsage()}
      ${FOLLOW_SUMMARY}

Asks for the GHA branch or tag to run ${SANDBOX_DEPLOY_WORKFLOW.workflow} from (default ${DEFAULT_GHA_BRANCH}),
then for each of its inputs (read live from that ref, so the options always match), dispatches
it, and waits for it to finish. On success it prints the workflow's Report and Output
summaries; on failure, the errors from each failed job, with their full logs saved as
artifacts.

fit-cli's own defaults (every other input defaults to the workflow's):
${Object.entries(FIT_CLI_INPUT_DEFAULTS).map(([name, value]) => `  ${name.padEnd(16)} ${value}`).join("\n")}

On CI (CI=true) it asks nothing even without ${AUTO_FLAG}.

Requires ${GH_AUTH}.`;
}

export function runSandboxDeployMain(argv: string[]): void {
  const args = parseArgsOrExit(argv, parseDeployArgs, deployHelpText);
  if (!args) return;
  if (args.auto) markNonInteractiveByDefault();
  runCli(() => runSandboxDeploy(args));
}

function followHelpText(): string {
  return `${FOLLOW_SUMMARY}
It waits for the run, then prints its Output Summary, or the failed jobs' errors.

Usage:
  ${followUsage()}`;
}

export function runSandboxFollowMain(argv: string[]): void {
  const runId = parseArgsOrExit(argv, parseFollowArgs, followHelpText);
  if (runId === undefined) return;
  runCli(async () => {
    const path = await fetchRunWorkflowPath(SANDBOX_DEPLOY_WORKFLOW.repo, runId);
    if (path === undefined) throw new Error(`gh can't find run ${runId} in ${SANDBOX_DEPLOY_WORKFLOW.repo}.`);
    if (path !== workflowFilePath(SANDBOX_DEPLOY_WORKFLOW)) throw new Error(`Run ${runId} is a ${path} run, not a sandbox deploy.`);
    return sandboxDetails(await followSandboxDeploy(runId));
  });
}

if (isMain(import.meta.url)) {
  const [subcommand, ...rest] = commandArgs(process.argv.slice(2));
  if (subcommand === "follow") runSandboxFollowMain(rest);
  else runSandboxDeployMain(process.argv.slice(2));
}
