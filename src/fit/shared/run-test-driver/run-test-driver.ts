/**
 * Workflow: run the FIT test-driver Maven command from transactions-fit-performer.
 *
 * Shared by every FIT flavour (functional, situational, …). The only thing that
 * varies between them is `extraMavenArgs` — the JUnit group filter — which the
 * caller supplies (see {@link DEFAULT_MAVEN_TEST_ARGS} for functional runs and
 * {@link SITUATIONAL_MAVEN_TEST_ARGS} for situational ones).
 *
 * Run on its own:
 *   bun src/fit/shared/run-test-driver/run-test-driver.ts
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { artifactFromPath, combineArtifacts, type Artifact, type Detail, type RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { createLogFile } from "../../../util/non-fit/proc.js";
import { sanitizePathSeg, type DefinitionRunPath } from "../../../util/non-fit/replay.js";
import { ClassifiedFailure, throwFatalToRun } from "../failure-classification.js";
import { surefireReportsDir } from "./collect-junit.js";
import { situationalResultsDir } from "./collect-results.js";
import { createLocalFitExecutionContext, type FitExecutionContext } from "../util/remote-fit-run.js";
import { selectFitTests, type FitTestSelection } from "../select-fit-tests/select-fit-tests.js";

/** The Maven module that runs operational functional + situational tests. */
export const DEFAULT_TEST_DRIVER_MODULE = "test-driver";
/**
 * The Maven module that runs Analytics functional tests (Enterprise Analytics and
 * Capella Analytics). Its name is `columnar-test-driver` in transactions-fit-performer
 * for historical reasons (Capella Analytics was formerly "Columnar"); this constant is
 * the single place that external literal lives.
 */
export const ANALYTICS_TEST_DRIVER_MODULE = "columnar-test-driver";

/** The Maven groups excluded by default on a functional run. */
export const DEFAULT_EXCLUDED_GROUPS = ["situational", "openshift", "syncgateway"] as const;

export const DEFAULT_MAVEN_TEST_ARGS = [
  `-DexcludedGroups=${DEFAULT_EXCLUDED_GROUPS.join(",")}`,
] as const;

/**
 * The Maven groups excluded by default on an analytics-functional run, matching
 * fit-app-deployment's run-columnar-fit.yml (columnarDDL is excluded so a plain
 * run doesn't attempt DDL-mutating tests).
 */
export const ANALYTICS_DEFAULT_EXCLUDED_GROUPS = ["situational", "openshift", "syncgateway", "columnarDDL"] as const;

export const ANALYTICS_MAVEN_TEST_ARGS = [
  `-DexcludedGroups=${ANALYTICS_DEFAULT_EXCLUDED_GROUPS.join(",")}`,
] as const;

/** The `-Dgroups` filter that selects the cbdino-managed situational tests. */
export const SITUATIONAL_MAVEN_GROUPS_ARG = "-Dgroups=situational,cbDino";

/** The Maven groups excluded by default on a situational run. */
export const SITUATIONAL_DEFAULT_EXCLUDED_GROUPS = ["openshift", "capella"] as const;

/**
 * The default Maven group filter for situational runs: select the situational +
 * cbDino tests and exclude the ones that don't fit a cbdino-managed cluster. A
 * definition's `runtime.excludedGroups` overrides the exclusions (see
 * resolve-definition.ts).
 */
export const SITUATIONAL_MAVEN_TEST_ARGS = [
  SITUATIONAL_MAVEN_GROUPS_ARG,
  `-DexcludedGroups=${SITUATIONAL_DEFAULT_EXCLUDED_GROUPS.join(",")}`,
] as const;

/**
 * The `-Dgroups` filter that selects CNG/OpenShift situational tests (e.g.
 * CngTest, tagged `@Tag("openshift")` — see transactions-fit-performer). Distinct
 * from {@link SITUATIONAL_MAVEN_GROUPS_ARG}'s `cbDino` tag, which selects the
 * Capella-cbdino situational tests instead; the two tag sets are disjoint.
 */
export const SITUATIONAL_CNG_MAVEN_GROUPS_ARG = "-Dgroups=situational,openshift";

/** The Maven groups excluded by default on a situational CNG run. */
export const SITUATIONAL_CNG_DEFAULT_EXCLUDED_GROUPS = ["cbDino", "capella"] as const;

