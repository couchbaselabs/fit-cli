/**
 * Build a reusable `fit` definition file interactively.
 *
 * Run on its own (skipping the top-level menu):
 *   bun src/fit/shared/create-definition/create-definition.ts
 */
import { type RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { printFileContent } from "../../../util/non-fit/fit-cli-log.js";
import { qualifyPromptId, select, confirm, input } from "../../../util/non-fit/prompts.js";
import { resolveOutputFormat } from "../../util/config.js";
import { chooseAnalyticsFunctionalSdk, chooseSdk } from "../../../util/sdk/choose-sdk.js";
import type { Sdk } from "../../../util/sdk/sdks.js";
import { askClusterDef } from "../../../cluster/cluster-create/ask-cluster-def.js";
import { CAPELLA_CLOUD_PROVIDERS, type CapellaCloudProvider } from "../../../cluster/cluster-create/build-cluster-def.js";
import { askClusterExistsPolicy } from "../../../cluster/cluster-create/ask-cluster-exists-policy.js";
import { selectCluster } from "../../../cluster/cluster-select/cluster-select.js";
import { askPerformerTag } from "../../performers/util/ask-performer-image.js";
import { askPortInUsePolicy } from "../../performers/util/ask-port-in-use-policy.js";
import { printDefinitionRunGuidance } from "../definition/run-guidance.js";
import { extractPushGistVisibility, pushGist, type GistVisibility } from "../definition/push-gist.js";
import { chooseResultsTarget } from "../../situational/choose-results-database/choose-results-database.js";
import {
  capellaEndpointOrigin,
  deriveCapellaSandboxEndpoints,
  isCapellaEndpointOrigin,
  isCapellaOrganizationId,
  isSandboxCapellaEnvironment,
  loadEnvironments,
  type CapellaEnvironmentOverride,
} from "../../util/environments.js";
import { CAPELLA_SANDBOX_ENV_VAR_GUIDANCE, DEFAULT_CAPELLA_ENV } from "../../util/config.js";
import {
  buildFitDefinition,
  buildFitFunctionalDefinitionFrom,
  buildFitSituationalDefinitionFrom,
  type DefinitionCluster,
  type DefinitionFormat,
  formatFitDefinition,
  formatFitSituationalDefinition,
  writeFitDefinition,
  writeFitSituationalDefinition,
} from "../definition/generate-definition.js";
import type {
  ClusterConfigRef,
  ClusterLifetime,
  FitConfigRef,
  FitDefinition,
  FitRun,
  InstanceLifetime,
  InstanceMode,
  SessionLifetime,
} from "../definition/types.js";
import {
  FUNCTIONAL_TEST_DOMAIN,
  SITUATIONAL_TEST_DOMAIN,
  selectFitTests,
  type FitTestSelection,
} from "../select-fit-tests/select-fit-tests.js";
import { createLocalFitExecutionContext } from "../util/remote-fit-run.js";

async function chooseDefinitionCluster(): Promise<DefinitionCluster> {
  const selection = await selectCluster();
  if (selection.mode === "existing") {
    return { kind: "connection", cluster: selection.cluster };
  }
  const def = await askClusterDef();
  return { kind: "cbdinocluster", def };
}

export async function askFitGerritRef(promptIdPrefix?: string): Promise<string | undefined> {
  const shouldUseGerritRef = await confirm({
    promptId: qualifyPromptId("fit.definition.performer.gerrit-ref.enabled", promptIdPrefix),
    message: "Do you want to fetch and checkout a specific transactions-fit-performer Gerrit ref before execution?",
    default: false,
  });
  if (!shouldUseGerritRef) {
    return undefined;
  }

  const gerritRef = await input({
    promptId: qualifyPromptId("fit.definition.performer.gerrit-ref.value", promptIdPrefix),
    message: "Which transactions-fit-performer Gerrit ref should fit-cli fetch and checkout (e.g. refs/changes/29/246329/1)?",
    validate: (value) => value.trim() ? true : "Enter a Gerrit ref like refs/changes/29/246329/1.",
  });
  return gerritRef.trim();
}

type DefinitionBuilderAction = "functional" | "situational" | "performance" | "done";
type FunctionalConnectivity = "operational" | "cng" | "enterprise-analytics" | "capella" | "capella-analytics";

interface DefinitionBuilderState {
  gerritRefAsked: boolean;
  gerritRef?: string;
  instances: InstanceLifetime[];
  clusterConfigs: ClusterConfigRef[];
  fitConfigs: FitConfigRef[];
  /** Sandbox Capella environments selected so far, and the coordinates asked for once each. */
  capellaEnvironments: Record<string, CapellaEnvironmentOverride>;
}

async function chooseDefinitionBuilderAction(index: number): Promise<DefinitionBuilderAction> {
  return select<DefinitionBuilderAction>({
    promptId: qualifyPromptId(`fit.definition.builder.action.${index}`),
    message: "What would you like to add to this FIT definition file?",
    choices: [
      { name: "Add FIT functional testing", value: "functional" },
      { name: "Add FIT situational testing", value: "situational" },
      { name: "I'm done with the FIT definition building", value: "done" },
    ],
    default: index > 1 ? "done" : undefined,
  });
}

async function chooseFunctionalConnectivity(promptIdPrefix: string): Promise<FunctionalConnectivity> {
  return select<FunctionalConnectivity>({
    promptId: qualifyPromptId("connectivity", promptIdPrefix),
    message: "What cluster do you want to run FIT functional testing against?",
    choices: [
      { name: "On-prem operational", value: "operational" },
      { name: "Capella operational", value: "capella" },
      { name: "Cloud Native Gateway (couchbase2://, running on ROSA OpenShift)", value: "cng" },
      { name: "Enterprise Analytics (self-hosted, requires Enterprise Analytics SDKs)", value: "enterprise-analytics" },
      { name: "Capella Analytics (cloud, previously called Columnar, requires Columnar SDKs)", value: "capella-analytics" },
    ],
  });
}

async function chooseCapellaCloudProvider(promptIdPrefix: string): Promise<CapellaCloudProvider> {
  return select<CapellaCloudProvider>({
    promptId: qualifyPromptId("capella.cloud-provider", promptIdPrefix),
    message: "Which cloud provider should Capella deploy the cluster on?",
    choices: CAPELLA_CLOUD_PROVIDERS.map((p) => ({ name: p.toUpperCase(), value: p })),
  });
}

export function functionalInstanceConnectivity(
  instance: InstanceLifetime,
  clusterConfigs: ClusterConfigRef[] = [],
): FunctionalConnectivity {
  const cluster = instance.clusters[0];
  // The cluster's cbdino setup may be inline or referenced via clusterConfig id.
  const cbdinocluster =
    cluster?.cbdinocluster ??
    (typeof cluster?.clusterConfig === "string"
      ? clusterConfigs.find((cc) => cc.id === cluster.clusterConfig)?.cbdinocluster
      : undefined);
  if (cbdinocluster?.capella !== undefined) return "capella";
  if (cbdinocluster?.config.columnar === true) {
    return cbdinocluster.config.deployer === "cloud" ? "capella-analytics" : "enterprise-analytics";
  }
  if (cbdinocluster?.config.cao !== undefined) return "cng";
  return "operational";
}

async function chooseFunctionalDefinitionCluster(connectivity: FunctionalConnectivity, capellaCloudProvider?: CapellaCloudProvider): Promise<DefinitionCluster> {
  if (connectivity === "cng") {
    return { kind: "cbdinocluster", def: await askClusterDef({ cng: true }) };
  }
  if (connectivity === "enterprise-analytics") {
    return { kind: "cbdinocluster", def: await askClusterDef({ enterpriseAnalytics: true }) };
  }
  if (connectivity === "capella") {
    return { kind: "cbdinocluster", def: await askClusterDef({ capellaCloudProvider }) };
  }
  if (connectivity === "capella-analytics") {
    return { kind: "cbdinocluster", def: await askClusterDef({ capellaAnalytics: true }) };
  }
  return chooseDefinitionCluster();
}

async function chooseInstanceExecution(promptIdPrefix: string): Promise<InstanceMode> {
  const choice = await select<"localhost" | "aws" | "gcp">({
    promptId: qualifyPromptId("execution.instance", promptIdPrefix),
    message: "Where should this instance's tests execute? (You can override this at runtime and run it on localhost)",
    choices: [
      { name: "A clean AWS EC2 instance", value: "aws" },
      { name: "A clean GCP Compute Engine instance", value: "gcp" },
      { name: "This machine (localhost)", value: "localhost" },
    ],
  });
  if (choice === "aws") return { aws: {} };
  if (choice === "gcp") return { gcp: {} };
  return { localhost: {} };
}

/**
 * Ask whether to set up a private endpoint connection (AWS PrivateLink or GCP
 * PSC) to this Capella cluster. Only offered for AWS/GCP-provisioned clusters
 * (the providers fit-cli supports PE for today). PE requires a matching-CSP
 * instance in fit-cli's VPC/network, so answering yes here means the
 * instance-execution question is skipped in favour of a fixed instance on
 * `cloudProvider` with privateEndpoint set.
 */
async function askCapellaPrivateEndpoint(promptIdPrefix: string, cloudProvider: "aws" | "gcp" = "aws"): Promise<boolean> {
  return confirm({
    promptId: qualifyPromptId("capella.private-endpoint", promptIdPrefix),
    message: `Set up an ${cloudProvider === "aws" ? "AWS PrivateLink" : "GCP PSC"} connection to Capella?`,
    default: false,
  });
}

async function ensureSharedRepoSetup(state: DefinitionBuilderState): Promise<void> {
  if (state.gerritRefAsked) {
    return;
  }
  state.gerritRef = await askFitGerritRef("fit.definition.shared");
  state.gerritRefAsked = true;
}

function lastFunctionalInstance(state: DefinitionBuilderState): InstanceLifetime | undefined {
  const last = state.instances.at(-1);
  return last && last.clusters.length > 0 ? last : undefined;
}

function lastSituationalInstance(state: DefinitionBuilderState): InstanceLifetime | undefined {
  const last = state.instances.at(-1);
  return last?.clusterlessSessions && last.clusterlessSessions.length > 0 ? last : undefined;
}

function runCount(state: DefinitionBuilderState): number {
  return state.instances.reduce(
    (total, instance) =>
      total +
      instance.clusters.reduce(
        (clusterTotal, cluster) => clusterTotal + cluster.sessions.reduce((sessionTotal, session) => sessionTotal + session.runs.length, 0),
        0,
      ) +
      (instance.clusterlessSessions?.reduce((sessionTotal, session) => sessionTotal + session.runs.length, 0) ?? 0),
    0,
  );
}

function remapClusterRefs(cluster: ClusterLifetime, clusterMap: Map<string, string>): ClusterLifetime {
  if (typeof cluster.clusterConfig === "string") {
    const newId = clusterMap.get(cluster.clusterConfig);
    if (newId !== undefined) return { ...cluster, clusterConfig: newId };
  }
  return cluster;
}

/**
 * Collect a sub-definition's fitConfigs into state with unique IDs and return a
 * map from the sub-definition's (constant) IDs to the assigned ones. Like cluster
 * configs, sub-definitions always emit the same constant id ("fit-config-0"), so
 * each gets offset by the current count in state to avoid collisions.
 */
function collectSubDefFitConfigs(state: DefinitionBuilderState, subDef: FitDefinition): Map<string, string> {
  const fitConfigMap = new Map<string, string>();
  for (const fc of subDef.fitConfigs ?? []) {
    const newId = `fit-config-${state.fitConfigs.length}`;
    fitConfigMap.set(fc.id, newId);
    state.fitConfigs.push({ ...fc, id: newId });
  }
  return fitConfigMap;
}

/** Rewrite a run's string fitConfig reference to its collected (offset) id. */
function remapRunFitConfig(run: FitRun, fitConfigMap: Map<string, string>): FitRun {
  if (typeof run.fitConfig === "string") {
    const newId = fitConfigMap.get(run.fitConfig);
    if (newId !== undefined) return { ...run, fitConfig: newId };
  }
  return run;
}

/** Rewrite every fitConfig reference in a session's runs to the collected ids. */
function remapSessionFitConfigRefs(session: SessionLifetime, fitConfigMap: Map<string, string>): SessionLifetime {
  if (fitConfigMap.size === 0) return session;
  return { ...session, runs: session.runs.map((run) => remapRunFitConfig(run, fitConfigMap)) };
}

/**
 * Collect a sub-definition's cluster configs and fitConfigs into state with unique
 * IDs and return the remapped instance. Sub-definitions from buildFit*DefinitionFrom
 * always use the same constant IDs ("cluster-0"/"fit-config-0"), so each new instance
 * gets its IDs offset by the current count in state to avoid collisions.
 */
function collectSubDefInstance(state: DefinitionBuilderState, subDef: FitDefinition): InstanceLifetime {
  const clusterMap = new Map<string, string>();
  for (const cc of subDef.clusterConfigs ?? []) {
    const newId = `cluster-${state.clusterConfigs.length}`;
    clusterMap.set(cc.id, newId);
    state.clusterConfigs.push({ ...cc, id: newId });
  }
  const fitConfigMap = collectSubDefFitConfigs(state, subDef);
  const instance = subDef.instances[0];
  if (!instance) {
    throw new Error("Expected sub-definition to contain one instance.");
  }
  return {
    ...instance,
    clusters: instance.clusters.map((c) => {
      const remapped = remapClusterRefs(c, clusterMap);
      return { ...remapped, sessions: remapped.sessions.map((s) => remapSessionFitConfigRefs(s, fitConfigMap)) };
    }),
  };
}

/** Extract the first session from a sub-definition's cluster. */
function collectSubDefSession(subDef: FitDefinition): SessionLifetime {
  const session = subDef.instances[0]?.clusters[0]?.sessions[0];
  if (!session) {
    throw new Error("Expected sub-definition to contain one session.");
  }
  return session;
}

/** Extract the first clusterless session from a sub-definition. */
function collectSubDefClusterlessSession(subDef: FitDefinition): SessionLifetime {
  const session = subDef.instances[0]?.clusterlessSessions?.[0];
  if (!session) {
    throw new Error("Expected sub-definition to contain one clusterless session.");
  }
  return session;
}

async function addFunctionalRun(
  state: DefinitionBuilderState,
  runIndex: number,
): Promise<void> {
  await ensureSharedRepoSetup(state);
  const promptIdPrefix = `fit.definition.run.${runIndex + 1}.functional`;
  const execution = createLocalFitExecutionContext();
  const connectivity = await chooseFunctionalConnectivity(promptIdPrefix);
  const analytics = connectivity === "enterprise-analytics" || connectivity === "capella-analytics";

  // Every SDK selected here runs the same set of tests (chosen once below), so
  // collect all the SDKs first before asking which tests to run.
  const sdks: { sdk: Sdk; version: string }[] = [];
  do {
    const sdkPromptIdPrefix = qualifyPromptId(`sdk${sdks.length}`, promptIdPrefix);
    const sdk = analytics
      ? await chooseAnalyticsFunctionalSdk("Which Analytics SDK do you want to test?", sdkPromptIdPrefix,
          connectivity === "capella-analytics" ? "columnar-java" : undefined)
      : await chooseSdk("Which SDK do you want to test with FIT functional?", sdkPromptIdPrefix);
    const version = await askPerformerTag(sdk, sdkPromptIdPrefix);
    sdks.push({ sdk, version });
  } while (
    await confirm({
      promptId: qualifyPromptId(`sdk.another.${sdks.length}`, promptIdPrefix),
      message: "Add another SDK to test?",
      default: false,
    })
  );

  const onPortInUse = await askPortInUsePolicy(promptIdPrefix);
  // The Analytics tests run via the columnar-test-driver, whose test list we can't
  // enumerate through the operational test domain, so default to running them all.
  const selection = analytics
    ? ({ allTests: [], selectedTests: [] } satisfies FitTestSelection)
    : await selectFitTests(execution, FUNCTIONAL_TEST_DOMAIN, promptIdPrefix);

  for (const { sdk, version } of sdks) {
    const currentInstance = lastFunctionalInstance(state);
    if (currentInstance && functionalInstanceConnectivity(currentInstance, state.clusterConfigs) === connectivity) {
      const subDef = buildFitFunctionalDefinitionFrom({
        cluster: functionalDefinitionCluster(currentInstance, state.clusterConfigs),
        sdk,
        ...(version ? { version } : {}),
        onPortInUse,
        selection,
        ...(analytics ? { analytics: true } : {}),
      });
      const fitConfigMap = collectSubDefFitConfigs(state, subDef);
      currentInstance.clusters[0]?.sessions.push(remapSessionFitConfigRefs(collectSubDefSession(subDef), fitConfigMap));
      continue;
    }

    // Capella provider and environment are only needed when starting a new instance.
    let capellaCloudProvider: CapellaCloudProvider | undefined;
    let capellaEnvironment: string | undefined;
    let capellaPrivateEndpoint = false;
    if (connectivity === "capella") {
      capellaCloudProvider = await chooseCapellaCloudProvider(promptIdPrefix);
      capellaEnvironment = await chooseCapellaEnvironment(state, promptIdPrefix);
      if (capellaCloudProvider === "aws" || capellaCloudProvider === "gcp") {
        capellaPrivateEndpoint = await askCapellaPrivateEndpoint(promptIdPrefix, capellaCloudProvider);
      }
    } else if (connectivity === "capella-analytics") {
      // Capella Analytics also picks a Capella environment (incl. a sandbox); recorded at instance level.
      capellaEnvironment = await chooseCapellaEnvironment(state, promptIdPrefix);
    }

    console.log(
      connectivity === "cng"
        ? "\nStarting a new FIT functional CNG instance. cbdinocluster installs the gateway via the Couchbase Kubernetes Operator, so this needs Kubernetes."
        : connectivity === "enterprise-analytics"
          ? "\nStarting a new FIT Analytics instance. cbdinocluster builds a self-managed Enterprise Analytics cluster (fronted by an nginx load balancer)."
          : connectivity === "capella"
            ? `\nStarting a new FIT Capella instance. cbdinocluster creates a real Capella cluster on ${capellaCloudProvider!.toUpperCase()} via the Capella control-plane API.`
          : connectivity === "capella-analytics"
            ? "\nStarting a new FIT Capella Analytics instance. cbdinocluster creates a real Capella Analytics cluster via the Capella control-plane API (cloud deployer)."
            : "\nStarting a new FIT functional instance. Runs added now will share one cluster lifetime on that instance.",
    );
    // PE testing requires an instance on the same CSP as the Capella cluster —
    // skip the usual localhost/AWS/GCP choice and fix the instance accordingly.
    const instance = capellaPrivateEndpoint
      ? capellaCloudProvider === "gcp"
        ? { gcp: { privateEndpoint: {} } }
        : { aws: { privateEndpoint: {} } }
      : await chooseInstanceExecution(promptIdPrefix);
    const cluster = await chooseFunctionalDefinitionCluster(connectivity, capellaCloudProvider);
    const onClusterExists = cluster.kind === "cbdinocluster" ? await askClusterExistsPolicy() : undefined;
    const subDef = buildFitFunctionalDefinitionFrom({
      cluster,
      instance,
      ...(onClusterExists ? { onClusterExists } : {}),
      sdk,
      ...(version ? { version } : {}),
      onPortInUse,
      selection,
      ...(analytics ? { analytics: true } : {}),
      ...(capellaEnvironment ? { capellaEnvironment } : {}),
      ...(capellaPrivateEndpoint ? { capellaPrivateEndpoint } : {}),
    });
    const generatedInstance = collectSubDefInstance(state, subDef);
    if (!generatedInstance) {
      throw new Error("Expected a generated functional definition to contain one instance.");
    }
    state.instances.push(generatedInstance);
  }
}

function functionalDefinitionCluster(instance: InstanceLifetime, clusterConfigs: ClusterConfigRef[]): DefinitionCluster {
  const cluster = instance.clusters[0];
  if (!cluster) {
    throw new Error("Expected a functional instance to contain one cluster.");
  }
  // Resolve a string clusterConfig ref to its stored config
  const clusterData = typeof cluster.clusterConfig === "string"
    ? clusterConfigs.find((cc) => cc.id === cluster.clusterConfig) ?? cluster
    : cluster;
  if (clusterData.cbdinocluster) {
    const firstNode = clusterData.cbdinocluster.config.nodes[0];
    if (!firstNode) {
      throw new Error("Functional cbdinocluster config must contain at least one node.");
    }
    return {
      kind: "cbdinocluster",
      def: {
        nodeCount: firstNode.count,
        version: firstNode.version ?? "",
        services: firstNode.services ?? [],
        cng: clusterData.cbdinocluster.config.cao !== undefined,
        // cbdino's wire `columnar: true` + `deployer: cloud` = Capella Analytics; without = Enterprise Analytics.
        ...(clusterData.cbdinocluster.config.columnar === true
          ? clusterData.cbdinocluster.config.deployer === "cloud"
            ? { capellaAnalytics: true, cloudProvider: (clusterData.cbdinocluster.config.cloud?.["cloud-provider"] ?? "aws") as "aws" | "gcp" }
            : { enterpriseAnalytics: true }
          : {}),
        ...(clusterData.cbdinocluster.capella ? { capellaCloudProvider: clusterData.cbdinocluster.capella.cloudProvider } : {}),
      },
    };
  }
  if (!clusterData.connection) {
    throw new Error("Functional instance connection clusters must include connection details.");
  }
  return {
    kind: "connection",
    cluster: {
      scheme: clusterData.connection.connectionString.startsWith("couchbases://") ? "couchbases" : "couchbase",
      defaultHostname: clusterData.connection.connectionString.replace(/^couchbases?:\/\//, ""),
      flavour: "self-managed",
      credentials: {
        username: clusterData.connection.username,
        password: clusterData.connection.password,
      },
      tls: clusterData.connection.tls ?? null,
    },
  };
}

/** Prompt for one sandbox endpoint, accepting a scheme+host origin only (what the definition file needs). */
async function askCapellaEndpointOrigin(
  promptId: string,
  message: string,
  fallback: string,
  example: string,
): Promise<string> {
  return (await input({
    promptId,
    message,
    default: fallback,
    validate: (value) => isCapellaEndpointOrigin(value) ? true : `Enter a scheme and host only, like ${example}`,
  })).trim();
}

/**
 * Collect a sandbox's control plane for the definition file. Its credentials deliberately
 * don't go there, so this is also where the user is told which env vars to set.
 */
async function askCapellaSandboxEnvironment(
  environment: string,
  promptIdPrefix: string,
): Promise<CapellaEnvironmentOverride> {
  console.log(
    `\n"${environment}" is a pre-deployed sandbox, so fit-cli needs its control plane spelled out.\n` +
      `  The URL and org id below are written into the definition file, so it stays reproducible.\n` +
      `  Its accounts are recreated with the sandbox, so those are NOT stored — set them when you run:\n` +
      `    ${CAPELLA_SANDBOX_ENV_VAR_GUIDANCE}`,
  );
  const url = (await input({
    promptId: qualifyPromptId("capella.sandbox.endpoint", promptIdPrefix),
    message: `Capella URL for "${environment}" — the UI URL from your browser is fine (e.g. https://ui.sbx-25.sandbox.nonprod-project-avengers.com):`,
    validate: (value) => /^https?:\/\/\S+$/i.test(value.trim()) ? true : "Enter a URL like https://ui.sbx-25.sandbox.nonprod-project-avengers.com",
  })).trim();
  const derived = deriveCapellaSandboxEndpoints(url);
  let { endpoint, v4Endpoint } = derived;
  if (derived.recognised) {
    console.log(`  v2 control plane: ${endpoint}\n  v4 Management API: ${v4Endpoint}`);
  } else {
    console.log(`  ${url} isn't a ui./api./cloudapi. host, so fit-cli can't work out the two endpoints from it.`);
    // These two go straight into the definition file, where only an origin parses — so unlike the
    // URL above (which may carry a browser path) they are validated, and defaulted, as origins.
    endpoint = await askCapellaEndpointOrigin(
      qualifyPromptId("capella.sandbox.v2-endpoint", promptIdPrefix),
      `Capella (v2) control-plane URL for "${environment}" (scheme and host only):`,
      capellaEndpointOrigin(endpoint),
      "https://api.sbx-25.sandbox.nonprod-project-avengers.com",
    );
    // Default off the endpoint just entered, not the original paste, so a correction there carries.
    const v4Default = deriveCapellaSandboxEndpoints(endpoint);
    v4Endpoint = await askCapellaEndpointOrigin(
      qualifyPromptId("capella.sandbox.v4-endpoint", promptIdPrefix),
      `Capella Management API v4 URL for "${environment}" (scheme and host only):`,
      v4Default.recognised ? v4Default.v4Endpoint : capellaEndpointOrigin(endpoint),
      "https://cloudapi.sbx-25.sandbox.nonprod-project-avengers.com",
    );
    if (endpoint === v4Endpoint) {
      console.log(`  Note: both endpoints are ${endpoint}. If the v4 API is served elsewhere, fix it in the definition file.`);
    }
  }
  const oid = (await input({
    promptId: qualifyPromptId("capella.sandbox.oid", promptIdPrefix),
    message: `Capella organization id (oid) for "${environment}":`,
    validate: (value) => isCapellaOrganizationId(value)
      ? true
      : "Enter just the id from the Capella UI URL's oid= parameter, without the \"oid=\" prefix (e.g. 4c1d8e6a-0b2f-4a1e-9f3c-5d6e7a8b9c01).",
  })).trim();
  return { endpoint, v4Endpoint, oid };
}

/**
 * Prompt for which Capella environment to deploy clusters in, sourced from environments.json5.
 * A sandbox also has its control plane collected — once, however many runs select it.
 */
async function chooseCapellaEnvironment(state: DefinitionBuilderState, promptIdPrefix: string): Promise<string> {
  const capella = loadEnvironments().capella;
  const names = Object.keys(capella);
  if (names.length === 0) return DEFAULT_CAPELLA_ENV;
  // Always prompt (even with a single environment) so the choice is explicit and confirmed.
  const environment = await select<string>({
    promptId: qualifyPromptId("situational.capella.environment", promptIdPrefix),
    message: "Which Capella environment should clusters be created in?",
    default: names.includes(DEFAULT_CAPELLA_ENV) ? DEFAULT_CAPELLA_ENV : names[0],
    choices: names.map((name) => ({
      name: `${name} — ${capella[name].endpoint ?? (capella[name].sandbox ? "(pre-deployed sandbox; you provide the URL and org id)" : "(endpoint not set)")}`,
      value: name,
    })),
  });
  if (isSandboxCapellaEnvironment(environment) && state.capellaEnvironments[environment] === undefined) {
    state.capellaEnvironments[environment] = await askCapellaSandboxEnvironment(environment, promptIdPrefix);
  }
  return environment;
}

async function addSituationalRun(
  state: DefinitionBuilderState,
  runIndex: number,
): Promise<void> {
  await ensureSharedRepoSetup(state);
  const promptIdPrefix = `fit.definition.run.${runIndex + 1}.situational`;
  const execution = createLocalFitExecutionContext();
  const sdk = await chooseSdk("Which SDK do you want to test with FIT situational?", promptIdPrefix);
  const version = await askPerformerTag(sdk, promptIdPrefix);
  const onPortInUse = await askPortInUsePolicy(promptIdPrefix);
  // One prompt for where results go (hosted env, with its host, or local); then the Capella env.
  const { mode: databaseMode, resultsEnvironment } = await chooseResultsTarget(promptIdPrefix);
  const capellaEnvironment = await chooseCapellaEnvironment(state, promptIdPrefix);
  const selection = await selectFitTests(execution, SITUATIONAL_TEST_DOMAIN, promptIdPrefix);

  // A situational instance is one box configured for one Capella env (cbdinocluster init is per-box),
  // so only reuse it when the chosen env matches; a different env (e.g. a sandbox) needs its own instance
  // rather than being silently run against the existing one's env.
  const currentInstance = lastSituationalInstance(state);
  if (
    currentInstance?.clusterlessSessions &&
    (currentInstance.setup?.capellaEnvironment ?? DEFAULT_CAPELLA_ENV) === capellaEnvironment
  ) {
    // The instance's execution mode (and its aws/gcp.privateEndpoint, if any) was
    // fixed when it was created, so reuse whatever PE-ness that instance already has.
    const privateEndpoint =
      ("aws" in currentInstance && currentInstance.aws.privateEndpoint !== undefined) ||
      ("gcp" in currentInstance && currentInstance.gcp.privateEndpoint !== undefined);
    const subDef = buildFitSituationalDefinitionFrom({
      sdk,
      ...(version ? { version } : {}),
      onPortInUse,
      databaseMode,
      ...(resultsEnvironment ? { resultsEnvironment } : {}),
      capellaEnvironment,
      selection,
      ...(privateEndpoint ? { privateEndpoint } : {}),
    });
    currentInstance.clusterlessSessions.push(collectSubDefClusterlessSession(subDef));
    return;
  }

  const wantsPrivateEndpoint = await confirm({
    promptId: qualifyPromptId("capella.private-endpoint", promptIdPrefix),
    message: "Set up a private endpoint connection to Capella (AWS PrivateLink or GCP PSC)?",
    default: false,
  });
  let privateEndpointCloudProvider: "aws" | "gcp" = "aws";
  if (wantsPrivateEndpoint) {
    privateEndpointCloudProvider = await select<"aws" | "gcp">({
      promptId: qualifyPromptId("capella.private-endpoint.cloud-provider", promptIdPrefix),
      message: "Which cloud provider should the private-endpoint instance run on?",
      choices: [{ name: "AWS", value: "aws" }, { name: "GCP", value: "gcp" }],
    });
  }
  const privateEndpoint = wantsPrivateEndpoint;

  console.log("\nStarting a new FIT situational instance. FIT/SIT creates its own clusters.");
  // PE testing requires an instance on the same CSP as the Capella cluster —
  // skip the usual localhost/AWS/GCP choice and fix the instance accordingly.
  const instance = privateEndpoint
    ? privateEndpointCloudProvider === "gcp"
      ? { gcp: { privateEndpoint: {} } }
      : { aws: { privateEndpoint: {} } }
    : await chooseInstanceExecution(promptIdPrefix);
  const subDef = buildFitSituationalDefinitionFrom({
    sdk,
    instance,
    ...(version ? { version } : {}),
    onPortInUse,
    databaseMode,
    ...(resultsEnvironment ? { resultsEnvironment } : {}),
    capellaEnvironment,
    selection,
    ...(privateEndpoint ? { privateEndpoint } : {}),
  });
  const generatedInstance = collectSubDefInstance(state, subDef);
  if (!generatedInstance) {
    throw new Error("Expected a generated situational definition to contain one instance.");
  }
  state.instances.push(generatedInstance);
}

export async function createFitDefinition(options?: { format?: DefinitionFormat; pushGistVisibility?: GistVisibility }): Promise<RunOutput> {
  console.log(
    "\nThis builds a reusable fit definition file. Nothing is set up — no cluster is allocated, no performer built, no tests run.\n",
  );

  const state: DefinitionBuilderState = { gerritRefAsked: false, instances: [], clusterConfigs: [], fitConfigs: [], capellaEnvironments: {} };
  let actionIndex = 1;

  while (true) {
    const action = await chooseDefinitionBuilderAction(actionIndex++);
    if (action === "done") {
      break;
    }
    if (action === "performance") {
      console.log("\nFIT performance definition building is not wired up yet. Pick another testing type for now.");
      continue;
    }
    const nextRunIndex = runCount(state);
    if (action === "functional") {
      await addFunctionalRun(state, nextRunIndex);
    } else {
      await addSituationalRun(state, nextRunIndex);
    }
  }

  if (state.instances.length === 0) {
    console.log("\nNo FIT testing was added, so no definition file was written.");
    return { artifacts: [], details: [] };
  }

  const definition: FitDefinition = buildFitDefinition({
    ...(state.gerritRef ? { gerritRef: state.gerritRef } : {}),
    capellaEnvironments: state.capellaEnvironments,
    instances: state.instances,
    clusterConfigs: state.clusterConfigs,
    fitConfigs: state.fitConfigs,
  });

  const allRuns = definition.instances.flatMap((i) =>
    [...(i.clusterlessSessions ?? []), ...i.clusters.flatMap((c) => c.sessions)].flatMap((s) => s.runs),
  );
  const hasSituational = allRuns.some((r) => r.type === "situational");
  const outputFormat = options?.format ?? resolveOutputFormat();
  const write = hasSituational ? writeFitSituationalDefinition : writeFitDefinition;
  const formatFn = hasSituational ? formatFitSituationalDefinition : formatFitDefinition;
  const result = write(definition, undefined, outputFormat);
  const formatted = formatFn(definition, outputFormat);
  console.log(`\nWriting ${result.path}:\n`);
  printFileContent(formatted);
  console.log(`\n✓ Wrote ${result.path}`);

  if (options?.pushGistVisibility) {
    console.log(`\nPushing ${options.pushGistVisibility} gist…`);
    const gist = await pushGist(result.path, formatted, options.pushGistVisibility);
    console.log(`✓ Gist created: ${gist.url}`);
  }

  printDefinitionRunGuidance(result.path, Object.keys(state.capellaEnvironments).length > 0);

  return { artifacts: [result.artifact], details: [] };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const pushGistVisibility = extractPushGistVisibility(process.argv.slice(2));
    return createFitDefinition({ pushGistVisibility });
  });
}
