/**
 * Workflow: run FIT tests from a `fit` definition file. The cluster, SDK and
 * test selection all come from the file; the only prompts are where to execute
 * the run (local or a clean EC2 instance) and, at the end, whether to leave
 * everything up for debugging and resuming.
 *
 * Runs come in two flavours. `functional` runs test against the shared cluster
 * set up once for the execution group. `situational` runs (FIT/SIT) let
 * the test-driver build and manage their own cluster via cbdino and stream
 * timeseries results to a database, so they skip the shared cluster entirely —
 * their cbdino + database settings live under each run's situational settings
 * block (see resolve-definition.ts and build-situational-configuration.ts).
 *
 * The cluster is shared across the whole execution group; each run stands up its own
 * performer and runs its own tests. Provisioning an instance, preparing its
 * workspace, standing up a cluster and building a performer are all slow, so a
 * run can leave them up and a later invocation can `--resume-at` a point to
 * reuse everything up to it instead of redoing the work:
 *   bun run run definition <file.yaml>                                          # everything
 *   bun run run definition --resume-at=after-instance-creation <file>  # reuse instance
 *   bun run run definition --resume-at=after-remote-preparation <file>  # reuse prepared box
 *   bun run run definition --resume-at=after-cluster-creation <file>    # reuse cluster
 *   bun run run definition --resume-at=after-performer <file>           # reuse cluster + performer
 *
 * Run on its own:
 *   bun src/fit/functional/run-from-definition/run-from-definition.ts <file.yaml>
 *
 * Existing-cluster modes (`setup.cluster.connection` and
 * `setup.cluster.useExisting`) are resolved directly from the file; a
 * cbdinocluster plan is allocated during the cluster phase and recorded in the
 * run state so `--resume-at` can pick it back up.
 */
import { copyFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  artifactFromPath,
  combineArtifacts,
  combineDetails,
  type Artifact,
  type Detail,
  type RecordedFailure,
  type RunOutput,
} from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { clearLogContext, runDefinitionPrefix, fitCliError, fitCliWarn, popLogContext, printWithoutTimestamps, runScriptPrefix, setLogContext } from "../../../util/non-fit/fit-cli-log.js";
import { createLogFile } from "../../../util/non-fit/proc.js";
import {
  defaultsToNonInteractive,
  ensureRunDir,
  extractInteractiveFlag,
  extractCbcollectFlag,
  clusterRunDir,
  instanceRunDir,
  type DefinitionRunPath,
} from "../../../util/non-fit/replay.js";
import { clusterLabel as clusterSegmentLabel, formatRunLabel, instanceLabel, performerLabel, runLabel, type RunLabelParts } from "../../shared/util/run-labels.js";
import { confirm, select } from "../../../util/non-fit/prompts.js";
import { DEFAULT_CAPELLA_ENV, resolveCapellaConfig, resolveFitPerformerDir, resolveGithubCredentials, resolveResultsDbCredentials, resolveRosaCredentials } from "../../util/config.js";
import { terminateInstanceCommand } from "../../util/aws/lifecycle-warning.js";
import { maybeUploadRunArtifacts } from "../../util/aws/upload-run-artifacts.js";
import { AWS_REGION } from "../../../cloud/util/aws/aws-target.js";
import { deleteVpcEndpointsForCluster } from "../../../cloud/util/aws/delete-vpc-endpoints.js";
import { checkAwsCredentials, type AwsCredentials } from "../../../cloud/util/aws/identity.js";
import {
  localClusterCommandExecutor,
  type ClusterCommandExecutor,
} from "../../../cluster/cluster-create/allocate-cluster.js";
import { runClusterDiag } from "../../../cluster/cluster-diag/cluster-diag.js";
import { printClusterUiAccess } from "../../../cluster/cluster-diag/cluster-ui-link.js";
import { prepareCbdinoclusterInit, remoteCbdinoclusterCloudEnabled, removeCluster, setupDeclarativeCluster } from "../../../cluster/cluster-create/setup-declarative-cluster.js";
import { capellaFunctionalCbdinoclusterInitArgs, capellaAnalyticsCbdinoclusterInitArgs } from "../../../cluster/cluster-create/default-cbdinocluster-init-config.js";
import { isAlias, resolveAlias } from "../../../cluster/cluster-create/cb-alias.js";
import { collectClusterLogs } from "../../../cluster/cluster-cbcollect/cluster-cbcollect.js";
import { installCbdinoclusterRemote } from "../../../cluster/cluster-create/install-cbdinocluster.js";
import {
  buildRemoteK8sBlock,
  checkLocalhostCngKubernetes,
  provisionRemoteK3d,
  remoteHomeFromWorkspace,
} from "../../../cluster/cluster-create/cng-kubernetes.js";
import {
  buildOpenShiftK8sBlock,
  cngKubernetesBackend,
  provisionRemoteOpenShift,
  resolveOcVersion,
} from "../../../cluster/cluster-create/cng-openshift.js";
import {
  checkBuildAndRunPerformer,
  performerLogStem,
  stopManagedPerformer,
  type RunningPerformer,
} from "../../performers/check-build-and-run-performer/check-build-and-run-performer.js";
import type { PieceData } from "../../../util/non-fit/config-pieces.js";
import { generateFitConfiguration } from "../../shared/fit-configuration/generate-fit-configuration.js";
import { resourceCreationPiece, type ClusterCreatingConfig } from "../util/build-fit-configuration.js";
import { generateSituationalConfiguration } from "../../situational/configuration/generate-situational-configuration.js";
import { DEFAULT_CBDINO_SETTINGS, type CbdinoSettings } from "../../situational/configuration/build-situational-configuration.js";
import { loadEnvironments } from "../../util/environments.js";
import {
  createFitExecutionContext,
  uploadRemoteCapellaConfig,
  type FitExecutionContext,
} from "../../shared/util/remote-fit-run.js";
import {
  startRemoteAwsCredsRefresher,
  uploadRemoteAwsCredentials,
  type RemoteAwsCredsRefresher,
} from "../../shared/util/remote-aws-creds.js";
import { loadDefinition } from "../../shared/definition/parse-definition.js";
import {
  buildExecutionGroups,
  resolveDefinition,
  type ResolvedExecutionGroup,
  type ResolvedExecutionRun,
  type ResolvedFitConfig,
  type ResolvedFunctionalExecutionGroup,
  type ResolvedFunctionalExecutionRun,
  type ResolvedSituationalExecutionGroup,
  type ResolvedSituationalExecutionRun,
} from "../../shared/definition/resolve-definition.js";
import {
  ANALYTICS_TEST_DRIVER_MODULE,
  DEFAULT_TEST_DRIVER_MODULE,
  runTestDriver,
  type FitTestDriverSummary,
} from "../../shared/run-test-driver/run-test-driver.js";
import {
  buildFitTestSelection,
  buildFitTestSelectionFromClassNames,
  FUNCTIONAL_TEST_DOMAIN,
  isTransactionsTest,
  listFitTests,
  STANDARD_QE_CNG_REBALANCE_CLASS,
  STANDARD_QE_REBALANCE_CLASS,
  type FitTestSelection,
} from "../../shared/select-fit-tests/select-fit-tests.js";
import {
  checkResultsDatabaseConnectivity,
  resolveResultsDatabase,
  resultsHostFromJdbc,
  situationalResultsUrl,
} from "../../situational/choose-results-database/choose-results-database.js";
import {
  checkObservabilityCollectorConnectivity,
  OBSERVABILITY_COLLECTOR_HOST,
  OBSERVABILITY_COLLECTOR_PORT,
} from "../util/check-observability-collector.js";
import {
  detectClusterDockerEnvironment,
  runPerformerClusterSanityCheck,
} from "../../shared/util/performer-cluster-sanity.js";
import { writeAgentsGuide } from "../../shared/util/write-agents-guide.js";
import {
  reconnectExecutionTarget,
  resolveExecutionGroupTarget,
  selectExistingInstanceForOverride,
  type ExecutionOverride,
  type ExecutionTargetTeardown,
} from "../select-execution-target/select-execution-target.js";
import {
  ClassifiedFailure,
  throwFatalToCluster,
  throwFatalToSession,
} from "../../shared/failure-classification.js";
import { RunFailureTracker, type FailureContext } from "../../shared/run-failure-tracker.js";
import {
  extractResumeAt,
  extractResumeSelector,
  parseResumePoint,
  phasesForResumePoint,
  type ResumePoint,
  type ResumeSelector,
  type RunPhases,
} from "./resume.js";
import {
  readRunState,
  runStatePath,
  writeRunState,
  type ResumeClusterState,
  type ResumePerformerState,
  type ResumeTargetState,
  type RunState,
} from "./resume-state.js";
import { appendRunSummaryToGhaSummary } from "../../util/gha.js";
import { junitToPlainTextFromDir } from "../../shared/run-test-driver/junit-to-markdown.js";
import { readSituationalResultsCsv, renderSituationalResultsPlainText } from "../../shared/run-test-driver/situational-results.js";

/**
 * A freshly-linked AWS PrivateLink connection can take longer than the default
 * cluster-sanity retry budget (30s) to become reachable, even after cbdinocluster
 * reports the endpoint as "available" — so give it more room to retry.
 */
const PRIVATE_ENDPOINT_SANITY_RETRY_TIMEOUT_MS = 120_000;

/** True for a functional iteration that has resolved to a concrete cluster. */
function functionalWithCluster(
  run: ResolvedFunctionalExecutionRun,
): run is ResolvedFunctionalExecutionRun & { cluster: NonNullable<ResolvedFunctionalExecutionRun["cluster"]> } {
  return run.cluster !== undefined;
}

/** Describe one execution group's cluster for the run header / setup-cluster step. */
function clusterLabel(group: ResolvedExecutionGroup): string {
  if (group.type === "situational") {
    return group.cng
      ? "none — situational CNG runs build their own cbdino/CAO cluster via FIT/SIT"
      : "none — situational runs build their own cluster via FIT/SIT";
  }
  const cluster = group.sessions.flatMap((s) => s.runs).find(functionalWithCluster)?.cluster;
  if (cluster) {
    const cng = cluster.cng ? ` — CNG performer ${cluster.cng.performerConnectionString}` : "";
    return `${cluster.scheme}://${cluster.defaultHostname} (${cluster.flavour})${cng}`;
  }
  if (group.cng) {
    return "CNG cbdinocluster plan (couchbase2; allocated during setup-cluster)";
  }
  if (group.clusterMode === "connection") {
    return "existing cluster from cluster.connection";
  }
  if (group.clusterMode === "useExisting") {
    return "existing cluster from cluster.fitConfig.clusterAccess";
  }
  if (group.clusterMode === "cbdinocluster") {
    return "cbdinocluster plan (allocated during setup-cluster)";
  }
  return "none configured";
}

function applyGroupCluster(
  group: ResolvedFunctionalExecutionGroup,
  cluster: NonNullable<ResolvedFunctionalExecutionRun["cluster"]>,
): ResolvedFunctionalExecutionGroup {
  return {
    ...group,
    sessions: group.sessions.map((session) => ({
      ...session,
      runs: session.runs.map((run) => ({ ...run, cluster })),
    })),
  };
}

function missingClusterMessage(clusterMode: ResolvedFunctionalExecutionGroup["clusterMode"]): string {
  if (clusterMode === "cbdinocluster") {
    return (
      "\nrun: no cluster available yet, so a FITConfiguration can't be generated. " +
      "Run the setup-cluster step first so fit-cli can allocate the cbdinocluster."
    );
  }
  return (
    "\nrun: no cluster available, so a FITConfiguration can't be generated. " +
    "Add setup.cluster.connection or setup.cluster.useExisting to run the tests. Skipping."
  );
}

export function cbdinoclusterSetupFailed(
  group: ResolvedFunctionalExecutionGroup,
  ranSetupCluster: boolean,
): boolean {
  return (
    group.clusterMode === "cbdinocluster" &&
    ranSetupCluster &&
    group.sessions.some((session) => session.runs.some((run) => !run.cluster))
  );
}

/**
 * Combine the run's artifacts, drop an AGENTS.md guide describing them into the
 * run directory, and return the combined list including that guide.
 */
export function finalizeRunFromDefinition(
  artifacts: readonly Artifact[],
  details: readonly Detail[],
  runDir?: string,
  worstFailure?: RecordedFailure,
  failureCount?: number,
): RunOutput {
  const combined = combineArtifacts(artifacts);
  const guide = writeAgentsGuide(combined, runDir);
  const allDetails = combineDetails(details);
  // Hoist call-to-action details (e.g. Results UI) to the top of the table so
  // they're the first thing a reader sees, separated from the rest by a blank row.
  const ctas = allDetails.filter((d) => d.callToAction);
  const rest = allDetails.filter((d) => !d.callToAction);
  const orderedDetails: Detail[] = ctas.length > 0 ? [...ctas, { label: "", value: "" }, ...rest] : rest;
  return {
    artifacts: combineArtifacts(combined, [guide.artifact]),
    details: orderedDetails,
    ...(worstFailure ? { worstFailure, failureCount: failureCount ?? 1 } : {}),
  };
}

/**
 * Resolve a deferred preset selection to a concrete class list.
 * Called right before running Maven so the performer repo is already available.
 * Each preset is expanded against the listed tests and unioned together, then
 * unioned with any explicit `extraClasses` (trusted even if not discovered, so a
 * `Class#method` selector listed alongside a preset still reaches Maven).
 */
async function resolveTestSelectionMode(
  selection: FitTestSelection,
  execution: FitExecutionContext,
): Promise<FitTestSelection> {
  if (!selection.presets?.length) {
    return selection;
  }
  const tests = await listFitTests(execution, FUNCTIONAL_TEST_DOMAIN);
  const presetClasses = new Set<string>();
  for (const preset of selection.presets) {
    const matched =
      preset === "all-transactions"
        ? tests.filter(isTransactionsTest)
        : tests.filter((t) => !isTransactionsTest(t));
    matched.forEach((t) => presetClasses.add(t.className));
  }
  const presetSelected = tests.filter((t) => presetClasses.has(t.className)).map((t) => t.className);
  const extras = (selection.extraClasses ?? []).filter((c) => !presetClasses.has(c));
  if (extras.length === 0) {
    return buildFitTestSelection(tests, presetSelected);
  }
  return buildFitTestSelectionFromClassNames([...presetSelected, ...extras]);
}

