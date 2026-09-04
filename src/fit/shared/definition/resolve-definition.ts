/**
 * Turn a validated `fit` definition into concrete run inputs.
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import type { DefinitionRunPath } from "../../../util/non-fit/replay.js";
import { clusterLabel, instanceLabel, performerLabel, runLabel } from "../util/run-labels.js";
import { classifyConnectionString } from "../../../cluster/cluster-select/classify-connection-string.js";
import type { SelectedCluster } from "../../../cluster/cluster-select/cluster-select.js";
import {
  DEFAULT_PERFORMER_PORT,
  DEFAULT_PORT_IN_USE_POLICY,
  type PortInUsePolicy,
} from "../../performers/util/performer-port.js";
import { type Sdk } from "../../../util/sdk/sdks.js";
import { parsePerformerImage } from "../../performers/util/performer-image.js";
import {
  ANALYTICS_DEFAULT_EXCLUDED_GROUPS,
  ANALYTICS_MAVEN_TEST_ARGS,
  DEFAULT_EXCLUDED_GROUPS,
  DEFAULT_MAVEN_TEST_ARGS,
  SITUATIONAL_CNG_DEFAULT_EXCLUDED_GROUPS,
  SITUATIONAL_CNG_MAVEN_GROUPS_ARG,
  SITUATIONAL_CNG_MAVEN_TEST_ARGS,
  SITUATIONAL_DEFAULT_EXCLUDED_GROUPS,
  SITUATIONAL_MAVEN_GROUPS_ARG,
  SITUATIONAL_MAVEN_TEST_ARGS,
} from "../run-test-driver/run-test-driver.js";
import {
  buildDefaultFitTestSelection,
  buildFitTestSelectionFromClassNames,
  type DeferredTestPreset,
  type FitTestSelection,
} from "../select-fit-tests/select-fit-tests.js";
import {
  DEFAULT_CLUSTER_EXISTS_POLICY,
  type ClusterExistsPolicy,
} from "../../../cluster/cluster-create/cluster-exists-policy.js";
import { DEFAULT_CAPELLA_ENV } from "../../util/config.js";
import type { CbdinoclusterDef } from "../../../cluster/cluster-create/build-cluster-def.js";
import type { CapellaClusterSetup } from "./types.js";
import { loadDefinition } from "./parse-definition.js";
import type {
  CbdinoclusterInitSetup,
  CbdinoclusterSource,
  ClusterLifetime,
  ConnectionClusterSetup,
  FitDefinition,
  FitRun,
  InstanceLifetime,
  PrivateEndpointSetup,
  ResolvedFitConfig,
  SessionLifetime,
  SituationalRun,
  TestsSection,
} from "./types.js";

export type { ResolvedFitConfig } from "./types.js";
export type { PrivateEndpointSetup } from "./types.js";

export type ResolvedInstance =
  | { kind: "aws"; instanceType?: string; privateEndpoint?: PrivateEndpointSetup }
  | { kind: "gcp"; instanceType?: string; privateEndpoint?: PrivateEndpointSetup }
  | { kind: "localhost" };

export function resolveInstance(instance: InstanceLifetime): ResolvedInstance {
  if ("aws" in instance) {
    return {
      kind: "aws",
      ...(instance.aws.instanceType !== undefined ? { instanceType: instance.aws.instanceType } : {}),
      ...(instance.aws.privateEndpoint !== undefined ? { privateEndpoint: instance.aws.privateEndpoint } : {}),
    };
  }
  if ("gcp" in instance) {
    return {
      kind: "gcp",
      ...(instance.gcp.instanceType !== undefined ? { instanceType: instance.gcp.instanceType } : {}),
      ...(instance.gcp.privateEndpoint !== undefined ? { privateEndpoint: instance.gcp.privateEndpoint } : {}),
    };
  }
  return { kind: "localhost" };
}

export interface ResolvedRunCommon {
  path: DefinitionRunPath;
  fitConfig?: ResolvedFitConfig;
  testSelection: FitTestSelection;
  extraMavenArgs: string[];
  /**
   * An `analytics-functional` def run resolves to a functional run carrying this
   * marker. It flows through the same cluster/performer/run machinery as a
   * functional run, but is executed against the Analytics test-driver module
   * ({@link ANALYTICS_TEST_DRIVER_MODULE}) and gets an Analytics-shaped
   * FITConfiguration (see run-from-definition).
   */
  analytics?: boolean;
}

