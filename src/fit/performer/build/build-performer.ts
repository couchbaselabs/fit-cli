/**
 * Step: dispatch a "build FIT performer" GitHub Actions workflow for an SDK
 * family, wait for it to finish, and report the resulting performer image
 * names.
 *
 * Run on its own:
 *   bun src/fit/performer/build/build-performer.ts jvm refs/changes/01/248901/3
 */
import { capture, run } from "../../../util/non-fit/proc.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliWarn, runScriptPrefix } from "../../../util/non-fit/fit-cli-log.js";
import type { RunOutput, Detail } from "../../../util/non-fit/artifacts.js";
import { sdkByPerformerImageBasename, sdkByValue } from "../../../util/sdk/sdks.js";
import { performerImageName, performerImageShortName } from "../../performers/util/performer-image.js";

/** An SDK family whose performer image(s) are built by a single GitHub Actions workflow. */
export interface PerformerBuildFamily {
  value: string;
  /** `owner/repo` that hosts the build workflow. */
  repo: string;
  /** Workflow file name, as passed to `gh workflow run`. */
  workflow: string;
}

// The JVM SDKs (Java, Scala, Kotlin) plus the Java Columnar performer are built from
// couchbase-jvm-clients' single matrixed workflow. analytics-dotnet builds from its
// own repo's publish workflow. Add entries here as other repos grow an equivalent
// workflow. Each workflow must set `run-name: ${{ inputs.ref }}` (so pickDispatchedRun
// can match the run by its ref) and name its build job(s) `publish (<sdk>)` (so
// summariseBuildJobs can map each back to an SDK — see parseMatrixJobSdk).
export const PERFORMER_BUILD_FAMILIES: readonly PerformerBuildFamily[] = [
  { value: "jvm", repo: "couchbase/couchbase-jvm-clients", workflow: "build-fit-performer.yml" },
  { value: "analytics-dotnet", repo: "couchbase/analytics-dotnet-client", workflow: "publish-fit-performer.yml" },
];

export function performerBuildFamilyByValue(value: string): PerformerBuildFamily | undefined {
  return PERFORMER_BUILD_FAMILIES.find((family) => family.value === value);
}

/**
 * Mirrors the tag computed by couchbaselabs/sdk-docker-build-action's "Set
 * environment variables" step (the composite action every performer-build
 * workflow uses) — see
 * https://github.com/couchbaselabs/sdk-docker-build-action/blob/main/action.yml.
 * GitHub exposes neither that action's outputs nor the run's step summary via
 * API, so this is the only way to know the resulting image tag without
 * scraping the run's HTML page; verified against a real published image with
 * `docker manifest inspect`.
 */