/**
 * Assemble the {@link RunLabelParts} for a run from the pieces known at the call
 * site: how the box runs (`aws`/`localhost`), how the cluster was provisioned,
 * and the run's own SDK/version/type/presets. Shared by the announce header, the
 * per-run detail table and the recorded result so every label reads identically.
 */
function runLabelParts(
  instanceKind: "aws" | "localhost",
  clusterMode: RunLabelParts["clusterMode"],
  run: ResolvedExecutionRun,
  clusterVersion?: string,
  cng?: boolean,
  capella?: boolean,
  capellaAnalytics?: boolean,
): RunLabelParts {
  // An analytics run on a cbdino cluster is either Enterprise Analytics (docker) or Capella Analytics (cloud).
  const analyticsOnCbdino = clusterMode === "cbdinocluster" && run.type === "functional" && run.analytics === true;
  const isCapellaAnalytics = analyticsOnCbdino && (capellaAnalytics ?? false);
  const enterpriseAnalytics = analyticsOnCbdino && !isCapellaAnalytics;
  return {
    instanceKind,
    ...(clusterMode ? { clusterMode } : {}),
    ...(clusterVersion ? { clusterVersion } : {}),
    ...(enterpriseAnalytics ? { enterpriseAnalytics: true } : {}),
    ...(capella ? { capella: true } : {}),
    ...(isCapellaAnalytics ? { capellaAnalytics: true } : {}),
    sdkValue: run.sdk.value,
    ...(run.performerVersion ? { performerVersion: run.performerVersion } : {}),
    type: run.type,
    ...(run.testSelection.presets ? { presets: run.testSelection.presets } : {}),
    ...(cng ? { cng } : {}),
    ...(run.type === "situational" && run.privateEndpoint !== undefined ? { privateEndpoint: true } : {}),
    ...(run.type === "functional" && run.cluster?.privateEndpoint ? { privateEndpoint: true } : {}),
  };
}

/**
 * The Couchbase Server version(s) of a functional group's allocated cbdino
 * cluster, joined with `+` if its node groups differ. Undefined unless we're
 * allocating via cbdinocluster (existing/connection clusters carry no version we
 * know), so labels fall back to the `cbdino1` index form.
 */
function clusterVersionLabel(group: ResolvedExecutionGroup): string | undefined {
  if (group.type !== "functional" || group.clusterMode !== "cbdinocluster") {
    return undefined;
  }
  const versions = (group.cbdinocluster?.config.nodes.map((node) => node.version) ?? []).filter((v): v is string => v !== undefined);
  const distinct = [...new Set(versions)];
  return distinct.length ? distinct.join("+") : undefined;
}

/** True for a self-managed Enterprise Analytics cbdino cluster group (cbdino `columnar: true`, docker deployer). */
function isEnterpriseAnalyticsGroup(group: ResolvedExecutionGroup): boolean {
  return group.type === "functional" && group.cbdinocluster?.config.columnar === true && group.cbdinocluster.deployer !== "cloud";
}

/** True for a Capella Analytics (cloud) cbdino cluster group (cbdino `columnar: true`, cloud deployer). */
function isCapellaAnalyticsGroup(group: ResolvedExecutionGroup): boolean {
  return group.type === "functional" && group.cbdinocluster?.config.columnar === true && group.cbdinocluster.deployer === "cloud";
}

function isCapellaGroup(group: ResolvedExecutionGroup): boolean {
  return group.type === "functional" && group.cbdinocluster?.capella !== undefined;
}

/**
 * GitHub creds are only needed so cbdinocluster/CAO can pull private ghcr.io/cb-rhcc
 * images. Only true when some upcoming group will actually provision via cbdinocluster —
 * groups on `clusterMode: "connection"` or `"useExisting"`, or a resumed run that skips
 * cluster setup entirely, never touch it.
 */
function needsGithubCredentials(phases: RunPhases, executionGroups: ResolvedExecutionGroup[], startCycleIndex: number): boolean {
  return (
    phases.setupCluster &&
    executionGroups
      .slice(startCycleIndex)
      .some(
        (group) =>
          (group.type === "functional" && group.clusterMode === "cbdinocluster") ||
          (group.type === "situational" && group.cng),
      )
  );
}

/**
 * Resolve Capella credentials from AWS Secrets Manager and forward them to the
 * remote box as `CAPELLA_*` env vars so `cbdinocluster init --auto` writes the
 * capella block and enables the cloud deployer.  Returns the endpoint string —
 * needed by callers that verify cloud-deployer availability via
 * {@link remoteCbdinoclusterCloudEnabled} after init.
 *
 * Called for both situational runs (which always allocate Capella clusters) and
 * Capella Analytics functional runs (which use cbdinocluster's cloud deployer).
 * Only meaningful for remote executions; callers must gate on `execution.kind === "remote"`.
 */
async function uploadCapellaCredsForCloudDeployer(
  execution: FitExecutionContext,
  capellaEnvironment: string,
  caller: string,
): Promise<string> {
  let capella;
  try {
    capella = await resolveCapellaConfig({ block: capellaEnvironment });
  } catch (err) {
    throwFatalToCluster(
      `${caller}, but the "${capellaEnvironment}" Capella credentials couldn't be resolved: ${(err as Error).message}`,
    );
  }
  await uploadRemoteCapellaConfig(execution.target, execution.rootDir, capella);
  return capella.endpoint;
}

/** Print what an iteration resolved to, so a CI log shows the run's inputs. */
function announce(
  group: ResolvedExecutionGroup,
  run: ResolvedExecutionRun,
  fitPerformerGerritRef: string | undefined,
  globalIterationIndex: number,
  totalGlobalIterations: number,
): void {
  const cng = group.cng;
  setLogContext({
    progress: `${globalIterationIndex + 1}/${totalGlobalIterations}`,
    performer: performerLabel(run.path, run.sdk.value, run.performerVersion),
    run: runLabel(run.path, run.type, run.testSelection.presets, cng),
  });
  const { testSelection } = run;
  const presetLabels = (testSelection.presets ?? []).map((p) =>
    p === "all-transactions" ? "all transactions tests" : "all non-transactions tests",
  );
  const testsLabel = presetLabels.length
    ? [...presetLabels, ...(testSelection.extraClasses ?? [])].join(" + ")
    : testSelection.mavenTestSelector
      ? `${testSelection.selectedTests.length} test(s): ${testSelection.mavenTestSelector}`
      : "all tests";
  const parts = runLabelParts(
    group.instance.kind,
    group.type === "functional" ? group.clusterMode : undefined,
    run,
    clusterVersionLabel(group),
    cng,
    isCapellaGroup(group),
    isCapellaAnalyticsGroup(group),
  );
  console.log(`\n=== ${formatRunLabel(run.path, parts)} (${group.instance.kind}, ${run.type}) ===`);
  const instSeg = instanceLabel(run.path, parts.instanceKind);
  const instDesc =
    parts.instanceKind === "aws"
      ? `Running on AWS EC2 instance ${run.path.instanceIndex + 1}`
      : "Running locally on this machine";
  console.log(`  ${instSeg}:  ${instDesc}`);
  const clusterSeg = clusterSegmentLabel(run.path, parts.clusterMode, parts.clusterVersion, parts.enterpriseAnalytics, parts.capella, parts.capellaAnalytics);
  if (clusterSeg) {
    let clusterDesc: string;
    if (parts.capellaAnalytics) {
      clusterDesc = "Capella Analytics (cloud) cluster, provisioned via cbdinocluster";
    } else if (parts.enterpriseAnalytics) {
      clusterDesc = `Self-managed Enterprise Analytics ${parts.clusterVersion ?? ""} cluster, provisioned via cbdinocluster`.replace(/\s+/g, " ").trim();
    } else if (parts.capella) {
      clusterDesc = `Capella ${parts.clusterVersion ?? ""} cluster, provisioned via cbdinocluster cloud deployer`.replace(/\s+/g, " ").trim();
    } else if (parts.clusterVersion) {
      clusterDesc = `Couchbase Server ${parts.clusterVersion} cluster, provisioned via cbdinocluster`;
    } else if (parts.clusterMode === "connection" || parts.clusterMode === "useExisting") {
      clusterDesc = `Pre-existing cluster`;
    } else {
      clusterDesc = `Cluster allocated via cbdinocluster`;
    }
    console.log(`  ${clusterSeg}:  ${clusterDesc}`);
  }
  const perfSeg = performerLabel(run.path, parts.sdkValue, parts.performerVersion);
  const perfDesc = parts.performerVersion
    ? `${run.sdk.name} SDK performer, git ref: ${parts.performerVersion}`
    : `${run.sdk.name} SDK performer`;
  console.log(`  ${perfSeg}:  ${perfDesc}`);
  const runSeg = runLabel(run.path, parts.type, parts.presets, parts.cng);
  if (runSeg) {
    const typeStr = parts.type === "functional" ? "Functional" : "Situational";
    const cngSuffix = parts.cng ? " (Cloud Native Gateway)" : "";
    const runDesc =
      parts.presets?.length === 1
        ? `${typeStr} test run, preset: ${parts.presets[0]}${cngSuffix}`
        : `${typeStr} test run${cngSuffix}`;
    console.log(`  ${runSeg}:  ${runDesc}`);
  }
  console.log(`  SDK:     ${run.sdk.name}`);
  console.log(`  Tests:   ${testsLabel}`);
  if (run.type === "situational") {
    console.log(`  Results database: ${run.databaseMode}`);
  }
  console.log(`  Performer port: ${run.performerPort}`);
  if (run.performerVersion) {
    console.log(`  Performer version: ${run.performerVersion}`);
  }
  if (fitPerformerGerritRef) {
    console.log(`  FIT Gerrit ref: ${fitPerformerGerritRef}`);
  }
}

/**
 * Augment a CNG cycle's cbdinocluster init config with a `k8s` block. `addK8s`
 * decides which backend it points at (the k3d cluster on the box, or the
 * logged-in OpenShift context) — see {@link prepareFunctionalCngCycle}.
 */
function withRemoteK8sInit(
  group: ResolvedFunctionalExecutionGroup,
  k8sBlock: PieceData,
): ResolvedFunctionalExecutionGroup {
  if (!group.cbdinocluster) {
    return group;
  }
  return {
    ...group,
    cbdinocluster: {
      ...group.cbdinocluster,
      init: { configPatch: k8sBlock },
    },
  };
}

/** Node count to preflight for when a functional CNG cluster's own def is unavailable. */
const FUNCTIONAL_CNG_DEFAULT_NODE_COUNT = 3;

/**
 * The largest cluster situational CNG (`CngTest`'s rebalance5To3/rebalance3To5
 * methods) is known to build, per transactions-fit-performer. Situational's
 * cluster shape is otherwise opaque to fit-cli, so this is the conservative
 * preflight target rather than a derived per-run figure.
 */
const SITUATIONAL_CNG_MAX_NODE_COUNT = 5;

/**
 * Make an execution target CNG-ready and return the `k8s` config-patch block to
 * merge onto `~/.cbdinocluster`, or `undefined` when nothing needs patching (the
 * localhost path — we only verify it, not manage it). For CNG on a clean instance
 * the Kubernetes backend is chosen by {@link cngKubernetesBackend}: by default we
 * prepare OpenShift/ROSA (the only tested CNG path — install oc, log into the
 * shared cluster, run the pre-flight cleanup); with `FIT_CNG_K8S=k3d` we fall back
 * to the legacy local k3d cluster. Shared by both functional and situational CNG
 * cycles — {@link prepareFunctionalCngCycle} and {@link prepareSituationalCngCycle}.
 */
async function resolveCngK8sConfigPatch(
  execution: FitExecutionContext,
  requiredNodes: number,
): Promise<PieceData | undefined> {
  if (execution.kind === "remote") {
    const home = remoteHomeFromWorkspace(execution.rootDir);
    if (cngKubernetesBackend() === "k3d") {
      await provisionRemoteK3d(execution, home);
      return buildRemoteK8sBlock(home);
    }
    const creds = await resolveRosaCredentials();
    if (typeof creds === "string") {
      throwFatalToCluster(creds);
    }
    const { context } = await provisionRemoteOpenShift(execution, home, creds, resolveOcVersion(), requiredNodes);
    return buildOpenShiftK8sBlock(home, context);
  }
  const check = checkLocalhostCngKubernetes();
  if (!check.ok) {
    throwFatalToCluster(check.message);
  }
  console.log("→ setup-cluster: this machine's ~/.cbdinocluster has Kubernetes enabled — CNG-ready.");
  return undefined;
}

/** Make a functional cycle's execution target CNG-ready. Non-CNG cycles pass through untouched. */
async function prepareFunctionalCngCycle(
  group: ResolvedFunctionalExecutionGroup,
  execution: FitExecutionContext,
): Promise<ResolvedFunctionalExecutionGroup> {
  if (!group.cng) {
    return group;
  }
  const requiredNodes =
    group.cbdinocluster?.config.nodes.reduce((sum, n) => sum + n.count, 0) ?? FUNCTIONAL_CNG_DEFAULT_NODE_COUNT;
  const k8sBlock = await resolveCngK8sConfigPatch(execution, requiredNodes);
  return k8sBlock ? withRemoteK8sInit(group, k8sBlock) : group;
}

/**
 * Make a situational cycle's execution target CNG-ready. Non-CNG cycles pass
 * through untouched. Unlike functional CNG (which patches a fresh
 * `cbdinocluster.init`), situational's `cbdinoclusterInit` may already carry
 * definition-supplied `args`/`config`, so the k8s block is merged in rather than
 * replacing it outright.
 */