export interface ResolvedFunctionalRun extends ResolvedRunCommon {
  type: "functional";
}

export interface ResolvedSituationalRun extends ResolvedRunCommon {
  type: "situational";
  cng: boolean;
  /** Present when this run should connect to cbdino's Capella cluster over AWS PrivateLink. */
  privateEndpoint?: PrivateEndpointSetup;
  /** Couchbase Server version cbdino should deploy; see {@link SituationalRun.versions}. */
  version?: string;
}

export type ResolvedRun = ResolvedFunctionalRun | ResolvedSituationalRun;

export interface ResolvedSessionPlan {
  path: DefinitionRunPath;
  sdk: Sdk;
  performerPort: number;
  performerVersion?: string;
  onPortInUse: PortInUsePolicy;
  runs: ResolvedRun[];
}

export interface ResolvedCbdinocluster {
  init?: CbdinoclusterInitSetup;
  config: CbdinoclusterDef;
  onClusterExists: ClusterExistsPolicy;
  deployer?: string;
  /** Present when this is a Capella cloud cluster. */
  capella?: CapellaClusterSetup;
}

export interface ResolvedClusterPlan {
  path: DefinitionRunPath;
  clusterMode: "connection" | "useExisting" | "cbdinocluster";
  cng: boolean;
  cluster?: SelectedCluster;
  cbdinocluster?: ResolvedCbdinocluster;
  sessions: ResolvedSessionPlan[];
}

export interface ResolvedInstancePlan {
  path: DefinitionRunPath;
  instance: ResolvedInstance;
  clusters: ResolvedClusterPlan[];
  cbdinoclusterInit?: CbdinoclusterInitSetup;
  /** Where to get the cbdinocluster binary. Absent means latest release. */
  cbdinoclusterSource?: CbdinoclusterSource;
  clusterlessSessions: ResolvedSessionPlan[];
  /** Resolved Capella environment for this instance (instance.setup.capellaEnvironment → "prod"). */
  capellaEnvironment: string;
}

export interface ResolvedDefinition {
  fitPerformerGerritRef?: string;
  instances: ResolvedInstancePlan[];
}

export interface ResolvedExecutionRunCommon extends ResolvedRunCommon {
  sdk: Sdk;
  performerPort: number;
  performerVersion?: string;
  onPortInUse: PortInUsePolicy;
}

export interface ResolvedFunctionalExecutionRun extends ResolvedExecutionRunCommon {
  type: "functional";
  cluster?: SelectedCluster;
}

export interface ResolvedSituationalExecutionRun extends ResolvedExecutionRunCommon {
  type: "situational";
  cng: boolean;
  /** Present when this run should connect to cbdino's Capella cluster over AWS PrivateLink. */
  privateEndpoint?: PrivateEndpointSetup;
  /** Couchbase Server version cbdino should deploy; see {@link SituationalRun.versions}. */
  version?: string;
}

export type ResolvedExecutionRun = ResolvedFunctionalExecutionRun | ResolvedSituationalExecutionRun;

export interface ResolvedSessionGroup {
  sdk: Sdk;
  performerPort: number;
  performerVersion?: string;
  onPortInUse: PortInUsePolicy;
  /** Session-level path (carries sessionIndex). */
  path: DefinitionRunPath;
  runs: ResolvedFunctionalExecutionRun[];
}

export interface ResolvedFunctionalExecutionGroup {
  type: "functional";
  path: DefinitionRunPath;
  instance: ResolvedInstance;
  clusterMode: "connection" | "useExisting" | "cbdinocluster";
  cng: boolean;
  cluster?: SelectedCluster;
  cbdinocluster?: ResolvedCbdinocluster;
  /** Where to get the cbdinocluster binary. Absent means latest release. */
  cbdinoclusterSource?: CbdinoclusterSource;
  capellaEnvironment: string;
  sessions: ResolvedSessionGroup[];
}