export const SITUATIONAL_CNG_MAVEN_TEST_ARGS = [
  SITUATIONAL_CNG_MAVEN_GROUPS_ARG,
  `-DexcludedGroups=${SITUATIONAL_CNG_DEFAULT_EXCLUDED_GROUPS.join(",")}`,
] as const;

export interface TestRunResult extends RunOutput {
  ok: boolean;
  logFile: string;
  /** Parsed JUnit counts for this run, when the test-driver produced reports. */
  summary?: FitTestDriverSummary;
  /**
   * Local path to the collected `results/` directory tree (one subdirectory per
   * run — run.json5, buckets.csv, events.csv, scores.json5; see situational-results.ts),
   * when `collectSituationalResults` was requested and the
   * test-driver produced one.
   */
  situationalResultsDir?: string;
}

export interface FitTestDriverSummary {
  testsRun: number;
  failures: number;
  errors: number;
  skipped: number;
  durationMs?: number;
}

const JUNIT_ATTRIBUTE_RE = (name: string): RegExp => new RegExp(`\\b${name}="(\\d+)"`);

export function fitTestLogStem(path: DefinitionRunPath): string {
  const instanceSeg = sanitizePathSeg(path.dirSegments?.instance ?? String(path.instanceIndex));
  const sessionSeg = sanitizePathSeg(path.dirSegments?.session ?? String(path.sessionIndex));
  const runSeg = sanitizePathSeg(path.dirSegments?.run ?? String(path.runIndex));
  const base = path.clusterlessSession
    ? join("instances", instanceSeg, "clusterless-sessions", sessionSeg, "runs", runSeg)
    : join("instances", instanceSeg, "clusters", sanitizePathSeg(path.dirSegments?.cluster ?? String(path.clusterIndex)), "sessions", sessionSeg, "runs", runSeg);
  return join(base, "driver");
}

function fitTestLogFile(path: DefinitionRunPath): string {
  return createLogFile(fitTestLogStem(path));
}

function extractJunitAttribute(xml: string, name: string): number | undefined {
  const match = xml.match(JUNIT_ATTRIBUTE_RE(name));
  return match ? Number(match[1]) : undefined;
}

export function extractFitTestDriverSummaryFromJunit(xml: string): FitTestDriverSummary | undefined {
  if (!xml.includes("<testsuite") && !xml.includes("<testsuites")) {
    return undefined;
  }

  const testsRun = extractJunitAttribute(xml, "tests");
  const failures = extractJunitAttribute(xml, "failures");
  const errors = extractJunitAttribute(xml, "errors");
  const skipped = extractJunitAttribute(xml, "skipped");
  if (testsRun === undefined || failures === undefined || errors === undefined || skipped === undefined) {
    return undefined;
  }

  return {
    testsRun,
    failures,
    errors,
    skipped,
  };
}

export function extractFitTestDriverSummaryFromJunitReports(reportsDir: string): FitTestDriverSummary | undefined {
  if (!existsSync(reportsDir)) {
    return undefined;
  }

  const xmlFiles = readdirSync(reportsDir).filter((file) => file.startsWith("TEST-") && file.endsWith(".xml"));
  if (xmlFiles.length === 0) {
    return undefined;
  }

  const summaries = xmlFiles
    .map((file) => extractFitTestDriverSummaryFromJunit(readFileSync(join(reportsDir, file), "utf8")))
    .filter((summary): summary is FitTestDriverSummary => summary !== undefined);
  if (summaries.length === 0) {
    return undefined;
  }

  return summaries.reduce<FitTestDriverSummary>(
    (combined, summary) => ({
      testsRun: combined.testsRun + summary.testsRun,
      failures: combined.failures + summary.failures,
      errors: combined.errors + summary.errors,
      skipped: combined.skipped + summary.skipped,
    }),
    { testsRun: 0, failures: 0, errors: 0, skipped: 0 },
  );
}