async function prepareSituationalCngCycle(
  group: ResolvedSituationalExecutionGroup,
  execution: FitExecutionContext,
): Promise<ResolvedSituationalExecutionGroup> {
  if (!group.cng) {
    return group;
  }
  // Situational's cluster shape is opaque to fit-cli (decided by whichever Java
  // test class the driver runs, e.g. CngTest's rebalance5To3/3To5 methods build a
  // 5-node cluster) — there's no per-run node count to inspect ahead of time like
  // functional has, so preflight for the largest cluster situational CNG is known
  // to build rather than trying to derive it.
  const k8sBlock = await resolveCngK8sConfigPatch(execution, SITUATIONAL_CNG_MAX_NODE_COUNT);
  if (!k8sBlock) {
    return group;
  }
  return { ...group, cbdinoclusterInit: { ...group.cbdinoclusterInit, configPatch: k8sBlock } };
}

/**
 * The setup-cluster step. Existing-cluster modes only report what the file
 * resolved to; a cbdinocluster plan is allocated here and then shared across
 * every run in the execution group.
 */
export async function setupCluster(
  group: ResolvedFunctionalExecutionGroup,
  execution: ClusterCommandExecutor = localClusterCommandExecutor(),
  setupDeclarativeClusterFn: typeof setupDeclarativeCluster = setupDeclarativeCluster,
  githubCredentials?: { user: string; token: string },
): Promise<RunOutput & { group: ResolvedFunctionalExecutionGroup; clusterState?: ResumeClusterState }> {
  if (group.clusterMode === "connection") {
    fitCliWarn("\nsetup-cluster: using the existing cluster from cluster.connection; nothing to allocate.");
    return { group, artifacts: [], details: [] };
  }
  if (group.clusterMode === "useExisting") {
    fitCliWarn("\nsetup-cluster: using the existing cluster described by cluster.fitConfig.clusterAccess; nothing to allocate.");
    return { group, artifacts: [], details: [] };
  }
  if (group.cbdinocluster) {
    const clusterDir = clusterRunDir(group.path);
    const outcome = await setupDeclarativeClusterFn(
      {
        ...group.cbdinocluster,
        cng: group.cng,
        cngSharedCluster: group.cng && cngKubernetesBackend() === "openshift",
        githubCredentials,
        source: group.cbdinoclusterSource,
        // The cluster's own `capella.environment` takes precedence when set (it's what
        // actually got uploaded to the box — see the Capella-functional branch above);
        // group.capellaEnvironment (the instance-level default) covers Capella Analytics
        // clusters, whose credentials are uploaded keyed off that field instead.
        capellaEnvironment: group.cbdinocluster.capella?.environment ?? group.capellaEnvironment,
      },
      execution,
      clusterDir,
    );
    const clusterState: ResumeClusterState | undefined = outcome.cluster
      ? {
          cluster: outcome.cluster,
          allocated: outcome.allocated,
          ...(outcome.clusterId ? { clusterId: outcome.clusterId } : {}),
          ...(outcome.cbdinocluster ? { cbdinoclusterCommand: outcome.cbdinocluster } : {}),
          logsDir: join(clusterDir, "server-logs"),
          ...(outcome.couchbaseClusterUuid ? { couchbaseClusterUuid: outcome.couchbaseClusterUuid } : {}),
          ...(outcome.privateEndpointEnabled ? { privateEndpointEnabled: true } : {}),
        }
      : undefined;
    return {
      group: outcome.cluster ? applyGroupCluster(group, outcome.cluster) : group,
      ...(clusterState ? { clusterState } : {}),
      artifacts: outcome.artifacts,
      details: outcome.details,
    };
  }
  fitCliWarn("\nsetup-cluster: no cluster configured.");
  return { group, artifacts: [], details: [] };
}

/** The setup-performer step: pull the prebuilt performer image and start it in Docker. */
async function setupPerformer(
  execution: FitExecutionContext,
  fitPerformerGerritRef: string | undefined,
  run: ResolvedExecutionRun,
): Promise<RunningPerformer | undefined> {
  const clusterDockerEnvironment =
    run.type === "functional" && run.cluster
      ? await detectClusterDockerEnvironment(run.cluster, {
          captureCommand: (command, args) => execution.capture(command, args),
          dockerCommand: execution.dockerCommand,
        })
      : undefined;
  if (clusterDockerEnvironment) {
    console.log(
      `\n→ Cluster Docker networks: ${clusterDockerEnvironment.networkNames.join(", ")} ` +
        `(containers: ${clusterDockerEnvironment.containerNames.join(", ")})`,
    );
  }
  return checkBuildAndRunPerformer(
    execution,
    run.sdk,
    run.path,
    run.performerVersion,
    clusterDockerEnvironment?.networkNames[0],
    run.onPortInUse,
    run.performerPort,
    fitPerformerGerritRef,
  );
}

/**
 * The pass/fail outcome of a single run's test-driver invocation, collected even
 * when the run fails (so the end-of-run summary can show failures, which are the
 * ones most worth leaving resources up to debug).
 */
export interface RunResultSummary {
  path: DefinitionRunPath;
  /** Rich path label (`aws1 / cbdino1 / java:main / func`), computed where the full run context is known. */
  pathLabel: string;
  sdk: string;
  type: ResolvedExecutionRun["type"];
  ok: boolean;
  summary?: FitTestDriverSummary;
  /** Local path to the surefire-reports dir for this run; absent if no test driver ran. */
  surefireDir?: string;
  /** Local path to the collected situational-results CSV; set only for situational runs. */
  situationalResultsCsv?: string;
}

/** Sink the run loop passes down so each run records its result as it finishes. */
type RecordRunResult = (result: RunResultSummary) => void;

/** The run step: generate a FITConfiguration, sanity-check, and run the test driver. */
interface RunTestsDependencies {
  runClusterDiagFn?: typeof runClusterDiag;
  generateFitConfigurationFn?: typeof generateFitConfiguration;
  runPerformerClusterSanityCheckFn?: typeof runPerformerClusterSanityCheck;
  runTestDriverFn?: typeof runTestDriver;
  recordResult?: RecordRunResult;
}

export async function runTests(
  execution: FitExecutionContext,
  clusterMode: ResolvedFunctionalExecutionGroup["clusterMode"],
  run: ResolvedFunctionalExecutionRun,
  performer: RunningPerformer | undefined,
  dependencies: RunTestsDependencies = {},
  clusterVersion?: string,
): Promise<RunOutput> {
  if (!run.cluster) {
    fitCliWarn(missingClusterMessage(clusterMode));
    return { artifacts: [], details: [] };
  }

  const runClusterDiagFn = dependencies.runClusterDiagFn ?? runClusterDiag;
  const generateFitConfigurationFn = dependencies.generateFitConfigurationFn ?? generateFitConfiguration;
  const runPerformerClusterSanityCheckFn =
    dependencies.runPerformerClusterSanityCheckFn ?? runPerformerClusterSanityCheck;
  const runTestDriverFn = dependencies.runTestDriverFn ?? runTestDriver;

  const artifacts: Artifact[] = [];
  const details: Detail[] = [];

  if (
    !(await runClusterDiagFn(run.cluster, {
      captureCommand: (cmd, args, cwd, runOpts) => execution.capture(cmd, args, cwd, runOpts),
      ...(run.cluster.privateEndpoint ? { retryTimeoutMs: PRIVATE_ENDPOINT_SANITY_RETRY_TIMEOUT_MS } : {}),
    }))
  ) {
    throwFatalToCluster("Cluster sanity test failed; this execution group cannot continue.");
  }

  // When fit-cli allocated the cluster via cbdinocluster we know both the
  // cbdinocluster binary path on the execution host and the server version under
  // test, so we can enable the test-driver's cluster-creating functional tests.
  // Existing/connection clusters carry neither, so they're left off (the
  // preferredCluster.version the performer requires would be unknown).
  let effectiveFitConfig = run.fitConfig;
  // Analytics runs use the Analytics test-driver, whose cluster-creating tests are
  // gated on resourceCreation differently (@RequiresAnalyticsClusterCreating); the
  // operational resourceCreation block below doesn't apply, so leave it off.
  if (clusterMode === "cbdinocluster" && clusterVersion && !run.analytics) {
    const cbdinoclusterPath = await resolveCbdinoclusterPathOnExecution(execution);
    // clusterVersion is a label that may join multiple node versions with "+";
    // preferredCluster wants a single concrete version, so take the first and
    // resolve any alias (e.g. "8.0.0-release") to a concrete build.
    const primaryVersion = clusterVersion.split("+")[0];
    const version = isAlias(primaryVersion) ? await resolveAlias(primaryVersion) : primaryVersion;
    console.log(
      `→ Enabling cluster-creating functional tests (cbdinocluster=${cbdinoclusterPath}, version=${version}).`,
    );
    effectiveFitConfig = withClusterCreating(run.fitConfig, { cbdinoclusterPath, version });
  }

  const fitConfig = generateFitConfigurationFn(
    run.cluster,
    execution.fitPerformerDir,
    run.path,
    run.performerPort,
    effectiveFitConfig,
    run.analytics ?? false,
  );
  artifacts.push(...fitConfig.artifacts);
  details.push(...fitConfig.details);

  const performerSanity = await runPerformerClusterSanityCheckFn(run.cluster, performer?.containerId, {
    captureCommand: (command, args) => execution.capture(command, args),
    dockerCommand: execution.dockerCommand,
  });
  artifacts.push(...performerSanity.artifacts);
  if (!performerSanity.ok) {
    throwFatalToSession("Performer cluster sanity check failed; stopping this iteration.");
  }

  const resolvedTestSelection = await resolveTestSelectionMode(run.testSelection, execution);
  const testRun = await runTestDriverFn(
    execution,
    resolvedTestSelection,
    run.path,
    fitConfig.path,
    run.extraMavenArgs,
    run.analytics ? ANALYTICS_TEST_DRIVER_MODULE : DEFAULT_TEST_DRIVER_MODULE,
  );
  artifacts.push(...testRun.artifacts);
  const isCapella = run.cluster?.flavour === "internal-capella" || run.cluster?.flavour === "production-capella";
  const pathLabel = formatRunLabel(
    run.path,
    runLabelParts(execution.kind === "remote" ? "aws" : "localhost", clusterMode, run, clusterVersion, run.cluster?.cng !== undefined, isCapella, run.analytics && !run.cluster?.analyticsLoadBalancerHost),
  );
  const iterationLabel = (label: string) => `Run ${run.path.runIndex ?? 0} ${label}`;
  details.push(
    { label: iterationLabel("Details"), value: pathLabel },
    { label: iterationLabel("SDK"), value: run.sdk.name },
    { label: iterationLabel("Cluster"), value: `${run.cluster.scheme}://${run.cluster.defaultHostname}` },
    ...testRun.details,
  );
  dependencies.recordResult?.({
    path: run.path,
    pathLabel,
    sdk: run.sdk.name,
    type: run.type,
    ok: testRun.ok,
    ...(testRun.summary ? { summary: testRun.summary } : {}),
    surefireDir: join(dirname(testRun.logFile), "surefire-reports"),
  });
  if (!testRun.ok) {
    throwFatalToSession("FIT tests failed — check the test-driver log for details.");
  }
  return { artifacts, details };
}

/** Expand situational named presets into concrete class selectors. */
function expandSituationalPresets(selection: FitTestSelection, cng: boolean): FitTestSelection {
  if (!selection.presets?.length) return selection;
  const classes: string[] = [];
  for (const preset of selection.presets) {
    if (preset === "standard-qe") {
      classes.push(cng ? STANDARD_QE_CNG_REBALANCE_CLASS : STANDARD_QE_REBALANCE_CLASS);
    }
  }
  return buildFitTestSelectionFromClassNames(classes);
}

/**
 * Resolve the cbdinocluster binary to its absolute path on the execution host
 * via `which`, falling back to the bare name if resolution fails. Uses a login
 * shell so PATH additions from profile scripts (e.g. ~/.profile) are honoured.
 */
async function resolveCbdinoclusterPathOnExecution(execution: FitExecutionContext): Promise<string> {
  try {
    const resolved = (
      await execution.capture("sh", ["-lc", "which cbdinocluster"], undefined, { quiet: true })
    ).trim();
    if (resolved) {
      console.log(`→ Resolved cbdinocluster on ${execution.description}: ${resolved}`);
      return resolved;
    }
  } catch {
    // `which` failed — cbdinocluster is not yet installed or not on PATH
  }
  return "cbdinocluster";
}

/**
 * Return a fitConfig piece with cbDinoClusterAppPath set to `path`, overriding
 * whatever the definition specified so the FIT test driver uses the runtime-resolved
 * absolute path on the execution host.
 */
function withCbdinoclusterPath(fitConfig: ResolvedFitConfig | undefined, cbdinoPath: string): ResolvedFitConfig {
  const piece = fitConfig?.config ?? {};
  const situational = ((piece.situational ?? {}) as Record<string, unknown>);
  const cbdino = ((situational.cbdino ?? {}) as Record<string, unknown>);
  return {
    ...fitConfig,
    config: {
      ...piece,
      situational: {
        ...situational,
        cbdino: { ...cbdino, cbDinoClusterAppPath: cbdinoPath },
      },
    },
  };
}

/**
 * Return a fitConfig piece with `resourceCreation.cluster` set so the test-driver
 * enables its cluster-creating functional tests (`@RequiresClusterCreating`). The
 * runtime-resolved cbdinocluster path and server version always win over anything
 * the definition specified, since they're the ones valid on this execution host.
 */
function withClusterCreating(
  fitConfig: ResolvedFitConfig | undefined,
  clusterCreating: ClusterCreatingConfig,
): ResolvedFitConfig {
  const piece = fitConfig?.config ?? {};
  return {
    ...fitConfig,
    config: { ...piece, ...resourceCreationPiece(clusterCreating) },
  };
}

async function withResolvedSituationalCbdino(
  fitConfig: ResolvedFitConfig | undefined,
  cbdinoPath: string,
): Promise<ResolvedFitConfig> {
  const resolved = withCbdinoclusterPath(fitConfig, cbdinoPath);
  const piece = resolved.config ?? {};
  const situational = ((piece.situational ?? {}) as Record<string, unknown>);
  const cbdino = ((situational.cbdino ?? {}) as Record<string, unknown>);
  const version = cbdino.version;
  if (typeof version !== "string" || !isAlias(version)) {
    return resolved;
  }
  return {
    ...resolved,
    config: {
      ...piece,
      situational: {
        ...situational,
        cbdino: { ...cbdino, version: await resolveAlias(version) },
      },
    },
  };
}