export interface ResolvedSituationalExecutionGroup {
  type: "situational";
  path: DefinitionRunPath;
  instance: ResolvedInstance;
  cbdinoclusterInit: CbdinoclusterInitSetup;
  /** Where to get the cbdinocluster binary. Absent means latest release. */
  cbdinoclusterSource?: CbdinoclusterSource;
  capellaEnvironment: string;
  /** True when any run in this group is a CNG run (see {@link ResolvedSituationalExecutionRun.cng}). */
  cng: boolean;
  runs: ResolvedSituationalExecutionRun[];
}

export type ResolvedExecutionGroup = ResolvedFunctionalExecutionGroup | ResolvedSituationalExecutionGroup;

export function resolveDefinitionRefs(def: FitDefinition): FitDefinition {
  const clusterConfigMap = new Map((def.clusterConfigs ?? []).map((c) => [c.id, c]));
  const fitConfigMap = new Map((def.fitConfigs ?? []).map((f) => [f.id, f]));

  function resolveRunRefs(run: FitRun, path: string): FitRun {
    if (typeof run.fitConfig !== "string") {
      return run;
    }
    const ref = fitConfigMap.get(run.fitConfig);
    if (!ref) {
      throw new Error(`fitConfig ref "${run.fitConfig}" not found in fitConfigs (at ${path}.fitConfig).`);
    }
    return {
      ...run,
      fitConfig: {
        ...(ref.config !== undefined ? { config: ref.config } : {}),
        ...(ref.connection !== undefined ? { connection: ref.connection } : {}),
        ...(ref.patch !== undefined ? { patch: ref.patch } : {}),
      },
    };
  }

  function resolveSessionRefs(session: SessionLifetime, path: string): SessionLifetime {
    return {
      ...session,
      runs: session.runs.map((run, i) => resolveRunRefs(run, `${path}.runs[${i}]`)),
    };
  }

  function resolveClusterRefs(cluster: ClusterLifetime, path: string): ClusterLifetime {
    if (typeof cluster.clusterConfig === "string") {
      const ref = clusterConfigMap.get(cluster.clusterConfig);
      if (!ref) {
        throw new Error(`clusterConfig ref "${cluster.clusterConfig}" not found in clusterConfigs (at ${path}).`);
      }
      const { id: _id, ...refFields } = ref;
      const resolved: ClusterLifetime = { ...refFields, sessions: cluster.sessions };
      return {
        ...resolved,
        sessions: resolved.sessions.map((session, i) => resolveSessionRefs(session, `${path}.sessions[${i}]`)),
      };
    }
    return {
      ...cluster,
      sessions: cluster.sessions.map((session, i) => resolveSessionRefs(session, `${path}.sessions[${i}]`)),
    };
  }

  const { clusterConfigs: _cc, fitConfigs: _fc, ...rest } = def;
  return {
    ...rest,
    instances: def.instances.map((instance, instanceIndex) => ({
      ...instance,
      clusters: instance.clusters.map((cluster, clusterIndex) =>
        resolveClusterRefs(cluster, `instances[${instanceIndex}].clusters[${clusterIndex}]`)),
      clusterlessSessions: (instance.clusterlessSessions ?? []).map((session, sessionIndex) =>
        resolveSessionRefs(session, `instances[${instanceIndex}].clusterlessSessions[${sessionIndex}]`)),
    })),
  };
}

function resolveTestsSelection(tests: TestsSection): FitTestSelection {
  const presets = tests.presets ?? [];
  const packageSelectors = (tests.packages ?? []).map((pkg) => `${pkg}.**`);
  const classes = [...(tests.classes ?? []), ...packageSelectors];
  // "all" (or omitting all keys) means run everything; it dominates any other entry.
  if (presets.includes("all") || (presets.length === 0 && classes.length === 0)) {
    return buildDefaultFitTestSelection();
  }
  const deferred = presets.filter((p): p is DeferredTestPreset => p !== "all");
  if (deferred.length === 0) {
    // Only explicit classes/packages — resolve up front, no need to list tests on the box.
    return buildFitTestSelectionFromClassNames(classes);
  }
  // Deferred presets (optionally plus explicit classes/packages) — expand on the box.
  return {
    allTests: [],
    selectedTests: [],
    presets: deferred,
    ...(classes.length > 0 ? { extraClasses: classes } : {}),
  };
}