export function computeGithubActionsImageTag(ref: string): string {
  const trimmed = ref.trim();
  if (/^[0-9a-f]{40}$/.test(trimmed)) {
    return `sha-${trimmed.slice(0, 12)}`;
  }
  if (/^v[0-9]/.test(trimmed)) {
    return trimmed.slice(1);
  }
  if (trimmed === "master") {
    return "main";
  }
  return trimmed.replace(/\//g, "-");
}

const MATRIX_JOB_NAME_PATTERN = /^publish \((?<sdk>.+)\)$/;

/** Parse a `publish (<sdk>)` matrix job name into its SDK matrix value, e.g. `columnar-java`. */
export function parseMatrixJobSdk(jobName: string): string | undefined {
  return MATRIX_JOB_NAME_PATTERN.exec(jobName)?.groups?.sdk;
}

export interface GhWorkflowRunSummary {
  databaseId: number;
  displayTitle: string;
}

/**
 * Pick the run that our dispatch created out of a `gh run list` snapshot: the
 * highest `databaseId` above `baselineId` (run IDs are monotonic) whose title
 * is our ref — the title guards against picking up someone else's concurrent
 * dispatch of a different ref landing in the same poll window.
 */
export function pickDispatchedRun(
  runs: readonly GhWorkflowRunSummary[],
  baselineId: number,
  ref: string,
): GhWorkflowRunSummary | undefined {
  const candidates = runs.filter((r) => r.databaseId > baselineId && r.displayTitle === ref);
  candidates.sort((a, b) => b.databaseId - a.databaseId);
  return candidates[0];
}

export interface GhJobSummary {
  name: string;
  conclusion: string;
  url: string;
}

export interface PerformerBuildResult {
  sdkValue: string;
  sdkName: string;
  shortImage: string;
  fullImage: string;
}

export interface PerformerBuildFailure {
  sdkValue: string;
  conclusion: string;
  url: string;
}

/** Split a finished run's `publish (<sdk>)` matrix jobs into built images and failures. */
export function summariseBuildJobs(jobs: readonly GhJobSummary[], tag: string): {
  built: PerformerBuildResult[];
  failed: PerformerBuildFailure[];
} {
  const built: PerformerBuildResult[] = [];
  const failed: PerformerBuildFailure[] = [];

  for (const job of jobs) {
    const sdkValue = parseMatrixJobSdk(job.name);
    if (!sdkValue) continue;

    if (job.conclusion !== "success") {
      failed.push({ sdkValue, conclusion: job.conclusion || "unknown", url: job.url });
      continue;
    }

    const sdk = sdkByPerformerImageBasename(sdkValue) ?? sdkByValue(sdkValue);
    if (!sdk) {
      failed.push({ sdkValue, conclusion: "built, but fit-cli doesn't recognise this SDK", url: job.url });
      continue;
    }

    built.push({
      sdkValue,
      sdkName: sdk.name,
      shortImage: performerImageShortName(sdk, tag),
      fullImage: performerImageName(sdk, tag),
    });
  }

  return { built, failed };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const RUN_LOOKUP_TIMEOUT_MS = 90_000;
const RUN_LOOKUP_INTERVAL_MS = 3_000;
const RUN_STATUS_POLL_INTERVAL_MS = 10_000;
const RUN_STATUS_HEARTBEAT_INTERVAL_MS = 30_000;

async function listRecentRuns(family: PerformerBuildFamily, limit: number): Promise<GhWorkflowRunSummary[]> {
  const stdout = await capture(
    "gh",
    ["run", "list", "--repo", family.repo, "--workflow", family.workflow, "--event", "workflow_dispatch", "--limit", String(limit), "--json", "databaseId,displayTitle"],
    process.cwd(),
    { quiet: true },
  );
  return JSON.parse(stdout) as GhWorkflowRunSummary[];
}

/** Dispatch the family's build workflow for `ref` and return the run GitHub Actions created for it. */
async function dispatchAndFindRun(family: PerformerBuildFamily, ref: string): Promise<GhWorkflowRunSummary> {
  const baselineRuns = await listRecentRuns(family, 1);
  const baselineId = baselineRuns[0]?.databaseId ?? 0;

  await run("gh", ["workflow", "run", family.workflow, "--repo", family.repo, "--field", `ref=${ref}`]);

  console.log(`\nWaiting for GitHub Actions to register the dispatched run...`);
  const deadline = Date.now() + RUN_LOOKUP_TIMEOUT_MS;
  for (;;) {
    const runs = await listRecentRuns(family, 5);
    const found = pickDispatchedRun(runs, baselineId, ref);
    if (found) {
      return found;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Dispatched the workflow but couldn't find the resulting run after ${RUN_LOOKUP_TIMEOUT_MS / 1000}s.` +
          ` Check manually with: gh run list --repo ${family.repo} --workflow ${family.workflow}`,
      );
    }
    await sleep(RUN_LOOKUP_INTERVAL_MS);
  }
}

interface GhRunStatus {
  status: string;
  conclusion: string;
}

async function fetchRunStatus(family: PerformerBuildFamily, runId: number): Promise<GhRunStatus> {
  const stdout = await capture(
    "gh",
    ["run", "view", String(runId), "--repo", family.repo, "--json", "status,conclusion"],
    process.cwd(),
    { quiet: true },
  );
  return JSON.parse(stdout) as GhRunStatus;
}

/**
 * Poll a run until it completes and return its conclusion. `gh run watch` does
 * this too, but streams a noisy step-by-step block for every job — this instead
 * polls quietly and only prints an occasional heartbeat, so a multi-minute JVM
 * build doesn't spam the log.
 */
async function waitForRunConclusion(family: PerformerBuildFamily, runId: number): Promise<string> {
  const startedAt = Date.now();
  let lastHeartbeat = startedAt;
  for (;;) {
    const { status, conclusion } = await fetchRunStatus(family, runId);
    if (status === "completed") {
      return conclusion;
    }
    const now = Date.now();
    if (now - lastHeartbeat >= RUN_STATUS_HEARTBEAT_INTERVAL_MS) {
      console.log(`  ...still running (${Math.round((now - startedAt) / 1000)}s elapsed)`);
      lastHeartbeat = now;
    }
    await sleep(RUN_STATUS_POLL_INTERVAL_MS);
  }
}

/** Dispatch a performer build workflow, wait for it, and report the resulting images. */
export async function buildPerformer(family: PerformerBuildFamily, ref: string): Promise<RunOutput> {
  const trimmedRef = ref.trim();
  if (!trimmedRef) {
    throw new Error("A ref is required, e.g. refs/changes/01/248901/3, a branch name, or a tag.");
  }

  console.log(
    `\nDispatching ${family.workflow} on ${family.repo} for ref ${trimmedRef}. This builds every performer` +
      ` image that repo's workflow matrix publishes, then waits for it to finish.\n`,
  );
  const dispatchedRun = await dispatchAndFindRun(family, trimmedRef);
  const runUrl = `https://github.com/${family.repo}/actions/runs/${dispatchedRun.databaseId}`;
  console.log(`\nFound run: ${runUrl}\n`);

  console.log(`Waiting for it to finish — this can take several minutes for a JVM build...`);
  const conclusion = await waitForRunConclusion(family, dispatchedRun.databaseId);
  console.log(
    conclusion === "success"
      ? `\n✓ Run succeeded.\n`
      // The matrix runs with fail-fast:false, so one SDK failing doesn't mean the
      // others did — keep going and report per-job results below.
      : `\n⚠ Run finished with conclusion "${conclusion}" — checking which performer images still built...\n`,
  );

  const jobsJson = await capture("gh", ["run", "view", String(dispatchedRun.databaseId), "--repo", family.repo, "--json", "jobs"]);
  const jobs = (JSON.parse(jobsJson) as { jobs: GhJobSummary[] }).jobs;
  const tag = computeGithubActionsImageTag(trimmedRef);
  const { built, failed } = summariseBuildJobs(jobs, tag);

  if (built.length === 0) {
    throw new Error(`No performer images were built. See the run for details: ${runUrl}`);
  }

  console.log(`Built ${built.length} performer image${built.length === 1 ? "" : "s"}:`);
  for (const result of built) {
    console.log(`  ${result.sdkName.padEnd(24)} ${result.shortImage}`);
  }
  if (failed.length > 0) {
    fitCliWarn(
      `${failed.length} matrix job${failed.length === 1 ? "" : "s"} did not build: ` +
        failed.map((f) => `${f.sdkValue} (${f.conclusion})`).join(", "),
    );
  }

  const details: Detail[] = [
    { label: "GitHub Actions run", value: runUrl },
    ...built.map((result) => ({ label: result.sdkName, value: result.shortImage })),
    ...failed.map((f) => ({ label: `${f.sdkValue} (failed)`, value: f.url })),
  ];

  return { artifacts: [], details };
}

function helpText(): string {
  const families = PERFORMER_BUILD_FAMILIES.map((f) => f.value).join(", ");
  return `Dispatch a performer image build on GitHub Actions and report the resulting image names.

Usage:
  ${runScriptPrefix("performer")} build <family> <ref>
  ${runScriptPrefix("performer")} build --help

  family   SDK family to build (${families}).
  ref      Branch, tag, full commit hash, GitHub PR ref (refs/pull/37/merge), or
           Gerrit ref (refs/changes/58/240858/6) to build.

Example:
  ${runScriptPrefix("performer")} build jvm refs/changes/01/248901/3`;
}

export async function runPerformerBuildMain(argv: string[]): Promise<RunOutput | void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(helpText());
    return;
  }

  const [familyValue, ref, ...extra] = argv;
  if (!familyValue || !ref || extra.length > 0) {
    console.error(helpText());
    process.exit(2);
  }

  const family = performerBuildFamilyByValue(familyValue);
  if (!family) {
    console.error(
      `Unknown family "${familyValue}". Known families: ${PERFORMER_BUILD_FAMILIES.map((f) => f.value).join(", ")}.\n`,
    );
    console.error(helpText());
    process.exit(2);
  }

  return buildPerformer(family, ref);
}

if (isMain(import.meta.url)) {
  runCli(() => runPerformerBuildMain(process.argv.slice(2)));
}