/**
 * The cbdino settings for a situational run. A CNG run deploys via the Couchbase
 * Autonomous Operator instead of a Capella cloud cluster, so it needs the CNG
 * server/operator/gateway versions (from environments.json5) rather than the
 * Capella-cluster default — the driver's CbDinoYamlWrangler only writes an
 * `operator-version`/`gateway-version` into cbdinocluster's config when it sees a
 * `cao` deployer.
 */
export function situationalCbdinoSettings(cng: boolean, privateEndpoint: boolean, versionOverride?: string): CbdinoSettings {
  if (!cng) {
    return {
      ...DEFAULT_CBDINO_SETTINGS,
      version: versionOverride ?? loadEnvironments().defaults.capellaClusterVersion,
      enablePrivateEndpoint: privateEndpoint,
    };
  }
  const { cngClusterVersion, caoOperatorVersion, cngVersion } = loadEnvironments().defaults;
  return {
    ...DEFAULT_CBDINO_SETTINGS,
    version: cngClusterVersion,
    cao: { operatorVersion: caoOperatorVersion, gatewayVersion: cngVersion },
    enablePrivateEndpoint: privateEndpoint,
  };
}

/**
 * The run step for a situational iteration. cbdino builds and manages the
 * cluster from inside the test-driver, so there's no cluster to diagnose or
 * sanity-check up front — instead we resolve the results database the file named,
 * generate the situational FITConfiguration, and run the test-driver with the
 * situational Maven groups.
 */
export async function runSituationalTests(
  execution: FitExecutionContext,
  run: ResolvedSituationalExecutionRun,
  dependencies: {
    recordResult?: RecordRunResult;
  } = {},
): Promise<RunOutput> {
  console.log(
    "\nNote: for a full cbdino run the performer must share cbdino's Docker network " +
      "(usually `dinonet`) so it can reach the cluster cbdino creates.",
  );

  const database = await resolveResultsDatabase(run.databaseMode, run.resultsEnvironment);
  if (!database.ready) {
    return { artifacts: database.artifacts, details: database.details };
  }

  const artifacts: Artifact[] = [...database.artifacts];
  const details: Detail[] = [...database.details];

  // Resolve cbdinocluster to its absolute path on the execution host so the FIT
  // test driver can invoke it even when its environment doesn't inherit the same PATH.
  const cbdinoclusterPath = await resolveCbdinoclusterPathOnExecution(execution);
  const fitConfigPiece = await withResolvedSituationalCbdino(run.fitConfig, cbdinoclusterPath);
  const resolvedVersion = run.version !== undefined && isAlias(run.version) ? await resolveAlias(run.version) : run.version;

  const fitConfig = generateSituationalConfiguration(
    database.database,
    situationalCbdinoSettings(run.cng, run.privateEndpoint !== undefined, resolvedVersion),
    execution.fitPerformerDir,
    run.path,
    run.performerPort,
    fitConfigPiece.config,
  );
  artifacts.push(...fitConfig.artifacts);
  details.push(...fitConfig.details);

  const testSelection = expandSituationalPresets(run.testSelection, run.cng);
  const testRun = await runTestDriver(
    execution,
    testSelection,
    run.path,
    fitConfig.path,
    run.extraMavenArgs,
    DEFAULT_TEST_DRIVER_MODULE,
    true,
    // The results-DB password goes to the driver via the environment, not the
    // config file — so it can't leak into the collected FITConfiguration.json.
    { FIT_RESULTS_DB_PASSWORD: database.database.password },
  );
  artifacts.push(...testRun.artifacts);
  const pathLabel = formatRunLabel(
    run.path,
    runLabelParts(execution.kind === "remote" ? "aws" : "localhost", undefined, run, undefined, run.cng),
  );
  const iterationLabel = (label: string) => `Run ${run.path.runIndex ?? 0} ${label}`;
  details.push(
    { label: iterationLabel("Details"), value: pathLabel },
    { label: iterationLabel("SDK"), value: run.sdk.name },
    ...testRun.details,
  );

  // Derive the UI URL from the chosen database's host so it matches where data
  // actually lands (dev vs prod), rather than a fixed constant.
  const resultsUrl = situationalResultsUrl(resultsHostFromJdbc(database.database.jdbc));
  console.log(`\nWhen this run produces data, view it at:\n  ${resultsUrl}`);
  details.push({ label: "Results UI", value: resultsUrl, callToAction: true });
  dependencies.recordResult?.({
    path: run.path,
    pathLabel,
    sdk: run.sdk.name,
    type: run.type,
    ok: testRun.ok,
    ...(testRun.summary ? { summary: testRun.summary } : {}),
    surefireDir: join(dirname(testRun.logFile), "surefire-reports"),
    ...(testRun.situationalResultsCsv ? { situationalResultsCsv: testRun.situationalResultsCsv } : {}),
  });
  if (!testRun.ok) {
    throwFatalToSession("FIT tests failed — check the test-driver log for details.");
  }
  return { artifacts, details };
}

/**
 * Reconstruct the performer a previous run left running for this iteration,
 * after checking its container is still up. Returns undefined (explaining why)
 * if the run state has no performer for the run or the container is gone.
 */
async function resumePerformer(
  execution: FitExecutionContext,
  run: ResolvedExecutionRun,
  savedState: RunState | undefined,
  globalIterationIndex: number,
): Promise<RunningPerformer | undefined> {
  const saved = savedState?.performers.find((performer) => performer.globalRunIndex === globalIterationIndex);
  if (!saved?.containerId) {
    fitCliError(
      `\nresume: the run state has no performer for run ${globalIterationIndex + 1}. ` +
        "Re-run with --resume-at=after-cluster-creation to rebuild it.",
    );
    return undefined;
  }

  const running = (
    await execution
      .capture(execution.dockerCommand, ["ps", "--filter", `id=${saved.containerId}`, "--format", "{{.ID}}"])
      .catch(() => "")
  ).trim();
  if (!running) {
    fitCliError(
      `\nresume: the saved performer container ${saved.containerId} is no longer running. ` +
        "Re-run with --resume-at=after-cluster-creation to rebuild it.",
    );
    return undefined;
  }

  console.log(`\n→ resume: reusing performer container ${saved.containerId} for run ${globalIterationIndex + 1}.`);
  const logFile = createLogFile(performerLogStem(run.path, run.sdk, run.performerVersion));
  return {
    containerId: saved.containerId,
    logFile,
    artifacts: [artifactFromPath(logFile, `${run.sdk.name} performer logs captured for this FIT run`)],
    details: [],
  };
}

 function printResumeHint(point: ResumePoint, definitionPath: string, path: DefinitionRunPath, includeRun: boolean): void {
  console.log(`\n→ Resume from here: ${formatResumeCommand(point, definitionPath, resumeSelectorFromPath(path, includeRun))}`);
}

/** Run one iteration: stand up (or reuse) its performer, then run the tests. */
async function runIteration(
  execution: FitExecutionContext,
  functionalClusterMode: ResolvedFunctionalExecutionGroup["clusterMode"] | undefined,
  fitPerformerGerritRef: string | undefined,
  run: ResolvedExecutionRun,
  setupPerformerPhase: boolean,
  savedState: RunState | undefined,
  globalIterationIndex: number,
  definitionPath: string,
  recordResult: RecordRunResult,
  functionalClusterVersion?: string,
  existingPerformer?: RunningPerformer,
): Promise<{ output: RunOutput; performer?: RunningPerformer }> {
  const artifacts: Artifact[] = [];
  const details: Detail[] = [];

  const ownedPerformer = !existingPerformer;
  let performer: RunningPerformer | undefined;
  if (existingPerformer) {
    // Reuse a performer that is already running for this session — no setup needed.
    performer = existingPerformer;
  } else {
    performer = setupPerformerPhase
      ? await setupPerformer(execution, fitPerformerGerritRef, run)
      : await resumePerformer(execution, run, savedState, globalIterationIndex);
    if (!performer) {
      throwFatalToSession("The performer isn't ready to run; stopping this iteration.");
    }
    artifacts.push(...performer.artifacts);
    if (setupPerformerPhase && performer.containerId) {
      printResumeHint("after-performer", definitionPath, run.path, true);
    }
  }
  if (!performer) {
    throwFatalToSession("The performer isn't ready to run; stopping this iteration.");
  }

  let output: RunOutput;
  try {
    if (run.type === "situational") {
      output = await runSituationalTests(execution, run, { recordResult });
    } else {
      const clusterMode: ResolvedFunctionalExecutionGroup["clusterMode"] = functionalClusterMode ?? "useExisting";
      output = await runTests(execution, clusterMode, run, performer, { recordResult }, functionalClusterVersion);
    }
  } catch (err) {
    // When we started this performer ourselves and a FatalToSession error escapes, stop
    // the container now. The outer loop only has a performer reference when runIteration
    // returns successfully, so it cannot stop this one at the next session boundary.
    if (ownedPerformer && err instanceof ClassifiedFailure && err.classification === "FatalToSession") {
      await stopManagedPerformer(execution, performer);
    }
    throw err;
  }
  artifacts.push(...output.artifacts);
  details.push(...output.details);
  return {
    output: { artifacts: combineArtifacts(artifacts), details: combineDetails(details) },
    performer,
  };
}

/** Resolve the shared cluster when resuming: reuse the one in the run state. */
async function resumeCluster(
  group: ResolvedFunctionalExecutionGroup,
  savedState: RunState | undefined,
  execution: FitExecutionContext,
): Promise<{ group: ResolvedFunctionalExecutionGroup; clusterState?: ResumeClusterState }> {
  // Existing-cluster modes already carry the cluster from the file, so there's
  // nothing in the run state to reuse — the resolved iterations are ready.
  if (group.clusterMode !== "cbdinocluster") {
    return { group };
  }

  const clusterState = savedState?.cluster;
  if (!clusterState) {
    throw new Error(
      "resume: the run state has no cbdinocluster to reuse. Re-run without --resume-at to allocate one.",
    );
  }
  console.log(
    `\n→ resume: reusing cluster ${clusterState.clusterId ?? clusterState.cluster.defaultHostname} from the run state.`,
  );
  if (
    !(await runClusterDiag(clusterState.cluster, {
      captureCommand: (cmd, args, cwd, runOpts) => execution.capture(cmd, args, cwd, runOpts),
      ...(clusterState.cluster.privateEndpoint ? { retryTimeoutMs: PRIVATE_ENDPOINT_SANITY_RETRY_TIMEOUT_MS } : {}),
    }))
  ) {
    throw new Error(
      "resume: the saved cluster is no longer reachable. Re-run without --resume-at to allocate a fresh one.",
    );
  }
  return { group: applyGroupCluster(group, clusterState.cluster), clusterState };
}

function targetStateFrom(teardown: ExecutionTargetTeardown): ResumeTargetState {
  return {
    kind: teardown.kind,
    ...(teardown.instanceId ? { instanceId: teardown.instanceId } : {}),
    ...(teardown.address ? { address: teardown.address } : {}),
    ...(teardown.user ? { user: teardown.user } : {}),
    ...(teardown.identityFile ? { identityFile: teardown.identityFile } : {}),
  };
}

function hasResumeSelector(selector: ResumeSelector): boolean {
  return Object.values(selector).some((value) => value !== undefined);
}

function resumeSelectorFromPath(path: DefinitionRunPath, includeRun: boolean): ResumeSelector {
  return {
    instance: path.instanceIndex + 1,
    ...(!path.clusterlessSession && path.clusterIndex !== undefined ? { cluster: path.clusterIndex + 1 } : {}),
    ...(path.clusterlessSession && includeRun && path.sessionIndex !== undefined
      ? { clusterlessSession: path.sessionIndex + 1 }
      : {}),
    ...(!path.clusterlessSession && includeRun && path.sessionIndex !== undefined ? { session: path.sessionIndex + 1 } : {}),
    ...(includeRun && path.runIndex !== undefined ? { run: path.runIndex + 1 } : {}),
  };
}

function resumeSelectorFlags(selector: ResumeSelector): string[] {
  return [
    ...(selector.instance !== undefined ? [`--resume-instance=${selector.instance}`] : []),
    ...(selector.cluster !== undefined ? [`--resume-cluster=${selector.cluster}`] : []),
    ...(selector.clusterlessSession !== undefined ? [`--resume-clusterless-session=${selector.clusterlessSession}`] : []),
    ...(selector.session !== undefined ? [`--resume-session=${selector.session}`] : []),
    ...(selector.run !== undefined ? [`--resume-run=${selector.run}`] : []),
  ];
}

function formatResumeCommand(point: ResumePoint, definitionPath: string, selector: ResumeSelector): string {
  // Always include --interactive: a resume is a hands-on debugging step, and the
  // resumed run needs to be able to prompt (e.g. teardown choices) just like the
  // original interactive run did.
  return `${runDefinitionPrefix()} --interactive --resume-at=${point} ${resumeSelectorFlags(selector).join(" ")} ${definitionPath}`.replace(/\s+/g, " ").trim();
}

function resumeSelectorMatchesPath(selector: ResumeSelector, path: DefinitionRunPath): boolean {
  const clusterlessSession = path.clusterlessSession === true;
  return (
    (selector.instance === undefined || selector.instance === path.instanceIndex + 1) &&
    (selector.cluster === undefined || (!clusterlessSession && selector.cluster === (path.clusterIndex ?? 0) + 1)) &&
    (selector.clusterlessSession === undefined || (clusterlessSession && selector.clusterlessSession === (path.sessionIndex ?? 0) + 1)) &&
    (selector.session === undefined || (!clusterlessSession && selector.session === (path.sessionIndex ?? 0) + 1)) &&
    (selector.run === undefined || selector.run === (path.runIndex ?? 0) + 1)
  );
}



/**
 * Translate a run path into a {@link FailureContext} so the end-of-run summary
 * line names the cluster/session (functional) or just the session (clusterless /
 * situational) that failed, rather than internal loop counters.
 */