const JUNIT_DISABLED_CONDITION = "org.junit.jupiter.api.condition.DisabledCondition";

function resolveMavenSuffix(tests: TestsSection): string[] {
  const extra: string[] = [];
  if (tests.maven?.runDisabledTests) {
    extra.push(`-Djunit.jupiter.conditions.deactivate=${JUNIT_DISABLED_CONDITION}`);
  }
  if (tests.maven?.args) {
    extra.push(...tests.maven.args);
  }
  return extra;
}

/**
 * The final excluded-groups list for a run, or undefined to keep the built-in
 * default args. `excludedGroups` replaces the defaults outright (mutually
 * exclusive with the other two, enforced at parse time). `addToDefaultExcludedGroups`
 * appends to the defaults and `reincludeDefaultExcludedGroups` removes from them (e.g. a release
 * preset opting back into `slow` tests); the two compose freely.
 */
function resolveExcludedGroups(tests: TestsSection, defaults: readonly string[]): string[] | undefined {
  if (tests.excludedGroups !== undefined) {
    return tests.excludedGroups;
  }
  if (tests.addToDefaultExcludedGroups === undefined && tests.reincludeDefaultExcludedGroups === undefined) {
    return undefined;
  }
  const reincluded = new Set(tests.reincludeDefaultExcludedGroups ?? []);
  return [...defaults.filter((group) => !reincluded.has(group)), ...(tests.addToDefaultExcludedGroups ?? [])];
}

export function resolveMavenArgs(tests: TestsSection): string[] {
  const excluded = resolveExcludedGroups(tests, DEFAULT_EXCLUDED_GROUPS);
  const base = excluded === undefined
    ? [...DEFAULT_MAVEN_TEST_ARGS]
    : [`-DexcludedGroups=${excluded.join(",")}`];
  return [...base, ...resolveMavenSuffix(tests)];
}

export function resolveSituationalMavenArgs(tests: TestsSection, cng: boolean): string[] {
  const groupsArg = cng ? SITUATIONAL_CNG_MAVEN_GROUPS_ARG : SITUATIONAL_MAVEN_GROUPS_ARG;
  const defaultExcluded = cng ? SITUATIONAL_CNG_DEFAULT_EXCLUDED_GROUPS : SITUATIONAL_DEFAULT_EXCLUDED_GROUPS;
  const excluded = resolveExcludedGroups(tests, defaultExcluded);
  const base = excluded === undefined
    ? [...(cng ? SITUATIONAL_CNG_MAVEN_TEST_ARGS : SITUATIONAL_MAVEN_TEST_ARGS)]
    : [groupsArg, `-DexcludedGroups=${excluded.join(",")}`];
  return [...base, ...resolveMavenSuffix(tests)];
}

export function resolveAnalyticsMavenArgs(tests: TestsSection): string[] {
  const excluded = resolveExcludedGroups(tests, ANALYTICS_DEFAULT_EXCLUDED_GROUPS);
  const base = excluded === undefined
    ? [...ANALYTICS_MAVEN_TEST_ARGS]
    : [`-DexcludedGroups=${excluded.join(",")}`];
  return [...base, ...resolveMavenSuffix(tests)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${path} must be a mapping.`);
  }
  return value;
}

function requireString(record: Record<string, unknown>, key: string, path: string): string {
  if (typeof record[key] !== "string") {
    throw new Error(`${path} must be a string.`);
  }
  return record[key];
}

function asFitConfig(value: ResolvedFitConfig | string | undefined): ResolvedFitConfig | undefined {
  return typeof value === "string" ? undefined : value;
}

function resolveFitConfigTls(value: unknown, path: string): SelectedCluster["tls"] {
  if (value === undefined || value === null) {
    return null;
  }
  const record = requireRecord(value, path);
  if (record.insecure === true) {
    return { insecure: true };
  }
  if (typeof record.certPath === "string") {
    return { certPath: record.certPath };
  }
  throw new Error(`${path} must be null, { insecure: true }, or { certPath: <path> }.`);
}

function resolveClusterConnectionRecord(clusterAccess: Record<string, unknown>, path: string): SelectedCluster {
  const connectionString = requireString(clusterAccess, "connectionString", `${path}.connectionString`);
  const classification = classifyConnectionString(connectionString);
  if (classification.kind !== "supported") {
    throw new Error(
      `${path}.connectionString "${connectionString}" is not one fit-cli can use (${classification.kind}). Use a couchbase:// or couchbases:// connection string.`,
    );
  }
  return {
    scheme: classification.scheme,
    defaultHostname: classification.defaultHostname,
    flavour: classification.flavour,
    credentials: {
      username: requireString(clusterAccess, "username", `${path}.username`),
      password: requireString(clusterAccess, "password", `${path}.password`),
    },
    tls: resolveFitConfigTls(clusterAccess.tls, `${path}.tls`),
  };
}