export function didFitTestDriverPass(summary: FitTestDriverSummary): boolean {
  return summary.failures === 0 && summary.errors === 0;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function runDetailLabel(path: DefinitionRunPath, label: string): string {
  return `Run ${path.runIndex ?? 0} ${label}`;
}

export function fitTestDriverSummaryDetails(summary: FitTestDriverSummary, path: DefinitionRunPath): Detail[] {
  const details: Detail[] = [
    {
      label: runDetailLabel(path, "Result"),
      value: didFitTestDriverPass(summary) ? "PASS" : "FAIL",
    },
    {
      label: runDetailLabel(path, "Tests run"),
      value: String(summary.testsRun),
    },
    {
      label: runDetailLabel(path, "Failures"),
      value: String(summary.failures),
    },
    {
      label: runDetailLabel(path, "Errors"),
      value: String(summary.errors),
    },
    {
      label: runDetailLabel(path, "Skipped"),
      value: String(summary.skipped),
    },
  ];
  if (summary.durationMs !== undefined) {
    details.push({ label: runDetailLabel(path, "Duration"), value: formatDuration(summary.durationMs) });
  }
  return details;
}

/** Build the `./mvnw` args needed to run the FIT test-driver. */
export function runTestDriverArgs(
  selection: FitTestSelection,
  fitConfigPath?: string,
  extraMavenArgs: readonly string[] = DEFAULT_MAVEN_TEST_ARGS,
  testDriverModule: string = DEFAULT_TEST_DRIVER_MODULE,
): string[] {
  // Note: we don't try to relocate surefire's report dir. Its `reportsDirectory`
  // parameter has no command-line property, so `-Dsurefire.reportsDirectory` is a
  // no-op — reports always land in <module>/target/surefire-reports. We purge
  // that dir before each run and collect from it afterwards (see runTestDriver).
  return [
    "-q",
    "--no-transfer-progress",
    "--batch-mode",
    "--projects",
    testDriverModule,
    "--also-make",
    // =true is explicit on purpose: Maven must run *every* test rather than
    // bailing on the first failure, and fit-cli decides pass/fail afterwards from
    // the surefire counts (see didFitTestDriverPass / the FatalToSession raised
    // when a run isn't ok). A bare -Dmaven.test.failure.ignore sets the property
    // to "", which surefire can read as false — so spell out the value.
    "-Dmaven.test.failure.ignore=true",
    "-Dsurefire.failIfNoSpecifiedTests=false",
    ...(selection.mavenTestSelector ? [`-Dtest=${selection.mavenTestSelector}`] : []),
    ...(fitConfigPath ? [`-Dfit.config=${fitConfigPath}`] : []),
    "test",
    ...extraMavenArgs,
  ];
}

/**
 * The last few non-blank lines of the test-driver log, for surfacing *why* Maven
 * itself failed (e.g. a compile error) instead of just "no JUnit reports found" —
 * which is true, but masks the actual cause when Maven never got as far as
 * running tests.
 */
function tailOfLog(logFile: string, maxLines = 30): string {
  if (!existsSync(logFile)) {
    return "";
  }
  const lines = readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  return lines.slice(-maxLines).join("\n");
}

/** Run the FIT test-driver using the Jenkins-style Maven invocation. */
export async function runTestDriver(
  execution: FitExecutionContext,
  selection: FitTestSelection,
  path: DefinitionRunPath,
  fitConfigPath?: string,
  extraMavenArgs: readonly string[] = DEFAULT_MAVEN_TEST_ARGS,
  testDriverModule: string = DEFAULT_TEST_DRIVER_MODULE,
  // Only situational runs produce a results/<runUuid>/ bundle; skip the extra
  // purge/collect round-trip on the much more common functional path.
  collectSituationalResults: boolean = false,
  // Extra env vars for the driver process (e.g. FIT_RESULTS_DB_PASSWORD). Passed via
  // the process environment rather than the config file or command line so secrets
  // don't leak into FITConfiguration.json (an artifact) or the echoed command.
  driverEnv?: Record<string, string>,
): Promise<TestRunResult> {
  // The Maven test-driver runs from the performer checkout, so make sure it's
  // present first — cloning it locally if missing (idempotent on a remote box).
  // ensureWorkspace prints actionable guidance when localhost isn't configured.
  if (!(await execution.ensureWorkspace())) {
    throw new Error("transactions-fit-performer checkout is unavailable; cannot run the FIT test-driver.");
  }

  // Per-run config/log lives in this run's own dir on the execution target —
  // locally that's the artifact tree, on a remote box a mirror under artifacts/.
  // Surefire reports can't be redirected there (its reportsDirectory has no CLI
  // property), so they always land in the performer's default target dir; we
  // purge that before the run to avoid picking up a previous run's reports, then
  // collect from it afterwards.
  const runArtifactsDir = execution.runArtifactsDir(path);
  const sourceSurefireDir = surefireReportsDir(execution.fitPerformerDir, testDriverModule);
  await execution.removeTree(sourceSurefireDir);

  // Situational runs also write results/<runUuid>/ (one subdirectory per run, written
  // throughout the invocation) — purge it first, otherwise a resumed/reused checkout
  // carries directories from a previous run.
  const sourceResultsDir = situationalResultsDir(execution.fitPerformerDir, testDriverModule);
  if (collectSituationalResults) {
    await execution.removeTree(sourceResultsDir);
  }

  const targetFitConfigPath = fitConfigPath
    ? await execution.stageFile(fitConfigPath, join(runArtifactsDir, basename(fitConfigPath)))
    : undefined;
  const args = runTestDriverArgs(selection, targetFitConfigPath, extraMavenArgs, testDriverModule);

  const logFile = fitTestLogFile(path);
  const targetLogFile = join(runArtifactsDir, basename(logFile));
  console.log(`\nRunning FIT test-driver with:\n  cd ${execution.fitPerformerDir} && ./mvnw ${args.join(" ")}\n`);
  console.log(`Streaming FIT test-driver output to:\n  ${targetLogFile}\n`);

  // The test-driver still writes JUnit reports when tests fail, so collect them
  // on both paths — the failing run is the one most worth visualising.
  let commandOk: boolean;
  const startMs = Date.now();
  try {
    await execution.streamToArtifactFile("./mvnw", args, targetLogFile, execution.fitPerformerDir, driverEnv);
    console.log("\n✓ FIT test-driver finished");
    commandOk = true;
  } catch (err) {
    console.error(`\n✗ FIT test-driver failed: ${(err as Error).message}`);
    commandOk = false;
  }
  const durationMs = Date.now() - startMs;

  const collectedLogFile = await execution.collectFile(targetLogFile, logFile);
  const logArtifact = artifactFromPath(collectedLogFile, "FIT test-driver stdout/stderr captured for this run");

  // Best-effort: an old checkout without this feature, or a run that died before
  // finalizeRun() wrote anything, simply won't have this dir — that must not fail
  // the whole run.
  const situationalResultsDirLocal = collectSituationalResults
    ? await execution.collectResultsDir(sourceResultsDir, path)
    : undefined;

  const resultsDirArtifact = situationalResultsDirLocal
    ? [artifactFromPath(situationalResultsDirLocal, "Situational per-run result files (run.json5, buckets.csv, events.csv, scores.json5 — one subdirectory per run)")]
    : [];
  let artifacts: Artifact[];
  try {
    artifacts = combineArtifacts(
      [logArtifact, ...resultsDirArtifact],
      await execution.collectJunitArtifacts(sourceSurefireDir, path),
    );
  } catch (err) {
    // collectJunitArtifacts already classifies a report-less run as FatalToRun, but
    // its "no JUnit reports found" message masks the real cause when Maven itself
    // failed (e.g. a compile error) before ever reaching the tests — surface that
    // instead, using the log we just captured.
    if (!commandOk && err instanceof ClassifiedFailure && err.classification === "FatalToRun") {
      throwFatalToRun(
        `Maven build failed before the test-driver produced any JUnit reports — see ${logFile} for the full log. Tail:\n${tailOfLog(collectedLogFile)}`,
      );
    }
    throw err;
  }
  const rawSummary = extractFitTestDriverSummaryFromJunitReports(join(dirname(logFile), "surefire-reports"));
  const summary = rawSummary ? { ...rawSummary, durationMs } : undefined;
  const ok = commandOk && (summary ? didFitTestDriverPass(summary) : true);
  return {
    ok,
    logFile: collectedLogFile,
    artifacts,
    details: summary ? fitTestDriverSummaryDetails(summary, path) : [],
    ...(summary ? { summary } : {}),
    ...(situationalResultsDirLocal ? { situationalResultsDir: situationalResultsDirLocal } : {}),
  };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const execution = createLocalFitExecutionContext();
    const selection = await selectFitTests(execution);
    return await runTestDriver(execution, selection, { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0, runIndex: 0 });
  });
}