function failureContextFromPath(path: DefinitionRunPath, label?: string): FailureContext {
  if (path.clusterlessSession) {
    return {
      instanceIndex: path.instanceIndex,
      clusterless: true,
      ...(path.sessionIndex !== undefined ? { sessionIndex: path.sessionIndex } : {}),
      ...(path.runIndex !== undefined ? { runIndex: path.runIndex } : {}),
      ...(label ? { label } : {}),
    };
  }
  return {
    instanceIndex: path.instanceIndex,
    ...(path.clusterIndex !== undefined ? { clusterIndex: path.clusterIndex } : {}),
    ...(path.sessionIndex !== undefined ? { sessionIndex: path.sessionIndex } : {}),
    ...(path.runIndex !== undefined ? { runIndex: path.runIndex } : {}),
    ...(label ? { label } : {}),
  };
}

/**
 * The standardised position label for a failure in a group, matching the
 * `aws1 / 7.6-stable / java:main / func` form used in run headers and log
 * prefixes. With a `run` it names the full path; without one (a cluster- or
 * instance-level failure that has no single run) it names just the box and, for
 * functional groups, the cluster.
 */
function failureLabel(group: ResolvedExecutionGroup, run?: ResolvedExecutionRun): string {
  const instanceKind = group.instance.kind;
  const clusterMode = group.type === "functional" ? group.clusterMode : undefined;
  const clusterVersion = clusterVersionLabel(group);
  const cng = group.cng;
  const capella = isCapellaGroup(group);
  if (run) {
    const isRunCapella = run.type === "functional" && (run.cluster?.flavour === "internal-capella" || run.cluster?.flavour === "production-capella");
    return formatRunLabel(run.path, runLabelParts(instanceKind, clusterMode, run, clusterVersion, cng, isRunCapella, isCapellaAnalyticsGroup(group)));
  }
  return [instanceLabel(group.path, instanceKind), clusterSegmentLabel(group.path, clusterMode, clusterVersion, isEnterpriseAnalyticsGroup(group), capella, isCapellaAnalyticsGroup(group))]
    .filter((segment): segment is string => Boolean(segment))
    .join(" / ");
}


interface TeardownInputs {
  definitionPath: string;
  /** Artifact directory for this run; undefined if the run failed before it was created. */
  runDir?: string;
  executionGroupIndex: number;
  /** Within the active execution group, the run that was active at teardown. */
  runIndex: number;
  resumePath?: DefinitionRunPath;
  /** The remote/local context — absent if the run failed before it came up. */
  execution?: FitExecutionContext;
  teardown: ExecutionTargetTeardown;
  /** Whether the run forced every execution group onto localhost; persisted so resume matches. */
  forceLocalhost: boolean;
  /** Whether the run forced every execution group onto a fresh EC2 instance; persisted so resume matches. */
  forceAws: boolean;
  clusterState?: ResumeClusterState;
  performers: readonly RunningPerformer[];
  performerStates: readonly ResumePerformerState[];
  /** Per-run pass/fail outcomes so far, shown as a summary before the leave-up prompt. */
  results: readonly RunResultSummary[];
  cbcollect?: boolean;
  /** See {@link RunFromDefinitionOptions.promptScope}. */
  promptScope?: string;
}

/**
 * Suffix a fixed prompt id with a per-run scope so that repeated runFromDefinition
 * calls in a single process (a preset group running several presets in sequence)
 * don't reuse the same id and trip the replay "used more than once" guard. Returns
 * the base id unchanged when no scope is set, keeping single-run prompt ids stable.
 */
export function scopedPromptId(base: string, scope: string | undefined): string {
  return scope ? `${base}.${scope}` : base;
}

/**
 * Delete a Capella cluster's AWS PrivateLink VPC endpoint(s), if any. Runs
 * against fit-cli's own AWS credentials (not the remote box) — cbdinocluster's
 * `remove` only tears down the cluster itself, never a successfully-linked
 * ("available") VPC endpoint, so this must run separately or the endpoint leaks.
 * `couchbaseClusterUuid` is the Couchbase cluster's own UUID (see
 * {@link ResumeClusterState.couchbaseClusterUuid}), not cbdinocluster's own
 * cluster id — the VPC endpoint is tagged with the former.
 * Best-effort: failure here doesn't fail the run's teardown.
 */