export function resolveConnectionCluster(connection: ConnectionClusterSetup | undefined): SelectedCluster | undefined {
  if (!connection) {
    return undefined;
  }
  return resolveClusterConnectionRecord({ ...connection }, "cluster.connection");
}

export function resolveFitConfigCluster(
  fitConfig: ResolvedFitConfig | undefined,
  path: string = "cluster.fitConfig",
): SelectedCluster | undefined {
  if (!fitConfig?.config) {
    return undefined;
  }
  const clusterAccess = requireRecord(fitConfig.config.clusterAccess, `${path}.clusterAccess`);
  return resolveClusterConnectionRecord(clusterAccess, `${path}.clusterAccess`);
}

function stripFitConfigClusterAccess(fitConfig: ResolvedFitConfig | undefined): ResolvedFitConfig | undefined {
  if (!fitConfig?.config || !("clusterAccess" in fitConfig.config)) {
    return fitConfig;
  }
  const rest = { ...fitConfig.config };
  delete rest.clusterAccess;
  const config = Object.keys(rest).length > 0 ? rest : undefined;
  const stripped = { ...fitConfig, ...(config !== undefined ? { config } : {}) };
  if (config === undefined) {
    delete stripped.config;
  }
  return Object.keys(stripped).length > 0 ? stripped : undefined;
}

export function resolveCbdinocluster(cluster: ClusterLifetime): ResolvedCbdinocluster | undefined {
  if (!cluster.cbdinocluster) {
    return undefined;
  }
  return {
    config: cluster.cbdinocluster.config,
    onClusterExists: cluster.cbdinocluster.onClusterExists ?? DEFAULT_CLUSTER_EXISTS_POLICY,
    // Prefer an explicit top-level deployer; fall back to config.deployer (e.g. "cloud" for Capella Analytics).
    ...(cluster.cbdinocluster.deployer !== undefined || cluster.cbdinocluster.config.deployer !== undefined
      ? { deployer: cluster.cbdinocluster.deployer ?? cluster.cbdinocluster.config.deployer }
      : {}),
    ...(cluster.cbdinocluster.capella !== undefined ? { capella: cluster.cbdinocluster.capella } : {}),
  };
}

type ResolvedRunWithoutPath = Omit<ResolvedFunctionalRun, "path"> | Omit<ResolvedSituationalRun, "path">;

function resolveRun(run: FitRun, stripClusterAccess: boolean): ResolvedRunWithoutPath {
  const rawFitConfig = asFitConfig(run.fitConfig);
  const fitConfig = stripClusterAccess ? stripFitConfigClusterAccess(rawFitConfig) : rawFitConfig;
  if (run.type === "situational") {
    return {
      type: "situational",
      ...(fitConfig !== undefined ? { fitConfig } : {}),
      testSelection: resolveTestsSelection(run.tests),
      extraMavenArgs: resolveSituationalMavenArgs(run.tests, run.situational.cng !== undefined),
      cng: run.situational.cng !== undefined,
      ...(run.situational.privateEndpoint !== undefined ? { privateEndpoint: run.situational.privateEndpoint } : {}),
      ...(run.situational.version !== undefined ? { version: run.situational.version } : {}),
    };
  }
  if (run.type === "analytics-functional") {
    // Collapses to a functional run carrying the analytics marker: it shares the
    // whole functional cluster/performer/run path, but is run against the
    // Analytics test-driver module with the Analytics excluded-groups defaults.
    return {
      type: "functional",
      analytics: true,
      ...(fitConfig !== undefined ? { fitConfig } : {}),
      testSelection: resolveTestsSelection(run.tests),
      extraMavenArgs: resolveAnalyticsMavenArgs(run.tests),
    };
  }
  return {
    type: "functional",
    ...(fitConfig !== undefined ? { fitConfig } : {}),
    testSelection: resolveTestsSelection(run.tests),
    extraMavenArgs: resolveMavenArgs(run.tests),
  };
}

export function resolveSession(
  session: SessionLifetime,
  path: DefinitionRunPath,
  stripClusterAccess: boolean,
): ResolvedSessionPlan {
  const { sdk, tag } = parsePerformerImage(session.performer.image);
  const sessionSeg = performerLabel(path, sdk.value, tag);
  const pathWithSession: DefinitionRunPath = { ...path, dirSegments: { ...path.dirSegments, session: sessionSeg } };
  let runIndex = 0;
  const runs = session.runs.flatMap((run) => {
    if (run.type === "situational" && run.versions !== undefined) {
      const versions = run.versions;
      const { versions: _versions, ...runWithoutVersions } = run;
      return versions.map((version) => {
        const ri = runIndex++;
        const versionedRun: SituationalRun = { ...runWithoutVersions, situational: { ...run.situational, version } };
        return resolveRunWithPath(
          versionedRun,
          { ...pathWithSession, runIndex: ri },
          stripClusterAccess,
          undefined,
          version,
        );
      });
    }
    const count = run.repeat ?? 1;
    return Array.from({ length: count }, (_, repeatIndex) => {
      const ri = runIndex++;
      return resolveRunWithPath(
        run,
        { ...pathWithSession, runIndex: ri },
        stripClusterAccess,
        count > 1 ? repeatIndex : undefined,
      );
    });
  });
  return {
    path: pathWithSession,
    sdk,
    performerPort: session.performer.port ?? DEFAULT_PERFORMER_PORT,
    performerVersion: tag,
    onPortInUse: session.performer.onPortInUse ?? DEFAULT_PORT_IN_USE_POLICY,
    runs,
  };
}

function resolveRunWithPath(
  run: FitRun,
  path: DefinitionRunPath,
  stripClusterAccess: boolean,
  repeatIndex?: number,
  versionLabel?: string,
): ResolvedRun {
  const resolved = resolveRun(run, stripClusterAccess);
  let runSeg = runLabel(path, run.type, resolved.testSelection.presets);
  if (repeatIndex !== undefined) {
    runSeg = runSeg !== undefined ? `${runSeg}:r${repeatIndex + 1}` : `r${repeatIndex + 1}`;
  }
  if (versionLabel !== undefined) {
    runSeg = runSeg !== undefined ? `${runSeg}:v${versionLabel}` : `v${versionLabel}`;
  }
  const pathWithRun: DefinitionRunPath = {
    ...path,
    dirSegments: { ...path.dirSegments, ...(runSeg !== undefined ? { run: runSeg } : {}) },
  };
  return { ...resolved, path: pathWithRun };
}