async function deleteClusterPrivateEndpoint(couchbaseClusterUuid: string): Promise<void> {
  try {
    await deleteVpcEndpointsForCluster(couchbaseClusterUuid);
  } catch (err) {
    fitCliWarn(`⚠ Failed to delete the private endpoint's VPC endpoint for cluster ${couchbaseClusterUuid}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Tear down just an execution group's own cluster and performers (not the box):
 * stop its performers and remove a cluster it allocated. Used when the box is shared
 * with later execution groups from the same definition instance, so the instance is
 * kept up while this group's per-group resources are cleaned away.
 */
async function disposeGroupClusterAndPerformers(
  execution: FitExecutionContext | undefined,
  clusterState: ResumeClusterState | undefined,
  performers: readonly RunningPerformer[],
  cbcollect = false,
): Promise<void> {
  if (!execution) {
    return;
  }
  for (const performer of performers) {
    await stopManagedPerformer(execution, performer);
  }
  popLogContext("performer", "run");
  if (clusterState?.allocated && clusterState.clusterId && clusterState.cbdinoclusterCommand) {
    if (clusterState.logsDir && cbcollect) {
      await collectClusterLogs(clusterState.cbdinoclusterCommand, clusterState.clusterId, clusterState.logsDir, execution);
    }
    await removeCluster(clusterState.cbdinoclusterCommand, clusterState.clusterId, execution);
    if (clusterState.privateEndpointEnabled && clusterState.couchbaseClusterUuid) {
      await deleteClusterPrivateEndpoint(clusterState.couchbaseClusterUuid);
    }
    popLogContext("cluster");
  }
}

/**
 * Tear down a single execution group's resources without prompting: stop its performers,
 * remove a cluster it allocated, and terminate an instance fit-cli provisioned for
 * it. Used at the end of the last execution group sharing a box (when it isn't the
 * one we might leave up for debugging).
 */
async function disposeCycleResources(
  execution: FitExecutionContext | undefined,
  teardown: ExecutionTargetTeardown,
  clusterState: ResumeClusterState | undefined,
  performers: readonly RunningPerformer[],
  cbcollect = false,
): Promise<void> {
  await disposeGroupClusterAndPerformers(execution, clusterState, performers, cbcollect);
  if (teardown.terminate) {
    await terminateInstanceWithGuidance(teardown);
  }
}

/**
 * Terminate the run's EC2 instance, printing loud, actionable guidance if it fails. With the
 * refreshing credentials provider a failure here should no longer be a `RequestExpired` (the SDK
 * re-assumes fit-cli-role), but if teardown still can't terminate — e.g. the underlying SSO
 * session itself lapsed — the instance keeps costing money, so make that impossible to miss
 * rather than let it disappear behind a generic error. Re-throws so existing error handling runs.
 */
async function terminateInstanceWithGuidance(teardown: ExecutionTargetTeardown): Promise<void> {
  console.log(`\nTerminating instance ${teardown.instanceId ?? ""}...`);
  try {
    await teardown.terminate!();
    console.log("✓ Terminated.");
    clearLogContext();
  } catch (err) {
    console.error(
      `\n✗ Failed to terminate instance ${teardown.instanceId ?? "(unknown)"}: ${(err as Error).message}\n` +
        `  It is STILL RUNNING and incurring AWS charges. Remove it with:\n` +
        (teardown.instanceId ? `    ${terminateInstanceCommand(teardown.instanceId)}\n` : "") +
        `  or sweep every fit-cli instance you own:\n    fit cloud-instances remove-all`,
    );
    throw err;
  }
}

/**
 * Which resume points the saved state actually supports, in run order — so the
 * leave-up message only suggests points that will work given how far the run got
 * (e.g. no `after-cluster-creation` when no cluster was stood up).
 */
function resumeSuggestions(inputs: TeardownInputs): ResumePoint[] {
  const { teardown, execution, clusterState, performerStates } = inputs;
  const points: ResumePoint[] = [];
  // A remote box we can reconnect to: reuse the instance, re-prepare the rest.
  if (teardown.kind === "remote" && teardown.address) {
    points.push("after-instance-creation");
    // The workspace is only prepared once the execution context came up.
    if (execution) {
      points.push("after-remote-preparation");
    }
  }
  if (clusterState) {
    points.push("after-cluster-creation");
  }
  if (performerStates.length > 0) {
    points.push("after-performer");
  }
  return points;
}

/**
 * Print one JUnit results table per run (with a heading) before the leave-up
 * prompt, so the user can see exactly how each run did before deciding whether
 * to keep resources up for debugging.
 */
function printRunResultsTables(results: readonly RunResultSummary[]): void {
  for (const result of results) {
    const heading = `${result.pathLabel}`;
    console.log(`\n── ${heading} ──`);
    if (result.surefireDir) {
      process.stdout.write(junitToPlainTextFromDir(result.surefireDir));
    } else {
      console.log(`${result.ok ? "PASS" : "FAIL"} — no test report available`);
    }
    if (result.situationalResultsCsv) {
      const rows = readSituationalResultsCsv(result.situationalResultsCsv);
      if (rows) {
        console.log("");
        process.stdout.write(renderSituationalResultsPlainText(rows));
      }
    }
  }
}

/**
 * Ask once whether to leave everything up for debugging and resuming. If so,
 * record the run state and leave the instance, cluster and performers running;
 * otherwise stop the performers, remove an allocated cluster, and terminate an
 * instance fit-cli provisioned. The execution context may be absent (the run
 * failed before it came up); only the instance is then up to leave or terminate.
 */
async function teardownRun(inputs: TeardownInputs): Promise<{ leftUp: boolean }> {
  const { definitionPath, runDir, executionGroupIndex, runIndex, resumePath, execution, teardown, forceLocalhost, forceAws, clusterState, performers, performerStates, results, cbcollect = false, promptScope } = inputs;

  const nothingToLeaveUp = !teardown.terminate && !clusterState && performerStates.length === 0;
  if (nothingToLeaveUp) {
    return { leftUp: false };
  }

  // The run is over (this is the only teardown, run from the outer finally). Make
  // that explicit — the leave-up prompt that follows used to appear right after a
  // "moving to next iteration" line, which read as if more was still to come — then
  // show how each run did so the leave-up choice is informed.
  console.log("\n── Run finished — no more iterations, clusters or instances to run. ──");
  // Only reprint in interactive mode: in non-interactive mode the leave-up prompt
  // answers itself with the default anyway, and the results were already printed by
  // recordResult as each run completed, so reprinting here is just noise.
  if (results.length > 0 && isInteractiveRun()) {
    printRunResultsTables(results);
  }

  let leaveUp: boolean;
  try {
    leaveUp = await confirm({
      promptId: scopedPromptId("run-from-definition.teardown.leave-up", promptScope),
      message: "Leave everything up (instance, cluster, performer) for debugging and resuming?",
      default: false,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "ExitPromptError" && teardown.terminate && teardown.instanceId) {
      fitCliWarn(`\nInstance ${teardown.instanceId} is still running — remember to terminate it when done.`);
      console.log(`\nTerminate it with:\n  ${terminateInstanceCommand(teardown.instanceId)}`);
    }
    throw err;
  }

  if (leaveUp) {
    const state: RunState = {
      version: 1,
      executionGroupIndex,
      startRunIndex: runIndex,
      ...(forceLocalhost ? { forceLocalhost } : {}),
      ...(forceAws ? { forceAws } : {}),
      target: targetStateFrom(teardown),
      ...(clusterState ? { cluster: clusterState } : {}),
      performers: [...performerStates],
    };
    const path = runDir ? writeRunState(runDir, state) : undefined;
    console.log(`\n✓ Leaving everything up.${path ? ` Saved run state to:\n  ${path}` : ""}`);

    // List exactly what's been left running so it's clear what is still costing
    // money / holding resources and needs cleaning up later.
    const leftRunning: string[] = [];
    if (teardown.terminate && teardown.instanceId) {
      leftRunning.push(`Instance: ${teardown.instanceId}${teardown.address ? ` (${teardown.address})` : ""}`);
    }
    if (clusterState) {
      const clusterId = clusterState.clusterId ?? clusterState.cluster.defaultHostname;
      leftRunning.push(`Cluster:  ${clusterId}${clusterState.allocated ? " (allocated by this run)" : ""}`);
    }
    for (const performer of performerStates) {
      const version = performer.version ? `@${performer.version}` : "";
      leftRunning.push(`Performer: ${performer.sdk}${version} — container ${performer.containerId} on port ${performer.port}`);
    }
    if (leftRunning.length > 0) {
      console.log(`\nLeft running:\n${leftRunning.map((line) => `  - ${line}`).join("\n")}`);
    }

    const suggestions = resumeSuggestions(inputs);
    const lastSuggestion = suggestions[suggestions.length - 1];
    const resumeDefinitionPath = runDir ? join(runDir, basename(resolve(definitionPath))) : definitionPath;
    if (lastSuggestion && resumePath) {
      console.log(
        `\nResume after a manual fix with:\n  ${formatResumeCommand(lastSuggestion, resumeDefinitionPath, resumeSelectorFromPath(resumePath, true))}`,
      );
    }
    if (teardown.terminate && teardown.instanceId) {
      fitCliWarn(`\nInstance ${teardown.instanceId} is still running — remember to terminate it when done.`);
      if (teardown.identityFile && teardown.user && teardown.address) {
        console.log(`\nSSH in with:\n  ssh -i ${teardown.identityFile} ${teardown.user}@${teardown.address}`);
        console.log(`\nOr via EC2 Instance Connect (no key needed — requires ec2-instance-connect:SendSSHPublicKey):\n  aws ec2-instance-connect ssh --instance-id ${teardown.instanceId} --os-user ${teardown.user} --region ${AWS_REGION}`);
      }
      console.log(`\nTerminate it with:\n  ${terminateInstanceCommand(teardown.instanceId)}`);
    }
    return { leftUp: true };
  }

  // Performer and cluster cleanup need the context; skipped if it never came up.
  if (execution) {
    for (const performer of performers) {
      await stopManagedPerformer(execution, performer);
    }
    popLogContext("performer", "run");
    if (clusterState?.allocated && clusterState.clusterId && clusterState.cbdinoclusterCommand) {
      if (clusterState.logsDir && cbcollect) {
        await collectClusterLogs(clusterState.cbdinoclusterCommand, clusterState.clusterId, clusterState.logsDir, execution);
      }
      await removeCluster(clusterState.cbdinoclusterCommand, clusterState.clusterId, execution);
      if (clusterState.privateEndpointEnabled && clusterState.couchbaseClusterUuid) {
        await deleteClusterPrivateEndpoint(clusterState.couchbaseClusterUuid);
      }
      popLogContext("cluster");
    }
  }
  if (teardown.terminate) {
    await terminateInstanceWithGuidance(teardown);
  }
  return { leftUp: false };
}

/**
 * Whether this run is interactive (so we can prompt) or running with default
 * answers (CI). Mirrors how PromptSession decides its mode: the `definition`
 * command (every launch form, via markNonInteractiveByDefault) and the
 * run-from-definition entrypoint default to non-interactive unless `--interactive`
 * is passed. The wizard reaches runFromDefinition without that marker, so it
 * stays interactive.
 */
function isInteractiveRun(): boolean {
  const { interactive } = extractInteractiveFlag(process.argv.slice(2));
  return interactive || !defaultsToNonInteractive();
}

/**
 * Decide the run-wide override for where every execution group runs, ignoring each
 * group's `instance:` setting. Resuming reuses the earlier run's choice. Otherwise:
 * interactively we ask whether to honour the file (default), force everything onto
 * localhost, or run every group on one existing EC2 instance; non-interactively we
 * honour the definition file so a CI run provisions whatever the file asks for.
 */
async function resolveExecutionOverride(
  groups: readonly ResolvedExecutionGroup[],
  savedState: RunState | undefined,
  promptScope: string | undefined,
): Promise<ExecutionOverride> {
  if (savedState) {
    if (savedState.forceLocalhost) return { kind: "localhost" };
    if (savedState.forceAws) return { kind: "aws" };
    return { kind: "definition" };
  }
  if (!isInteractiveRun()) {
    return { kind: "definition" };
  }
  const allSameKind = groups.every((g) => g.instance.kind === groups[0].instance.kind);
  const definitionDestination =
    groups.length === 1 || allSameKind
      ? groups[0].instance.kind
      : groups.map((g, i) => `group ${i + 1}: ${g.instance.kind}`).join(", ");
  const allLocalhost = groups.every((g) => g.instance.kind === "localhost");
  const requiresCloudCluster = groups.some(
    (g) => g.cng || (g.instance.kind === "aws" && g.instance.privateEndpoint !== undefined),
  );
  for (let attempt = 1; ; attempt++) {
    const choice = await select<ExecutionOverride["kind"]>({
      promptId: scopedPromptId(`run-from-definition.execution-override.attempt-${attempt}`, promptScope),
      message: "Where should this run execute?",
      default: "definition",
      choices: [
        { name: `Where the definition says: ${definitionDestination}`, value: "definition" },
        ...(allLocalhost ? [{ name: "On a fresh EC2 instance (provision a new one)", value: "aws" as const }] : []),
        {
          name: "Everything on localhost (good for testing and local development)",
          value: "localhost",
          ...(requiresCloudCluster
            ? { disabled: "can't test CNG or a Private Endpoint locally" }
            : {}),
        },
        { name: "Everything on an existing EC2 instance (good for rapid iteration)", value: "existing" },
      ],
    });
    if (choice === "definition" || choice === "localhost" || choice === "aws") {
      return { kind: choice };
    }
    const existing = await selectExistingInstanceForOverride(attempt);
    if (existing !== "back") {
      return { kind: "existing", existing };
    }
    // Couldn't connect to an existing instance; loop back to the choice.
  }
}

/** One-line description of where a group will run, given the run-wide override. */
function describeExecutionOverride(override: ExecutionOverride, declaredKind: string): string {
  switch (override.kind) {
    case "localhost":
      return "localhost (forced)";
    case "aws":
      return "EC2 (fresh instance, forced)";
    case "existing":
      return `existing EC2 instance ${override.existing.host} (forced)`;
    default:
      return declaredKind;
  }
}

export interface RunFromDefinitionOptions {
  resumeAt?: ResumePoint;
  resumeSelector?: ResumeSelector;
  cbcollect?: boolean;
  /**
   * Disambiguator appended to prompt ids that are issued once per runFromDefinition
   * call. When a preset group runs several presets in one process (see run.ts), each
   * call would otherwise reuse the same fixed prompt id (e.g. the teardown leave-up
   * prompt) and trip the "used more than once in this run" replay guard. Left unset
   * for single-preset / single-definition runs so their prompt ids stay unchanged.
   */
  promptScope?: string;
}

/** Run FIT functional tests as described by the definition file at `definitionPath`. */
export async function runFromDefinition(
  definitionPath: string,
  options: RunFromDefinitionOptions = {},
): Promise<RunOutput> {
  const tracker = new RunFailureTracker();
  const { resumeAt, resumeSelector = {}, cbcollect = false, promptScope } = options;
  const phases = phasesForResumePoint(resumeAt);
  const definition = loadDefinition(definitionPath);
  const resolved = resolveDefinition(definition);
  const executionGroups = buildExecutionGroups(resolved.instances);
  console.log(`\nRunning FIT tests from definition:\n  ${definitionPath}`);
  if (definition.description) {
    console.log(`  Description: ${definition.description}`);
  }

  const preconditionCtx: FailureContext = { instanceIndex: 0 };
  const savedState = resumeAt ? readRunState(dirname(resolve(definitionPath))) : undefined;
  if (resumeAt) {
    if (!savedState) {
      fitCliError(
        { classification: "FatalToAll" },
        `\nresume: no saved run state found for ${definitionPath}. ` +
          "Run without --resume-at first, then choose to leave everything up.",
      );
      tracker.record("FatalToAll", "No saved run state found for resume", preconditionCtx);
      return finalizeRunFromDefinition([], [], undefined, tracker.worst, tracker.failureCount);
    }
    console.log(`  Resuming at: ${resumeAt}`);
    // Show our working: a resume hinges on this interim bookkeeping file, so dump
    // its path and contents — what target we'll reconnect to, which cluster and
    // performers we'll reuse — rather than silently acting on it.
    const statePath = runStatePath(dirname(resolve(definitionPath)));
    console.log(`  Read saved run state from:\n    ${statePath}\n  Contents:`);
    printWithoutTimestamps(`${JSON.stringify(savedState, null, 2)}\n`);
  }
  const startCycleIndex = savedState?.executionGroupIndex ?? 0;
  const startIterationIndex = savedState?.startRunIndex ?? 0;
  const startGroup = executionGroups[startCycleIndex];
  const allRunsInStartCycle = startGroup?.type === "functional"
    ? startGroup.sessions.flatMap((s) => s.runs)
    : (startGroup?.runs ?? []);
  const expectedResumePath = allRunsInStartCycle[startIterationIndex]?.path;
  if (resumeAt && hasResumeSelector(resumeSelector)) {
    if (!expectedResumePath) {
      fitCliError(
        { classification: "FatalToAll" },
        "\nresume: the saved run state points at a run that no longer exists in this definition.",
      );
      tracker.record("FatalToAll", "Saved run state points at a run that no longer exists", preconditionCtx);
      return finalizeRunFromDefinition([], [], undefined, tracker.worst, tracker.failureCount);
    }
    if (!resumeSelectorMatchesPath(resumeSelector, expectedResumePath)) {
      fitCliError(
        { classification: "FatalToAll" },
        `\nresume: the requested path does not match the saved run state.\n` +
          `  Requested: ${resumeSelectorFlags(resumeSelector).join(" ")}\n` +
          `  Saved:     ${formatRunLabel(expectedResumePath)}`,
      );
      tracker.record("FatalToAll", "Requested resume path does not match saved run state", preconditionCtx);
      return finalizeRunFromDefinition([], [], undefined, tracker.worst, tracker.failureCount);
    }
  }

  // One run-wide choice over where every execution group runs: honour the file, force
  // localhost, or run all groups on one existing EC2 instance. Resolved this early
  // (ahead of the GitHub/AWS credential checks below) so we know whether AWS will be
  // needed at all before checking for it. Each group then provisions (or reconnects)
  // its own target accordingly. `forceLocalhost`/`forceAws` are the parts we persist
  // for resume; the existing-instance override is a within-run convenience and isn't saved.
  const executionOverride = await resolveExecutionOverride(executionGroups.slice(startCycleIndex), savedState, promptScope);
  const forceLocalhost = executionOverride.kind === "localhost";
  const forceAws = executionOverride.kind === "aws";
  const willRunOnAws =
    !forceLocalhost &&
    (forceAws ||
      executionGroups.slice(startCycleIndex).some((group) => group.type === "situational") ||
      (executionOverride.kind === "definition" &&
        executionGroups.slice(startCycleIndex).some((g) => g.instance.kind === "aws")));

  // AWS is needed for EC2 execution groups AND for situational cbdinocluster cloud-deployer
  // runs (even on localhost's own machine, credentials get forwarded to the remote box).
  // Check this before anything else that might need AWS — including GitHub credentials
  // below, whose own AWS Secrets Manager fallback would otherwise produce a confusing
  // "localhost.github.user not found" error when the real problem is AWS credentials.
  let awsCredentials: AwsCredentials | undefined;
  if (willRunOnAws) {
    const result = await checkAwsCredentials();
    if (!result.ok) {
      fitCliError({ classification: "FatalToAll" }, `\n✗ ${result.message}`);
      tracker.record("FatalToAll", result.message, preconditionCtx);
      return finalizeRunFromDefinition([], [], undefined, tracker.worst, tracker.failureCount);
    }
    awsCredentials = result.credentials;
  }

  // Resolve GitHub credentials upfront so we fail before provisioning an instance.
  // Needed for functional cbdinocluster groups, and for situational CNG groups too
  // (cbdinocluster's own GitHub config is what CAO uses to pull the private
  // ghcr.io/cb-rhcc images — without it, cbdinocluster init runs with
  // --disable-github and CAO can't authenticate the image pull).
  let githubCredentials: { user: string; token: string } | undefined;
  if (needsGithubCredentials(phases, executionGroups, startCycleIndex)) {
    const result = await resolveGithubCredentials();
    if (typeof result === "string") {
      fitCliError({ classification: "FatalToAll" }, `\n✗ ${result}`);
      tracker.record("FatalToAll", result, preconditionCtx);
      return finalizeRunFromDefinition([], [], undefined, tracker.worst, tracker.failureCount);
    }
    githubCredentials = result;
  }

  // Check hosted results-database credentials upfront — fail before provisioning
  // an instance when credentials can't be resolved from AWS Secrets Manager.
  const needsHostedDatabase = executionGroups
    .slice(startCycleIndex)
    .some(
      (group) =>
        group.type === "situational" &&
        group.runs.some((run) => run.databaseMode === "hosted"),
    );
  // block -> host, populated during credential resolution; used later for connectivity checks.
  const resultsEnvHosts = new Map<string, string>();
  if (needsHostedDatabase) {
    // Each hosted situational run names a results environment; validate every distinct
    // one upfront (credentials resolvable from AWS) before provisioning.
    const resultsEnvs = new Set<string>();
    for (const group of executionGroups.slice(startCycleIndex)) {
      if (group.type !== "situational") continue;
      for (const run of group.runs) {
        if (run.databaseMode === "hosted") resultsEnvs.add(run.resultsEnvironment);
      }
    }
    for (const block of resultsEnvs) {
      let host: string;
      try {
        ({ host } = await resolveResultsDbCredentials({ block }));
      } catch (err) {
        fitCliError({ classification: "FatalToAll" }, `\n✗ ${(err as Error).message}`);
        tracker.record("FatalToAll", `Cannot resolve results database credentials for "${block}"`, preconditionCtx);
        return finalizeRunFromDefinition([], [], undefined, tracker.worst, tracker.failureCount);
      }
      resultsEnvHosts.set(block, host);
    }
  }

  const artifacts: Artifact[] = [];
  const details: Detail[] = [];
  // Instance-specific details (SSH command, workspace path, etc.) — only included
  // in the final summary when the instance is left up for debugging; meaningless
  // (and misleading) after the instance is terminated.
  const instanceDetails: Detail[] = [];
  // Per-run pass/fail outcomes, collected as the loop runs (even for runs that
  // fail) so teardown can show a results summary before asking to leave up.
  const runResults: RunResultSummary[] = [];
  const recordResult: RecordRunResult = (result) => {
    runResults.push(result);
    // Show results immediately so users see each run's outcome as it completes
    // rather than waiting for all runs to finish.
    const heading = `${result.pathLabel} (${result.sdk})`;
    console.log(`\n── ${heading} ──`);
    if (result.surefireDir) {
      process.stdout.write(junitToPlainTextFromDir(result.surefireDir));
    } else {
      console.log(`${result.ok ? "PASS" : "FAIL"} — no test report available`);
    }
    if (result.situationalResultsCsv) {
      const rows = readSituationalResultsCsv(result.situationalResultsCsv);
      if (rows) {
        console.log("");
        process.stdout.write(renderSituationalResultsPlainText(rows));
      }
    }
    // appendRunSummaryToGhaSummary is synchronous and catches its own errors internally.
    appendRunSummaryToGhaSummary(result);
  };

  const runDir = ensureRunDir();
  const definitionCopyPath = join(runDir, basename(resolve(definitionPath)));
  copyFileSync(definitionPath, definitionCopyPath);
  artifacts.push(artifactFromPath(definitionCopyPath, "Definition file used for this run", runDir));

  // Fail early if any group will run on localhost but the performer checkout isn't configured.
  // The same check happens inside ensureWorkspace, but that fires deep into the run (after
  // cluster creation), so catching it here saves the user a long wait.
  const willRunLocally =
    forceLocalhost ||
    (executionOverride.kind === "definition" &&
      executionGroups.slice(startCycleIndex).some((g) => g.instance.kind === "localhost"));
  if (willRunLocally && !resolveFitPerformerDir()) {
    fitCliError(
      { classification: "FatalToAll" },
      `\n✗ No local transactions-fit-performer checkout is configured.\n` +
        `  Run \`${runScriptPrefix("config")} edit\` and enable localhost testing ` +
        `(sets localhost.repos."transactions-fit-performer".dir).`,
    );
    tracker.record("FatalToAll", "No local transactions-fit-performer checkout configured", preconditionCtx);
    return finalizeRunFromDefinition([], [], undefined, tracker.worst, tracker.failureCount);
  }

  // Local connectivity check — skip when running remotely, since EC2 instances are
  // in the same VPC as faas.couchbase.com and can reach it without VPN.
  if (needsHostedDatabase && forceLocalhost) {
    for (const [block, host] of resultsEnvHosts) {
      console.log(`\nChecking connectivity to the "${block}" results database at ${host}...`);
      if (!(await checkResultsDatabaseConnectivity(undefined, host))) {
        fitCliError(
          { classification: "FatalToAll" },
          `\n✗ Cannot reach the results database at ${host}:5432.\n` +
            `  Make sure you are connected to the vpn-public VPN.`,
        );
        tracker.record("FatalToAll", `Cannot reach results database at ${host}:5432`, preconditionCtx);
        return finalizeRunFromDefinition([], [], undefined, tracker.worst, tracker.failureCount);
      }
      console.log(`  ✓ Reached ${host}.`);
    }
  }

  // The "active" set tracks the cycle currently up so the outer finally tears down
  // (or offers to leave up) the right instance/cluster/performers. Completed,
  // non-final cycles dispose of their own resources inside the loop.
  //
  // Execution groups from the same definition instance share one box (same
  // path.instanceIndex): we provision/reconnect for the first such group and reuse
  // it for the rest, tearing it down only once the last group on it is done. While a
  // box is shared, activeExecution/activeTeardown persist across cycles;
  // currentBoxInstanceIndex says which definition instance that box belongs to.
  let activeExecution: FitExecutionContext | undefined;
  // Keeps the box's AWS credentials current for the whole run. Credentials assumed from a
  // temporary identity (SSO, instance profile, an already-assumed role) are capped at 1h, so
  // a multi-hour situational/PE suite outlives its own credentials without this. Restarted
  // whenever credentials are (re)installed, stopped once in the outer finally.
  let activeCredsRefresher: RemoteAwsCredsRefresher | undefined;
  // Carried across restarts (a box shared by several execution groups reinstalls credentials
  // per group), so a failure in an earlier group still reaches the end-of-run summary.
  let credsRefreshFailures = 0;
  let credsRefreshLastError: string | undefined;
  // Must be awaited *before* credentials are reinstalled on the same box: a tick still in
  // flight would otherwise be staging the same files concurrently with the install.
  const stopCredsRefresher = async (): Promise<void> => {
    if (!activeCredsRefresher) return;
    await activeCredsRefresher.stop();
    credsRefreshFailures += activeCredsRefresher.failures;
    credsRefreshLastError = activeCredsRefresher.lastError ?? credsRefreshLastError;
    activeCredsRefresher = undefined;
  };
  let activeTeardown: ExecutionTargetTeardown = { kind: "local" };
  let currentBoxInstanceIndex: number | undefined;
  let activeCycleIndex = startCycleIndex;
  let activeIterationIndex = startIterationIndex;
  let activeResumePath: DefinitionRunPath | undefined = expectedResumePath;
  let activeClusterState: ResumeClusterState | undefined;
  let activePerformers: RunningPerformer[] = [];
  let activePerformerStates: ResumePerformerState[] = [];
  try {
    const countGroupIterations = (group: (typeof executionGroups)[number]): number =>
      group.type === "functional"
        ? group.sessions.reduce((s, session) => s + session.runs.length, 0)
        : group.runs.length;
    const totalGlobalIterations = executionGroups.reduce((total, group) => total + countGroupIterations(group), 0);
    let globalIterationIndex = executionGroups
      .slice(0, startCycleIndex)
      .reduce((total, group) => total + countGroupIterations(group), 0);

    try {
    for (let cycleIndex = startCycleIndex; cycleIndex < executionGroups.length; cycleIndex++) {
      activeCycleIndex = cycleIndex;
      if (cycleIndex !== startCycleIndex) {
        activeIterationIndex = 0;
      }
      const group = executionGroups[cycleIndex];
      if (!group) {
        break;
      }
      activeResumePath = group.path;
      clearLogContext();
      console.log(`\nExecution group ${cycleIndex + 1}/${executionGroups.length}: ${group.type}`);
      console.log(`  Execution: ${describeExecutionOverride(executionOverride, group.instance.kind)}`);
      console.log(`  Cluster: ${clusterLabel(group)}`);

      // Acquire this cycle's execution target. Execution groups from the same
      // definition instance share one box: reuse the box (and its prepared
      // workspace) when the previous group belonged to the same instanceIndex;
      // otherwise reconnect the resumed instance for the start cycle, or provision
      // (or run locally) a fresh one per the definition.
      const reuseBox =
        currentBoxInstanceIndex === group.path.instanceIndex && activeExecution !== undefined;
      let cycleTeardown: ExecutionTargetTeardown;
      let execution: FitExecutionContext;
      if (reuseBox) {
        cycleTeardown = activeTeardown;
        execution = activeExecution!;
        console.log(
          `  Instance: reusing the box from the previous execution group (definition instance ${group.path.instanceIndex + 1}).`,
        );
        setLogContext({ env: instanceLabel(group.path, cycleTeardown.kind === "remote" ? "aws" : "localhost") });
      } else {
        const isResumeStartCycle = savedState !== undefined && cycleIndex === startCycleIndex;
        const targetOutcome = isResumeStartCycle
          ? await reconnectExecutionTarget(savedState.target)
          : await resolveExecutionGroupTarget(group.instance, executionOverride, cycleIndex, group.type, isInteractiveRun());
        artifacts.push(...targetOutcome.artifacts);
        instanceDetails.push(...targetOutcome.details);
        if (!targetOutcome.ready) {
          fitCliError({ classification: "FatalToInstance" }, `\n✗ Could not acquire an execution target for execution group ${cycleIndex + 1}; skipping it.`);
          tracker.record("FatalToInstance", `Could not acquire an execution target for execution group ${cycleIndex + 1}`, failureContextFromPath(group.path, failureLabel(group)));
          globalIterationIndex += countGroupIterations(group);
          continue;
        }
        cycleTeardown = targetOutcome.teardown;
        activeTeardown = cycleTeardown;
        setLogContext({ env: instanceLabel(group.path, cycleTeardown.kind === "remote" ? "aws" : "localhost") });
        if (cycleTeardown.kind === "remote" && cycleTeardown.address) {
          printResumeHint("after-instance-creation", definitionCopyPath, group.path, false);
        }

        const firstSdk = group.type === "functional" ? group.sessions[0]?.sdk : group.runs[0]?.sdk;
        execution = await createFitExecutionContext(targetOutcome.target, firstSdk, {
          skipRemotePreparation: isResumeStartCycle && !phases.prepareRemote,
          instancePath: group.path,
        });
        activeExecution = execution;
        currentBoxInstanceIndex = group.path.instanceIndex;
        artifacts.push(...execution.artifacts);
        instanceDetails.push(...execution.details);
        if (phases.prepareRemote && cycleTeardown.kind === "remote" && cycleTeardown.address) {
          printResumeHint("after-remote-preparation", definitionCopyPath, group.path, false);
        }
      }

      // This cycle's situational iterations may stream to the hosted DB; if it runs
      // on a remote box, confirm the box can reach the DB before doing real work.
      const cycleNeedsHostedDatabase =
        group.type === "situational" && group.runs.some((run) => run.databaseMode === "hosted");

      let activeCycle = group;
      let clusterState: ResumeClusterState | undefined;
      const cyclePerformers: RunningPerformer[] = [];
      const cyclePerformerStates: ResumePerformerState[] = [];

      try {
        if (cycleNeedsHostedDatabase && execution.kind === "remote") {
          const blocks = new Set(
            group.type === "situational"
              ? group.runs.filter((run) => run.databaseMode === "hosted").map((run) => run.resultsEnvironment)
              : [],
          );
          for (const block of blocks) {
            const { host } = await resolveResultsDbCredentials({ block });
            console.log(`\nChecking "${block}" results database connectivity from the remote instance...`);
            if (!(await checkResultsDatabaseConnectivity((cmd, args) => execution.capture(cmd, args), host))) {
              throwFatalToCluster(
                `The remote instance cannot reach the results database at ${host}:5432. ` +
                  `Make sure the instance has network access to reach the database (VPN / security-group rules).`,
              );
            }
            console.log(`  ✓ Reached ${host} from the remote instance.`);
          }
        }

        // Functional observability tests (ClusterLabelsTest, GetOrNullObservabilityTest,
        // etc.) send traces/metrics to a shared collector and then poll it back; if it's
        // unreachable from wherever the tests actually run, every one of those tests only
        // discovers that after burning its full 60s-per-assertion retry budget. Check from
        // the box itself (local or remote) so this fails in seconds instead.
        if (group.type === "functional") {
          console.log(`\nChecking observability collector connectivity from the ${execution.kind === "remote" ? "remote instance" : "local machine"}...`);
          if (!(await checkObservabilityCollectorConnectivity((cmd, args) => execution.capture(cmd, args)))) {
            throwFatalToCluster(
              `Cannot reach the observability collector at ${OBSERVABILITY_COLLECTOR_HOST}:${OBSERVABILITY_COLLECTOR_PORT} ` +
                `from the ${execution.kind === "remote" ? "remote instance" : "local machine"}. Functional observability ` +
                `tests will hang until they time out if it's unreachable.`,
            );
          }
          console.log(`  ✓ Reached ${OBSERVABILITY_COLLECTOR_HOST}.`);
        }

        if (group.type === "functional") {
          // CNG cycles need Kubernetes where cbdinocluster runs: check it on
          // localhost, or stand up k3d (and point the uploaded ~/.cbdinocluster at
          // it) on a clean instance, before allocating anything.
          let functionalCycle = await prepareFunctionalCngCycle(group, execution);

          // Capella functional: upload credentials and inject init args + deployer
          // before the cluster setup step. Mirrors the situational branch above but
          // scoped to the cluster (not the instance), using the cluster's `capella`
          // block rather than the instance-level capellaEnvironment.
          const capellaSetup = functionalCycle.cbdinocluster?.capella;
          if (capellaSetup !== undefined) {
            const capellaEnvironment = capellaSetup.environment ?? DEFAULT_CAPELLA_ENV;
            if (execution.kind === "remote") {
              if (!group.cbdinoclusterSource && !(await execution.commandAvailable("cbdinocluster"))) {
                await installCbdinoclusterRemote(execution);
              }
              let capella;
              try {
                capella = await resolveCapellaConfig({ block: capellaEnvironment });
              } catch (err) {
                throwFatalToCluster(
                  `Capella functional runs allocate Capella clusters, but the "${capellaEnvironment}" Capella ` +
                    `credentials couldn't be resolved: ${(err as Error).message}`,
                );
              }
              await uploadRemoteCapellaConfig(execution.target, execution.rootDir, capella);
              // Private endpoint setup needs cbdinocluster's own AWS block enabled (it calls
              // the EC2 API directly for CreateVpcEndpoint) — forward the same fit-cli-role
              // credentials the situational branch uses, so setup-link can authenticate.
              if (capellaSetup.privateEndpoint && awsCredentials) {
                await stopCredsRefresher();
                const expiry = await uploadRemoteAwsCredentials(execution.target, execution.rootDir, awsCredentials);
                activeCredsRefresher = startRemoteAwsCredsRefresher(execution.target, execution.rootDir, expiry);
              }
            }
            // Inject the derived init args and deployer into the cbdinocluster plan.
            // Neither lives in the definition file — both are derived from capella.cloudProvider.
            functionalCycle = {
              ...functionalCycle,
              cbdinocluster: {
                ...functionalCycle.cbdinocluster!,
                init: { args: capellaFunctionalCbdinoclusterInitArgs(capellaSetup.cloudProvider, undefined, capellaSetup.privateEndpoint !== undefined) },
                deployer: "cloud",
              },
            };
          }

          if (cycleIndex === startCycleIndex && !phases.setupCluster) {
            const resumed = await resumeCluster(functionalCycle, savedState, execution);
            activeCycle = resumed.group;
            clusterState = resumed.clusterState;
          } else {
            // Capella Analytics clusters use cbdinocluster's cloud deployer, which
            // requires CAPELLA_* env vars on the box so `cbdinocluster init --auto`
            // writes the capella block.  Mirror the situational path's credential
            // forwarding, but skip AWS (the cloud deployer talks to the Capella
            // control plane, not EC2 directly).
            if (isCapellaAnalyticsGroup(functionalCycle) && execution.kind === "remote") {
              await uploadCapellaCredsForCloudDeployer(
                execution,
                functionalCycle.capellaEnvironment,
                `Capella Analytics clusters use cbdinocluster's cloud deployer`,
              );
              // If the definition didn't supply custom init args, override the
              // default (which disables Capella) with args that leave it enabled.
              if (functionalCycle.cbdinocluster && !functionalCycle.cbdinocluster.init?.args) {
                functionalCycle = {
                  ...functionalCycle,
                  cbdinocluster: {
                    ...functionalCycle.cbdinocluster,
                    init: { ...functionalCycle.cbdinocluster.init, args: capellaAnalyticsCbdinoclusterInitArgs() },
                  },
                };
              }
            }
            const setup = await setupCluster(functionalCycle, execution, setupDeclarativeCluster, githubCredentials);
            activeCycle = setup.group;
            clusterState = setup.clusterState;
            artifacts.push(...setup.artifacts);
            details.push(...setup.details);
            if (cbdinoclusterSetupFailed(activeCycle, true)) {
              throwFatalToCluster("setup-cluster didn't produce a cluster, so this execution group can't continue.");
            }
            if (clusterState) {
              printResumeHint("after-cluster-creation", definitionCopyPath, activeCycle.path, false);
            }
          }
          if (clusterState) {
            await printClusterUiAccess(
              clusterState.cluster,
              cycleTeardown.kind === "remote" && cycleTeardown.address && cycleTeardown.user && cycleTeardown.identityFile
                ? { address: cycleTeardown.address, user: cycleTeardown.user, identityFile: cycleTeardown.identityFile }
                : undefined,
            );
            setLogContext({
              cluster: clusterSegmentLabel(activeCycle.path, activeCycle.clusterMode, clusterVersionLabel(activeCycle), isEnterpriseAnalyticsGroup(activeCycle), isCapellaGroup(activeCycle), isCapellaAnalyticsGroup(activeCycle)),
            });
          }
        } else if (group.cng) {
          // CNG situational: cbdino deploys the cluster via the Couchbase
          // Autonomous Operator, not the Capella cloud deployer, so there are no
          // Capella/AWS credentials to forward — just a working Kubernetes.
          if (execution.kind === "remote" && !group.cbdinoclusterSource && !(await execution.commandAvailable("cbdinocluster"))) {
            await installCbdinoclusterRemote(execution);
          }
          const cngGroup = await prepareSituationalCngCycle(group, execution);
          await prepareCbdinoclusterInit(
            execution,
            cngGroup.cbdinoclusterInit,
            githubCredentials,
            instanceRunDir(group.path),
            group.cbdinoclusterSource,
          );
        } else {
          const capellaEnvironment = group.type === "situational" ? group.capellaEnvironment : DEFAULT_CAPELLA_ENV;
          let capellaEndpoint: string | undefined;
          if (execution.kind === "remote") {
            // When a source is specified the binary will be built from the PR
            // by prepareCbdinoclusterInit → resolveCbdinoclusterCommand; skip
            // the pre-emptive release install so we don't waste time installing
            // the latest release only to overwrite it immediately with a PR build.
            if (!group.cbdinoclusterSource && !(await execution.commandAvailable("cbdinocluster"))) {
              await installCbdinoclusterRemote(execution);
            }
            // Forward Capella and AWS settings before init so `cbdinocluster init --auto`
            // (run via a login shell sourcing ~/.profile) picks them up and writes the
            // capella and aws blocks. Without a username it can't enable Capella, so fail
            // clearly rather than letting `cbdinocluster allocate` later fail with "no deployers".
            capellaEndpoint = await uploadCapellaCredsForCloudDeployer(
              execution,
              capellaEnvironment,
              `Situational runs allocate Capella clusters`,
            );
            if (awsCredentials) {
              await stopCredsRefresher();
              const expiry = await uploadRemoteAwsCredentials(execution.target, execution.rootDir, awsCredentials);
              activeCredsRefresher = startRemoteAwsCredsRefresher(execution.target, execution.rootDir, expiry);
            }
          }
          await prepareCbdinoclusterInit(
            execution,
            group.cbdinoclusterInit,
            githubCredentials,
            instanceRunDir(group.path),
            group.cbdinoclusterSource,
          );
          // Fail fast if init left the cloud (Capella) deployer disabled — otherwise
          // every situational test fatals later at `allocate --deployer cloud` with
          // "no deployers". See remoteCbdinoclusterCloudEnabled.
          if (!(await remoteCbdinoclusterCloudEnabled(execution, capellaEndpoint))) {
            throwFatalToCluster(
              `cbdinocluster init left the Capella (cloud) deployer disabled on the instance, so ` +
                `situational tests can't allocate clusters (they would fail later with "no deployers"). ` +
                `Check that the "${capellaEnvironment}" Capella settings were picked up by the init step above.`,
            );
          }
        }

        const allSessionsAndRuns = activeCycle.type === "functional"
          ? activeCycle.sessions.flatMap((session) => session.runs.map((run) => ({ session, run })))
          : activeCycle.runs.map((run) => ({ session: null as null, run }));
        const totalIterations = allSessionsAndRuns.length;

        // Iterate sessions (functional) or runs (situational). For functional groups,
        // each session owns its own performer: start it before the session's first run,
        // reuse it across all runs in that session, stop it after the last run.
        let sessionPerformer: RunningPerformer | undefined;
        let activeSessionIndex: number | undefined;
        for (const [cycleIterationIndex, { session, run: iteration }] of allSessionsAndRuns.entries()) {
          if (cycleIndex === startCycleIndex && cycleIterationIndex < startIterationIndex) {
            globalIterationIndex++;
            continue;
          }
          activeIterationIndex = cycleIterationIndex;
          activeResumePath = iteration.path;
          const isLastIteration = cycleIterationIndex === totalIterations - 1;

          // Detect session boundary: when the session changes, stop the old performer.
          const currentSessionIndex = session ? iteration.path.sessionIndex : undefined;
          if (session && currentSessionIndex !== activeSessionIndex) {
            if (sessionPerformer) {
              await stopManagedPerformer(execution, sessionPerformer);
              sessionPerformer = undefined;
            }
            activeSessionIndex = currentSessionIndex;
          }

          announce(activeCycle, iteration, resolved.fitPerformerGerritRef, globalIterationIndex, totalGlobalIterations);
          const isStartIteration = cycleIndex === startCycleIndex && cycleIterationIndex === startIterationIndex;
          const setupPerformerPhase = isStartIteration ? phases.setupPerformer : true;
          try {
            const { output, performer } = await runIteration(
              execution,
              activeCycle.type === "functional" ? activeCycle.clusterMode : undefined,
              resolved.fitPerformerGerritRef,
              iteration,
              setupPerformerPhase,
              savedState,
              globalIterationIndex,
              definitionPath,
              recordResult,
              clusterVersionLabel(activeCycle),
              sessionPerformer,
            );
            artifacts.push(...output.artifacts);
            details.push(...output.details);
            if (performer) {
              sessionPerformer = performer;
              if (isLastIteration) {
                cyclePerformers.push(performer);
                if (performer.containerId) {
                  cyclePerformerStates.push({
                    globalRunIndex: globalIterationIndex,
                    containerId: performer.containerId,
                    port: iteration.performerPort,
                    sdk: iteration.sdk.value,
                    ...(iteration.performerVersion ? { version: iteration.performerVersion } : {}),
                  });
                }
              }
            }
          } catch (err) {
            // FatalToRun and FatalToSession both abandon just this run and let the
            // next run in the group proceed; they differ only in scope/severity.
            if (
              err instanceof ClassifiedFailure &&
              (err.classification === "FatalToRun" || err.classification === "FatalToSession")
            ) {
              const nextStep = isLastIteration
                ? "no more runs in this execution group"
                : "moving to the next run";
              fitCliError({ classification: err.classification }, `\n✗ ${err.message} (${nextStep})`);
              tracker.record(err.classification, err.message, failureContextFromPath(iteration.path, failureLabel(activeCycle, iteration)));
            } else {
              throw err;
            }
          }
          globalIterationIndex++;
        }
      } catch (err) {
        if (err instanceof ClassifiedFailure && err.classification === "FatalToCluster") {
          fitCliError({ classification: "FatalToCluster" }, `\n✗ ${err.message}`);
          tracker.record("FatalToCluster", err.message, failureContextFromPath(group.path, failureLabel(activeCycle)));
          globalIterationIndex += countGroupIterations(activeCycle);

          // Promote this cycle as the active set so that stopping here lets
          // teardownRun offer to leave its instance/cluster/performers up.
          activeClusterState = clusterState;
          activePerformers = cyclePerformers;
          activePerformerStates = cyclePerformerStates;

          const isLastCycle = cycleIndex === executionGroups.length - 1;
          if (isLastCycle) {
            break;
          }

          // Does the next group share this box (same definition instance)? If so we
          // keep the box up and clean only this group's cluster/performers.
          const nextGroupSharesBox =
            executionGroups[cycleIndex + 1]?.path.instanceIndex === group.path.instanceIndex;
          // Don't prompt here even in --interactive mode: prompts mid-run interrupt
          // an otherwise hands-off run every time a cluster fails (e.g. broken shared
          // infra), and the only prompt a user wants mid-run is the final leave-up
          // decision. Always continue, matching the old default answer.
          console.log(
            `\n→ Continuing to the next execution group (${nextGroupSharesBox ? "this group's cluster and performers are cleaned up first; the shared instance is kept" : "this instance and its resources are cleaned up first"}).`,
          );

          if (nextGroupSharesBox) {
            // The next group reuses this box: clean just this group's cluster and
            // performers, leaving the instance up for it.
            await disposeGroupClusterAndPerformers(execution, clusterState, cyclePerformers, cbcollect);
            activeClusterState = undefined;
            activePerformers = [];
            activePerformerStates = [];
          } else {
            // The next group stands up its own box: tear this whole box down.
            await disposeCycleResources(execution, cycleTeardown, clusterState, cyclePerformers, cbcollect);
            activeExecution = undefined;
            activeTeardown = { kind: "local" };
            currentBoxInstanceIndex = undefined;
            activeClusterState = undefined;
            activePerformers = [];
            activePerformerStates = [];
          }
          clearLogContext();
          continue;
        }
        throw err;
      }

      const isLastCycle = cycleIndex === executionGroups.length - 1;
      // The last group sharing this box (the next group, if any, runs on a fresh box).
      const isLastGroupOnBox =
        isLastCycle ||
        executionGroups[cycleIndex + 1]?.path.instanceIndex !== group.path.instanceIndex;
      if (isLastCycle) {
        // Leave the box and this last group's cluster/performers as the active set so
        // the outer teardown can offer to leave everything up for debugging.
        activeClusterState = clusterState;
        activePerformers = cyclePerformers;
        activePerformerStates = cyclePerformerStates;
      } else if (isLastGroupOnBox) {
        // Last group on this box, but more groups follow on a fresh box: tear the
        // whole box down — its cluster, performers and the instance itself.
        await disposeCycleResources(execution, cycleTeardown, clusterState, cyclePerformers, cbcollect);
        activeExecution = undefined;
        activeTeardown = { kind: "local" };
        currentBoxInstanceIndex = undefined;
        activeClusterState = undefined;
        activePerformers = [];
        activePerformerStates = [];
      } else {
        // More groups share this box: clean up just this group's cluster and
        // performers, keeping the box up for the next group.
        await disposeGroupClusterAndPerformers(execution, clusterState, cyclePerformers, cbcollect);
        activeClusterState = undefined;
        activePerformers = [];
        activePerformerStates = [];
      }
    }
    } catch (err) {
      if (err instanceof ClassifiedFailure && err.classification === "FatalToAll") {
        fitCliError({ classification: "FatalToAll" }, `\n✗ ${err.message} (aborting run)`);
        tracker.record("FatalToAll", err.message, activeResumePath ? failureContextFromPath(activeResumePath) : { instanceIndex: 0 });
      } else {
        throw err;
      }
    }

  } finally {
    // Stop before teardown: teardown does its own AWS work through the refreshing provider,
    // and a tick firing mid-teardown would only add noise.
    await stopCredsRefresher();
    if (credsRefreshFailures > 0) {
      // Surface this loudly. A stale-credentials run fails much later and much less
      // legibly — as `RequestExpired` inside cbdinocluster, typically in
      // `private-endpoints setup-link` — so without this the real cause is easy to miss.
      // Counts every failure over the run, so a later attempt may well have succeeded — hence
      // "during this run" rather than a claim about the credentials' state right now.
      const message =
        `${credsRefreshFailures} attempt(s) to refresh AWS credentials on the test instance ` +
        `failed during this run. Any 'RequestExpired' errors from cbdinocluster are caused by ` +
        `this, not by the SDK under test. ` +
        `Most recent failure: ${credsRefreshLastError ?? "unknown"}`;
      details.push({ label: "AWS credential refresh", value: message, callToAction: true });
      tracker.record("NonFatal", message, activeResumePath ? failureContextFromPath(activeResumePath) : { instanceIndex: 0 });
    }
    const { leftUp } = await teardownRun({
      definitionPath,
      runDir,
      executionGroupIndex: activeCycleIndex,
      runIndex: activeIterationIndex,
      ...(activeResumePath ? { resumePath: activeResumePath } : {}),
      ...(activeExecution ? { execution: activeExecution } : {}),
      teardown: activeTeardown,
      forceLocalhost,
      forceAws,
      ...(activeClusterState ? { clusterState: activeClusterState } : {}),
      performers: activePerformers,
      performerStates: activePerformerStates,
      results: runResults,
      cbcollect,
      ...(promptScope ? { promptScope } : {}),
    });
    if (leftUp) {
      details.push(...instanceDetails);
    }
    // Best-effort: ship the run's artifacts to S3 after teardown (so anything
    // teardown writes is included). Runs only inside GitHub Actions; never throws.
    await maybeUploadRunArtifacts(runDir);
  }
  return finalizeRunFromDefinition(artifacts, details, runDir, tracker.worst, tracker.failureCount);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { resumeAt, positionals: resumeRest } = extractResumeAt(process.argv.slice(2));
    const { selector: resumeSelector, positionals: resumeRest2 } = extractResumeSelector(resumeRest);
    const { cbcollect, positionals: rest } = extractCbcollectFlag(resumeRest2);
    const [definitionPath, ...extra] = rest;
    if (!definitionPath || extra.length > 0) {
      console.error(
        `Primary usage: ${runScriptPrefix("run")} definition <file.yaml> [--resume-at=<point>] [--resume-instance=<n>] [--resume-cluster=<n>] [--resume-session=<n>] [--resume-clusterless-session=<n>] [--resume-run=<n>] [--cbcollect]\n` +
          "Direct:        tsx src/fit/functional/run-from-definition/run-from-definition.ts <file.yaml> [--resume-at=<point>] [resume selectors]\n" +
          "  --resume-at: after-instance-creation | after-remote-preparation | after-cluster-creation | after-performer",
      );
      process.exit(2);
    }
    let resumePoint: ResumePoint | undefined;
    try {
      resumePoint = parseResumePoint(resumeAt);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(2);
    }
    return runFromDefinition(definitionPath, {
      ...(resumePoint ? { resumeAt: resumePoint } : {}),
      ...(hasResumeSelector(resumeSelector) ? { resumeSelector } : {}),
      ...(cbcollect ? { cbcollect } : {}),
    });
  });
}