export function resolveCluster(cluster: ClusterLifetime, path: DefinitionRunPath): ResolvedClusterPlan {
  const connection = resolveConnectionCluster(cluster.connection);
  const cbdinocluster = resolveCbdinocluster(cluster);
  const useExisting = cluster.useExisting !== undefined;
  const clusterMode = connection ? "connection" : useExisting ? "useExisting" : "cbdinocluster";
  let resolvedCluster = connection;
  if (useExisting) {
    const firstRunFitConfig = asFitConfig(cluster.sessions[0]?.runs[0]?.fitConfig);
    resolvedCluster = resolveFitConfigCluster(firstRunFitConfig);
    if (!resolvedCluster) {
      throw new Error("cluster.useExisting requires a run-level fitConfig with clusterAccess.");
    }
  }
  const cbdinoclusterVersion =
    clusterMode === "cbdinocluster" && cbdinocluster
      ? [...new Set(cbdinocluster.config.nodes.map((n) => n.version))].filter((v): v is string => !!v).join("+") || undefined
      : undefined;
  const isEA = cbdinocluster?.config.columnar === true && cbdinocluster.config.deployer !== "cloud";
  const isCA = cbdinocluster?.config.columnar === true && cbdinocluster.config.deployer === "cloud";
  const clusterSeg =
    clusterLabel(path, clusterMode, cbdinoclusterVersion, isEA, isCA) ??
    String(path.clusterIndex ?? 0);
  const pathWithCluster: DefinitionRunPath = { ...path, dirSegments: { ...path.dirSegments, cluster: clusterSeg } };
  return {
    path: pathWithCluster,
    clusterMode,
    cng: cbdinocluster?.config.cao !== undefined,
    ...(resolvedCluster ? { cluster: resolvedCluster } : {}),
    ...(cbdinocluster ? { cbdinocluster } : {}),
    sessions: cluster.sessions.map((session, sessionIndex) =>
      resolveSession(session, { ...pathWithCluster, sessionIndex }, clusterMode === "connection")),
  };
}

export function resolveInstancePlan(
  instance: InstanceLifetime,
  instanceIndex: number,
  sharedCbdinoclusterSource?: CbdinoclusterSource,
): ResolvedInstancePlan {
  const resolvedInstance = resolveInstance(instance);
  const instanceSeg = instanceLabel({ instanceIndex }, resolvedInstance.kind);
  const path: DefinitionRunPath = { instanceIndex, dirSegments: { instance: instanceSeg } };

  // Use the explicit setup block when present; otherwise infer: any cbdinocluster-backed
  // cluster or clusterless session needs cbdinocluster init on a clean remote box.
  // An empty CbdinoclusterInitSetup ({}) signals "run default init" — the actual args
  // are generated at runtime (defaultCbdinoclusterInitArgs / situationalCbdinoclusterInitArgs).
  let cbdinoclusterInit: CbdinoclusterInitSetup | undefined;
  // Which cbdinocluster binary to build/install is a top-level (`setup.cbdinocluster.source`)
  // choice applied to every instance in the run — unlike `init`, which is genuinely per-box.
  const cbdinoclusterSource = sharedCbdinoclusterSource;
  if (instance.setup?.cbdinocluster !== undefined) {
    cbdinoclusterInit = { ...instance.setup.cbdinocluster.init };
  } else if (
    instance.clusters.some((c) => c.cbdinocluster !== undefined) ||
    (instance.clusterlessSessions?.length ?? 0) > 0
  ) {
    cbdinoclusterInit = {};
  }

  return {
    path,
    instance: resolvedInstance,
    clusters: instance.clusters.map((cluster, clusterIndex) =>
      resolveCluster(cluster, { instanceIndex, clusterIndex, dirSegments: { instance: instanceSeg } })),
    ...(cbdinoclusterInit !== undefined ? { cbdinoclusterInit } : {}),
    ...(cbdinoclusterSource !== undefined ? { cbdinoclusterSource } : {}),
    clusterlessSessions: (instance.clusterlessSessions ?? []).map((session, sessionIndex) =>
      resolveSession(session, { instanceIndex, sessionIndex, clusterlessSession: true, dirSegments: { instance: instanceSeg } }, false)),
    capellaEnvironment: instance.setup?.capellaEnvironment ?? DEFAULT_CAPELLA_ENV,
  };
}

export function resolveDefinition(definition: FitDefinition): ResolvedDefinition {
  const resolved = resolveDefinitionRefs(definition);
  const cbdinoclusterSource = resolved.setup?.cbdinocluster?.source;
  const instances = resolved.instances.map((instance, instanceIndex) =>
    resolveInstancePlan(instance, instanceIndex, cbdinoclusterSource));
  return {
    ...(resolved.setup?.repos?.["transactions-fit-performer"]?.gerritRef !== undefined
      ? { fitPerformerGerritRef: resolved.setup.repos["transactions-fit-performer"].gerritRef }
      : {}),
    instances,
  };
}

export function buildExecutionGroups(instances: ResolvedInstancePlan[]): ResolvedExecutionGroup[] {
  return instances.flatMap((instance) => [
    ...instance.clusters.map<ResolvedFunctionalExecutionGroup>((cluster) => ({
      type: "functional",
      path: cluster.path,
      instance: instance.instance,
      clusterMode: cluster.clusterMode,
      cng: cluster.cng,
      ...(cluster.cluster ? { cluster: cluster.cluster } : {}),
      // cbdinocluster init lives once per instance now (instance.setup); fold it
      // into each cbdinocluster-backed cluster group so setup-cluster still finds it.
      ...(cluster.cbdinocluster
        ? {
            cbdinocluster: {
              ...cluster.cbdinocluster,
              ...(instance.cbdinoclusterInit ? { init: instance.cbdinoclusterInit } : {}),
            },
          }
        : {}),
      ...(instance.cbdinoclusterSource ? { cbdinoclusterSource: instance.cbdinoclusterSource } : {}),
      capellaEnvironment: instance.capellaEnvironment,
      sessions: cluster.sessions.map((session) => ({
        sdk: session.sdk,
        performerPort: session.performerPort,
        ...(session.performerVersion !== undefined ? { performerVersion: session.performerVersion } : {}),
        onPortInUse: session.onPortInUse,
        path: session.path,
        runs: session.runs
          .filter((run): run is ResolvedFunctionalRun => run.type === "functional")
          .map((run) => ({
            type: "functional" as const,
            path: run.path,
            sdk: session.sdk,
            performerPort: session.performerPort,
            ...(session.performerVersion !== undefined ? { performerVersion: session.performerVersion } : {}),
            onPortInUse: session.onPortInUse,
            ...(run.fitConfig !== undefined ? { fitConfig: run.fitConfig } : {}),
            testSelection: run.testSelection,
            extraMavenArgs: run.extraMavenArgs,
            ...(run.analytics ? { analytics: true } : {}),
            ...(cluster.cluster ? { cluster: cluster.cluster } : {}),
          })),
      })),
    })),
    ...(instance.clusterlessSessions.length === 0 || !instance.cbdinoclusterInit
      ? []
      : [
          {
            type: "situational" as const,
            path: {
              instanceIndex: instance.path.instanceIndex,
              sessionIndex: instance.clusterlessSessions[0]?.path.sessionIndex,
              clusterlessSession: true,
              dirSegments: { instance: instance.path.dirSegments?.instance },
            },
            instance: instance.instance,
            cbdinoclusterInit: instance.cbdinoclusterInit,
            ...(instance.cbdinoclusterSource ? { cbdinoclusterSource: instance.cbdinoclusterSource } : {}),
            capellaEnvironment: instance.capellaEnvironment,
            cng: instance.clusterlessSessions.some((session) =>
              session.runs.some((run) => run.type === "situational" && run.cng),
            ),
            runs: instance.clusterlessSessions.flatMap((session) =>
              session.runs
                .filter((run): run is ResolvedSituationalRun => run.type === "situational")
                .map((run) => ({
                  type: "situational" as const,
                  path: run.path,
                  sdk: session.sdk,
                  performerPort: session.performerPort,
                  ...(session.performerVersion !== undefined ? { performerVersion: session.performerVersion } : {}),
                  onPortInUse: session.onPortInUse,
                  ...(run.fitConfig !== undefined ? { fitConfig: run.fitConfig } : {}),
                  testSelection: run.testSelection,
                  extraMavenArgs: run.extraMavenArgs,
                  cng: run.cng,
                  ...(run.privateEndpoint !== undefined ? { privateEndpoint: run.privateEndpoint } : {}),
                  ...(run.version !== undefined ? { version: run.version } : {}),
                })),
            ),
          },
        ]),
  ]);
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const path = process.argv[2];
    if (!path) {
      console.error("Usage: tsx src/workflows/fit-shared/definition/resolve-definition.ts <file.yaml>");
      process.exit(2);
    }
    console.log(JSON.stringify(resolveDefinition(loadDefinition(path)), null, 2));
    return Promise.resolve();
  });
}
