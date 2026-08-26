/**
 * Parse and validate a `fit` definition file.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import JSON5 from "json5";
import YAML from "yaml";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../../util/non-fit/fit-cli-log.js";
import { PORT_IN_USE_POLICIES, type PortInUsePolicy } from "../../performers/util/performer-port.js";
import {
  CLUSTER_EXISTS_POLICIES,
  type ClusterExistsPolicy,
} from "../../../cluster/cluster-create/cluster-exists-policy.js";
import { CAPELLA_CLOUD_PROVIDERS, type CbdinoclusterDef } from "../../../cluster/cluster-create/build-cluster-def.js";
import { analysePerformerImage } from "../../performers/util/performer-image.js";
import { isAnalyticsSdk } from "../../../util/sdk/sdks.js";
import {
  CURRENT_FIT_DEFINITION_VERSION,
  FIT_DEFINITION_TYPE,
  FIT_RUN_TYPES,
  SITUATIONAL_DATABASE_MODES,
  TEST_PRESETS,
  type AwsInstanceSetup,
  type GcpInstanceSetup,
  type PrivateEndpointSetup,
  type CbdinoclusterInitSetup,
  type CbdinoclusterSetup,
  type CbdinoclusterSource,
  type ClusterConfigRef,
  type ClusterLifetime,
  type ClusterTls,
  type ConnectionClusterSetup,
  type ConnectionScheme,
  type FitConfigPiece,
  type FitConfigRef,
  type FitConnectionSpec,
  type FitDefinition,
  type FitRun,
  type InstanceLifetime,
  type InstanceSetup,
  type MavenOptions,
  type PerformerSetup,
  type ResolvedFitConfig,
  type SchemeAndTls,
  type SessionLifetime,
  type SharedSetup,
  type SituationalDatabaseMode,
  type SituationalDatabaseSetup,
  type CapellaClusterSetup,
  type SituationalCngSetup,
  type SituationalSection,
  type TestPreset,
  type TestsSection,
  type UseExistingClusterSetup,
} from "./types.js";

export class UnsupportedDefinitionVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedDefinitionVersionError";
  }
}

export class InvalidDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDefinitionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === "string";
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new InvalidDefinitionError(`"${path}" must be a mapping; got ${JSON.stringify(value)}`);
  }
  return value;
}

function rejectUnknown(record: Record<string, unknown>, known: string[], path: string): void {
  const unknownKeys = Object.keys(record).filter(k => !known.includes(k));
  if (unknownKeys.length > 0) {
    throw new InvalidDefinitionError(
      `Unknown field(s) at "${path}": ${unknownKeys.map(k => JSON.stringify(k)).join(", ")}. ` +
      `fit-cli intentionally rejects unknown fields: this could mean a typo, or a field from a newer version of fit-cli that this older build does not support. Either way it should not be silently ignored.`,
    );
  }
}

function requireString(record: Record<string, unknown>, key: string, path: string): string {
  if (!(key in record)) {
    throw new InvalidDefinitionError(`Missing required field: ${path}`);
  }
  if (!isString(record[key])) {
    throw new InvalidDefinitionError(`"${path}" must be a string; got ${JSON.stringify(record[key])}`);
  }
  return record[key];
}

function validateJsonLike(value: unknown, path: string): JsonLike {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => validateJsonLike(entry, `${path}[${index}]`));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, validateJsonLike(entry, `${path}.${key}`)]),
    );
  }
  throw new InvalidDefinitionError(
    `"${path}" must contain only JSON-compatible values; got ${JSON.stringify(value)}`,
  );
}

function validateFitConfig(value: unknown, path: string): FitConfigPiece {
  return validateJsonLike(requireRecord(value, path), path) as FitConfigPiece;
}

function validateTls(value: unknown, path: string): ClusterTls {
  if (value === null || value === undefined) {
    return null;
  }
  const record = requireRecord(value, path);
  if (record.insecure === true) {
    rejectUnknown(record, ["insecure"], path);
    return { insecure: true };
  }
  if (isString(record.certPath)) {
    rejectUnknown(record, ["certPath"], path);
    return { certPath: record.certPath };
  }
  throw new InvalidDefinitionError(
    `"${path}" must be null, { insecure: true }, or { certPath: <path> }; got ${JSON.stringify(value)}`,
  );
}

function validateConnection(value: unknown, path: string): ConnectionClusterSetup {
  const record = requireRecord(value, path);
  rejectUnknown(record, ["connectionString", "username", "password", "tls"], path);
  return {
    connectionString: requireString(record, "connectionString", `${path}.connectionString`),
    username: requireString(record, "username", `${path}.username`),
    password: requireString(record, "password", `${path}.password`),
    ...(record.tls !== undefined ? { tls: validateTls(record.tls, `${path}.tls`) } : {}),
  };
}

function validateUseExisting(value: unknown, path: string): UseExistingClusterSetup {
  if (value === null || value === undefined) {
    return {};
  }
  const record = requireRecord(value, path);
  if (Object.keys(record).length > 0) {
    throw new InvalidDefinitionError(`"${path}" must be empty.`);
  }
  return {};
}

function requirePositiveInteger(record: Record<string, unknown>, key: string, path: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new InvalidDefinitionError(`"${path}" must be a positive integer; got ${JSON.stringify(value)}`);
  }
  return value;
}

function isClusterExistsPolicy(value: unknown): value is ClusterExistsPolicy {
  return isString(value) && (CLUSTER_EXISTS_POLICIES as readonly string[]).includes(value);
}

/**
 * The cbdinocluster `config` block is passed through to the `cbdinocluster` CLI
 * verbatim (it's YAML-stringified straight into the def file at allocate time), so
 * we don't reshape it or reject keys fit-cli doesn't model — any valid cbdinocluster
 * cluster-def field is forwarded as-is. We only check that the block is a
 * JSON-compatible mapping (so it serialises cleanly) with a non-empty `nodes` list,
 * which cbdinocluster requires and fit-cli reads downstream to describe the cluster.
 */
function validateCbdinoclusterDef(value: unknown, path: string): CbdinoclusterDef {
  const record = requireRecord(value, path);
  if (!Array.isArray(record.nodes) || record.nodes.length === 0) {
    throw new InvalidDefinitionError(`"${path}.nodes" must be a non-empty list; got ${JSON.stringify(record.nodes)}`);
  }
  return validateJsonLike(record, path) as unknown as CbdinoclusterDef;
}

function validateCbdinoclusterInit(value: unknown, path: string): CbdinoclusterInitSetup {
  const record = requireRecord(value, path);
  rejectUnknown(record, ["args", "config", "configPatch"], path);
  const hasArgs = record.args !== undefined;
  const hasConfig = record.config !== undefined;
  if (hasArgs && hasConfig) {
    throw new InvalidDefinitionError(`"${path}" must have exactly one of "args" or "config", not both.`);
  }
  if (hasArgs) {
    return {
      args: requireString(record, "args", `${path}.args`),
      // configPatch is merged onto ~/.cbdinocluster after `cbdinocluster init`
      // runs, for config init can't express via flags (e.g. situational capella/aws).
      ...(record.configPatch !== undefined
        ? { configPatch: validateFitConfig(record.configPatch, `${path}.configPatch`) }
        : {}),
    };
  }
  if (hasConfig) {
    return { config: validateFitConfig(record.config, `${path}.config`) };
  }
  throw new InvalidDefinitionError(`Missing required field: ${path}.args (or ${path}.config)`);
}

function validateCbdinocluster(value: unknown, path: string): CbdinoclusterSetup {
  const record = requireRecord(value, path);
  rejectUnknown(record, ["config", "onClusterExists", "deployer", "init", "capella"], path);
  if (record.config === undefined) {
    throw new InvalidDefinitionError(`Missing required field: ${path}.config`);
  }
  const cbdinocluster: CbdinoclusterSetup = { config: validateCbdinoclusterDef(record.config, `${path}.config`) };
  if (record.init !== undefined) {
    throw new InvalidDefinitionError(
      `"${path}.init" is no longer accepted here — cbdinocluster init moved to instances[].setup.cbdinocluster.init (set up once per instance).`,
    );
  }
  if (record.onClusterExists !== undefined) {
    if (!isClusterExistsPolicy(record.onClusterExists)) {
      throw new InvalidDefinitionError(
        `"${path}.onClusterExists" must be one of ${CLUSTER_EXISTS_POLICIES.join(", ")} when present; got ${JSON.stringify(record.onClusterExists)}`,
      );
    }
    cbdinocluster.onClusterExists = record.onClusterExists;
  }
  if (record.deployer !== undefined) {
    cbdinocluster.deployer = requireString(record, "deployer", `${path}.deployer`);
  }
  if (record.capella !== undefined) {
    cbdinocluster.capella = validateCapellaClusterSetup(record.capella, `${path}.capella`);
  }
  return cbdinocluster;
}

function validateCapellaClusterSetup(value: unknown, path: string): CapellaClusterSetup {
  const record = requireRecord(value, path);
  rejectUnknown(record, ["cloudProvider", "environment", "privateEndpoint"], path);
  const cloudProvider = requireString(record, "cloudProvider", `${path}.cloudProvider`);
  if (!CAPELLA_CLOUD_PROVIDERS.includes(cloudProvider as never)) {
    throw new InvalidDefinitionError(
      `"${path}.cloudProvider" must be one of ${CAPELLA_CLOUD_PROVIDERS.join(", ")}; got ${JSON.stringify(cloudProvider)}`,
    );
  }
  const setup: CapellaClusterSetup = { cloudProvider: cloudProvider as CapellaClusterSetup["cloudProvider"] };
  const environment = validateOptionalString(record, "environment", `${path}.environment`);
  if (environment !== undefined) {
    setup.environment = environment;
  }
  if (record["privateEndpoint"] !== undefined) {
    setup.privateEndpoint = validatePrivateEndpointSetup(record["privateEndpoint"], `${path}.privateEndpoint`);
  }
  return setup;
}

function validateOptionalString(record: Record<string, unknown>, key: string, path: string): string | undefined {
  return record[key] === undefined ? undefined : requireString(record, key, path);
}

function validatePrivateEndpointSetup(value: unknown, path: string): PrivateEndpointSetup {
  const record = requireRecord(value, path);
  if (Object.keys(record).length > 0) {
    throw new InvalidDefinitionError(`"${path}" must be empty.`);
  }
  return {};
}

function validateAwsInstance(value: unknown, path: string): AwsInstanceSetup {
  const record = value === null ? {} : requireRecord(value, path);
  rejectUnknown(record, ["instanceType", "privateEndpoint"], path);
  const aws: AwsInstanceSetup = {};
  const instanceType = validateOptionalString(record, "instanceType", `${path}.instanceType`);
  if (instanceType !== undefined) {
    aws.instanceType = instanceType;
  }
  if (record["privateEndpoint"] !== undefined) {
    aws.privateEndpoint = validatePrivateEndpointSetup(record["privateEndpoint"], `${path}.privateEndpoint`);
  }
  return aws;
}

function validateGcpInstance(value: unknown, path: string): GcpInstanceSetup {
  const record = value === null ? {} : requireRecord(value, path);
  rejectUnknown(record, ["instanceType", "privateEndpoint"], path);
  const gcp: GcpInstanceSetup = {};
  const instanceType = validateOptionalString(record, "instanceType", `${path}.instanceType`);
  if (instanceType !== undefined) {
    gcp.instanceType = instanceType;
  }
  if (record["privateEndpoint"] !== undefined) {
    gcp.privateEndpoint = validatePrivateEndpointSetup(record["privateEndpoint"], `${path}.privateEndpoint`);
  }
  return gcp;
}

function validateLocalhostInstance(value: unknown, path: string): Record<string, never> {
  if (value === null || value === undefined) {
    return {};
  }
  const record = requireRecord(value, path);
  if (Object.keys(record).length > 0) {
    throw new InvalidDefinitionError(`"${path}" must be empty; localhost takes no options.`);
  }
  return {};
}

function validateRepos(value: unknown): SharedSetup["repos"] {
  if (value === null) {
    return {};
  }
  const record = requireRecord(value, "setup.repos");
  rejectUnknown(record, ["transactions-fit-performer"], "setup.repos");
  const repos: NonNullable<SharedSetup["repos"]> = {};
  if (record["transactions-fit-performer"] !== undefined) {
    const fitPerformer = requireRecord(record["transactions-fit-performer"], "setup.repos.transactions-fit-performer");
    rejectUnknown(fitPerformer, ["gerritRef"], "setup.repos.transactions-fit-performer");
    repos["transactions-fit-performer"] = {
      ...(fitPerformer.gerritRef !== undefined
        ? { gerritRef: requireString(fitPerformer, "gerritRef", "setup.repos.transactions-fit-performer.gerritRef") }
        : {}),
    };
  }
  return repos;
}

function validateSharedSetup(value: unknown): SharedSetup {
  const record = requireRecord(value, "setup");
  rejectUnknown(record, ["repos", "cluster", "cbdinocluster"], "setup");
  const setup: SharedSetup = {};
  if (record.cluster !== undefined) {
    throw new InvalidDefinitionError(`"setup.cluster" is no longer supported.`);
  }
  if (record.repos !== undefined) {
    setup.repos = validateRepos(record.repos);
  }
  if (record.cbdinocluster !== undefined) {
    const cbdinocluster = requireRecord(record.cbdinocluster, "setup.cbdinocluster");
    rejectUnknown(cbdinocluster, ["source"], "setup.cbdinocluster");
    setup.cbdinocluster = {
      ...(cbdinocluster.source !== undefined
        ? { source: validateCbdinoclusterSource(cbdinocluster.source, "setup.cbdinocluster.source") }
        : {}),
    };
  }
  return setup;
}

function isPortInUsePolicy(value: unknown): value is PortInUsePolicy {
  return isString(value) && (PORT_IN_USE_POLICIES as readonly string[]).includes(value);
}

function validatePerformer(value: unknown, path: string): PerformerSetup {
  const record = requireRecord(value, path);
  rejectUnknown(record, ["image", "port", "onPortInUse", "sdk", "version"], path);
  if (record.sdk !== undefined || record.version !== undefined) {
    throw new InvalidDefinitionError(
      `"${path}" no longer takes "sdk"/"version"; use a single "image" like java-fit-performer:main` +
        ` (the SDK is derived from the image prefix).`,
    );
  }
  const image = requireString(record, "image", `${path}.image`);
  const parsed = analysePerformerImage(image);
  if ("error" in parsed) {
    throw new InvalidDefinitionError(`"${path}.image": ${parsed.error}`);
  }
  const performer: PerformerSetup = { image };
  if (record.port !== undefined) {
    performer.port = requirePositiveInteger(record, "port", `${path}.port`);
  }
  if (record.onPortInUse !== undefined) {
    if (!isPortInUsePolicy(record.onPortInUse)) {
      throw new InvalidDefinitionError(
        `"${path}.onPortInUse" must be one of ${PORT_IN_USE_POLICIES.join(", ")} when present; got ${JSON.stringify(record.onPortInUse)}`,
      );
    }
    performer.onPortInUse = record.onPortInUse;
  }
  return performer;
}

function isTestPreset(value: unknown): value is TestPreset {
  return isString(value) && (TEST_PRESETS as readonly string[]).includes(value);
}

function validateTestPresets(value: unknown, path: string): TestPreset[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidDefinitionError(
      `"${path}" must be a non-empty list of presets (${TEST_PRESETS.join(", ")}); got ${JSON.stringify(value)}`,
    );
  }
  for (const entry of value) {
    if (!isTestPreset(entry)) {
      throw new InvalidDefinitionError(
        `"${path}" entries must be one of ${TEST_PRESETS.join(", ")}; got ${JSON.stringify(entry)}`,
      );
    }
  }
  return value as TestPreset[];
}

function validateMaven(value: unknown, path: string): MavenOptions {
  const record = requireRecord(value, path);
  rejectUnknown(record, ["args", "runDisabledTests"], path);
  const maven: MavenOptions = {};
  if (record.args !== undefined) {
    if (!isStringArray(record.args)) {
      throw new InvalidDefinitionError(`"${path}.args" must be a list of strings when present; got ${JSON.stringify(record.args)}`);
    }
    maven.args = record.args;
  }
  if (record.runDisabledTests !== undefined) {
    if (typeof record.runDisabledTests !== "boolean") {
      throw new InvalidDefinitionError(`"${path}.runDisabledTests" must be a boolean when present; got ${JSON.stringify(record.runDisabledTests)}`);
    }
    maven.runDisabledTests = record.runDisabledTests;
  }
  return maven;
}

function validateTestsSection(value: unknown, path: string): TestsSection {
  const record = requireRecord(value, path);
  rejectUnknown(record, ["presets", "packages", "classes", "excludedGroups", "addToDefaultExcludedGroups", "reincludeDefaultExcludedGroups", "maven", "run"], path);
  if (record.run !== undefined) {
    throw new InvalidDefinitionError(
      `"${path}.run" is no longer supported; use "${path}.presets" (a list of ${TEST_PRESETS.join("/")}) and/or "${path}.classes" (a list of test class names).`,
    );
  }
  const tests: TestsSection = {};
  if (record.presets !== undefined) {
    tests.presets = validateTestPresets(record.presets, `${path}.presets`);
  }
  if (record.packages !== undefined) {
    if (!isStringArray(record.packages) || record.packages.length === 0) {
      throw new InvalidDefinitionError(
        `"${path}.packages" must be a non-empty list of Java package names when present; got ${JSON.stringify(record.packages)}`,
      );
    }
    tests.packages = record.packages;
  }
  if (record.classes !== undefined) {
    if (!isStringArray(record.classes) || record.classes.length === 0) {
      throw new InvalidDefinitionError(
        `"${path}.classes" must be a non-empty list of test class names when present; got ${JSON.stringify(record.classes)}`,
      );
    }
    tests.classes = record.classes;
  }
  if (record.excludedGroups !== undefined) {
    if (!isStringArray(record.excludedGroups)) {
      throw new InvalidDefinitionError(`"${path}.excludedGroups" must be a list of strings when present; got ${JSON.stringify(record.excludedGroups)}`);
    }
    tests.excludedGroups = record.excludedGroups;
  }
  if (record.addToDefaultExcludedGroups !== undefined) {
    if (!isStringArray(record.addToDefaultExcludedGroups)) {
      throw new InvalidDefinitionError(`"${path}.addToDefaultExcludedGroups" must be a list of strings when present; got ${JSON.stringify(record.addToDefaultExcludedGroups)}`);
    }
    if (record.excludedGroups !== undefined) {
      throw new InvalidDefinitionError(`"${path}.excludedGroups" and "${path}.addToDefaultExcludedGroups" are mutually exclusive; set only one.`);
    }
    tests.addToDefaultExcludedGroups = record.addToDefaultExcludedGroups;
  }
  if (record.reincludeDefaultExcludedGroups !== undefined) {
    if (!isStringArray(record.reincludeDefaultExcludedGroups)) {
      throw new InvalidDefinitionError(`"${path}.reincludeDefaultExcludedGroups" must be a list of strings when present; got ${JSON.stringify(record.reincludeDefaultExcludedGroups)}`);
    }
    if (record.excludedGroups !== undefined) {
      throw new InvalidDefinitionError(`"${path}.excludedGroups" and "${path}.reincludeDefaultExcludedGroups" are mutually exclusive; set only one.`);
    }
    tests.reincludeDefaultExcludedGroups = record.reincludeDefaultExcludedGroups;
  }
  if (record.maven !== undefined) {
    tests.maven = validateMaven(record.maven, `${path}.maven`);
  }
  return tests;
}

function isSituationalDatabaseMode(value: unknown): value is SituationalDatabaseMode {
  return isString(value) && (SITUATIONAL_DATABASE_MODES as readonly string[]).includes(value);
}

/**
 * Validate an optional environment-name selector (capellaEnvironment / resultsEnvironment).
 * Only checks it's a string here; whether the named environment actually exists is checked
 * at run time against environments.json5 (resolveCapellaConfig / resolveResultsDbCredentials).
 */
function optionalEnvironmentName(record: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!isString(value)) {
    throw new InvalidDefinitionError(`"${path}.${key}" must be a string; got ${JSON.stringify(value)}`);
  }
  return value;
}

function validateSituationalDatabase(value: unknown, path: string): SituationalDatabaseSetup {
  const record = requireRecord(value, path);
  rejectUnknown(record, ["mode", "resultsEnvironment"], path);
  if (!isSituationalDatabaseMode(record.mode)) {
    throw new InvalidDefinitionError(`"${path}.mode" must be one of ${SITUATIONAL_DATABASE_MODES.join(", ")}; got ${JSON.stringify(record.mode)}`);
  }
  const resultsEnvironment = optionalEnvironmentName(record, "resultsEnvironment", path);
  if (record.mode !== "hosted" && resultsEnvironment !== undefined) {
    throw new InvalidDefinitionError(`"${path}.resultsEnvironment" only applies to mode "hosted".`);
  }
  return { mode: record.mode, ...(resultsEnvironment !== undefined ? { resultsEnvironment } : {}) };
}

function validateSituationalCng(value: unknown, path: string): SituationalCngSetup {
  const record = requireRecord(value, path);
  if (Object.keys(record).length > 0) {
    throw new InvalidDefinitionError(`"${path}" must be empty.`);
  }
  return {};
}

function validateSituationalVersion(record: Record<string, unknown>, path: string): string | undefined {
  const value = record.version;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidDefinitionError(`"${path}.version" must be a non-empty string when present; got ${JSON.stringify(value)}`);
  }
  return value;
}

function validateSituationalSection(value: unknown, path: string): SituationalSection {
  const record = requireRecord(value, path);
  rejectUnknown(record, ["database", "cng", "privateEndpoint", "version"], path);
  if (record.database === undefined) {
    throw new InvalidDefinitionError(`Missing required field: ${path}.database`);
  }
  const version = validateSituationalVersion(record, path);
  if (version !== undefined && record.cng !== undefined) {
    throw new InvalidDefinitionError(`"${path}.version" and "${path}.cng" are mutually exclusive — CNG pins its own cluster version.`);
  }
  return {
    database: validateSituationalDatabase(record.database, `${path}.database`),
    ...(record.cng !== undefined ? { cng: validateSituationalCng(record.cng, `${path}.cng`) } : {}),
    ...(record["privateEndpoint"] !== undefined
      ? { privateEndpoint: validatePrivateEndpointSetup(record["privateEndpoint"], `${path}.privateEndpoint`) }
      : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

function validateRunFitConfig(value: unknown, path: string): ResolvedFitConfig | string {
  if (isString(value)) {
    return value;
  }
  const record = requireRecord(value, path);
  rejectUnknown(record, ["config", "connection", "patch"], path);
  return {
    ...(record.config !== undefined ? { config: validateFitConfig(record.config, `${path}.config`) } : {}),
    ...(record.connection !== undefined ? { connection: validateFitConnectionSpec(record.connection, `${path}.connection`) } : {}),
    ...(record.patch !== undefined ? { patch: validateFitConfig(record.patch, `${path}.patch`) } : {}),
  };
}

function validateRepeat(record: Record<string, unknown>, path: string): number | undefined {
  if (record.repeat === undefined) return undefined;
  const value = record.repeat;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new InvalidDefinitionError(`"${path}.repeat" must be a positive integer when present; got ${JSON.stringify(value)}`);
  }
  return value;
}

function validateVersions(record: Record<string, unknown>, path: string): string[] | undefined {
  if (record.versions === undefined) return undefined;
  const value = record.versions;
  if (!Array.isArray(value) || value.length === 0 || !value.every((v): v is string => typeof v === "string" && v.length > 0)) {
    throw new InvalidDefinitionError(`"${path}.versions" must be a non-empty array of non-empty strings when present; got ${JSON.stringify(value)}`);
  }
  return value;
}

function validateRun(value: unknown, path: string, clusterless: boolean): FitRun {
  const record = requireRecord(value, path);
  const type = record.type;
  if (!isString(type) || !FIT_RUN_TYPES.includes(type as FitRun["type"])) {
    throw new InvalidDefinitionError(`"${path}.type" must be one of ${FIT_RUN_TYPES.join(", ")}; got ${JSON.stringify(type)}`);
  }
  if (record.tests === undefined) {
    throw new InvalidDefinitionError(`Missing required field: ${path}.tests`);
  }
  const repeat = validateRepeat(record, path);
  if (type === "functional" || type === "analytics-functional") {
    rejectUnknown(record, ["type", "tests", "fitConfig", "repeat"], path);
    if (clusterless) {
      throw new InvalidDefinitionError(`"${path}.type" cannot be "${type}" under clusterlessSessions.`);
    }
    return {
      type,
      tests: validateTestsSection(record.tests, `${path}.tests`),
      ...(record.fitConfig !== undefined ? { fitConfig: validateRunFitConfig(record.fitConfig, `${path}.fitConfig`) } : {}),
      ...(repeat !== undefined ? { repeat } : {}),
    };
  }
  rejectUnknown(record, ["type", "tests", "fitConfig", "repeat", "situational", "versions"], path);
  if (record.situational === undefined) {
    throw new InvalidDefinitionError(`Missing required field: ${path}.situational`);
  }
  const situational = validateSituationalSection(record.situational, `${path}.situational`);
  const versions = validateVersions(record, path);
  if (versions !== undefined && repeat !== undefined) {
    throw new InvalidDefinitionError(`"${path}.versions" and "${path}.repeat" are mutually exclusive; set only one.`);
  }
  if (versions !== undefined && situational.version !== undefined) {
    throw new InvalidDefinitionError(`"${path}.versions" and "${path}.situational.version" are mutually exclusive; set only one.`);
  }
  if (versions !== undefined && situational.cng !== undefined) {
    throw new InvalidDefinitionError(`"${path}.versions" cannot be combined with "${path}.situational.cng" — CNG pins its own cluster version.`);
  }
  return {
    type: "situational",
    tests: validateTestsSection(record.tests, `${path}.tests`),
    situational,
    ...(record.fitConfig !== undefined ? { fitConfig: validateRunFitConfig(record.fitConfig, `${path}.fitConfig`) } : {}),
    ...(repeat !== undefined ? { repeat } : {}),
    ...(versions !== undefined ? { versions } : {}),
  };
}

function validateSession(value: unknown, path: string, clusterless: boolean): SessionLifetime {
  const record = requireRecord(value, path);
  rejectUnknown(record, ["performer", "runs"], path);
  if (record.performer === undefined) {
    throw new InvalidDefinitionError(`Missing required field: ${path}.performer`);
  }
  if (!Array.isArray(record.runs) || record.runs.length === 0) {
    throw new InvalidDefinitionError(`"${path}.runs" must contain at least one run.`);
  }
  const performer = validatePerformer(record.performer, `${path}.performer`);
  const runs = record.runs.map((run, index) => validateRun(run, `${path}.runs[${index}]`, clusterless));
  validatePerformerMatchesRuns(performer, runs, path);
  return { performer, runs };
}

/**
 * Catch a mismatched performer + run-type pairing up front (instead of an opaque
 * gRPC "UNIMPLEMENTED" failure at test time): `analytics-functional` runs go
 * through the Analytics test-driver and need an Analytics SDK performer (Columnar
 * SDK or Enterprise Analytics SDK), while operational `functional`/`situational`
 * runs need an operational SDK performer. The performer image was already validated
 * by validatePerformer, so analysePerformerImage here always succeeds.
 */
function validatePerformerMatchesRuns(performer: PerformerSetup, runs: FitRun[], path: string): void {
  const parsed = analysePerformerImage(performer.image);
  if ("error" in parsed) {
    return;
  }
  const performerIsAnalytics = isAnalyticsSdk(parsed.sdk);
  runs.forEach((run, index) => {
    const runIsAnalytics = run.type === "analytics-functional";
    if (runIsAnalytics && !performerIsAnalytics) {
      throw new InvalidDefinitionError(
        `"${path}.runs[${index}]" is an "analytics-functional" run but the performer image "${performer.image}"` +
          ` is an operational SDK (${parsed.sdk.name}). Use an Analytics SDK performer — a Columnar SDK or` +
          ` Enterprise Analytics SDK (e.g. columnar-java-fit-performer or analytics-java-fit-performer).`,
      );
    }
    if (!runIsAnalytics && performerIsAnalytics) {
      throw new InvalidDefinitionError(
        `"${path}.runs[${index}]" is a "${run.type}" run but the performer image "${performer.image}" is an` +
          ` Analytics SDK (${parsed.sdk.name}). Analytics SDKs only run "analytics-functional" tests.`,
      );
    }
  });
}

function validateCluster(value: unknown, path: string): ClusterLifetime {
  const record = requireRecord(value, path);
  rejectUnknown(record, ["sessions", "clusterConfig", "connection", "useExisting", "cbdinocluster"], path);
  if (!Array.isArray(record.sessions) || record.sessions.length === 0) {
    throw new InvalidDefinitionError(`"${path}.sessions" must contain at least one session.`);
  }
  const cluster: ClusterLifetime = {
    sessions: record.sessions.map((session, index) => validateSession(session, `${path}.sessions[${index}]`, false)),
  };
  if (record.clusterConfig !== undefined) {
    if (!isString(record.clusterConfig)) {
      throw new InvalidDefinitionError(`"${path}.clusterConfig" must be a string id; got ${JSON.stringify(record.clusterConfig)}`);
    }
    if (record.connection !== undefined || record.useExisting !== undefined || record.cbdinocluster !== undefined) {
      throw new InvalidDefinitionError(`"${path}" cannot mix "clusterConfig" (ref) with inline cluster fields.`);
    }
    cluster.clusterConfig = record.clusterConfig;
  } else {
    if (record.connection !== undefined) {
      cluster.connection = validateConnection(record.connection, `${path}.connection`);
    }
    if (record.useExisting !== undefined) {
      cluster.useExisting = validateUseExisting(record.useExisting, `${path}.useExisting`);
    }
    if (record.cbdinocluster !== undefined) {
      cluster.cbdinocluster = validateCbdinocluster(record.cbdinocluster, `${path}.cbdinocluster`);
    }
    const modes = [cluster.connection, cluster.useExisting, cluster.cbdinocluster].filter(Boolean);
    if (modes.length !== 1) {
      throw new InvalidDefinitionError(`"${path}" must have exactly one of "connection", "useExisting", or "cbdinocluster".`);
    }
  }
  return cluster;
}

function validateClusterConfigs(value: unknown): ClusterConfigRef[] {
  if (!Array.isArray(value)) {
    throw new InvalidDefinitionError(`"clusterConfigs" must be a list; got ${JSON.stringify(value)}`);
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const path = `clusterConfigs[${index}]`;
    const record = requireRecord(entry, path);
    const id = requireString(record, "id", `${path}.id`);
    if (ids.has(id)) {
      throw new InvalidDefinitionError(`Duplicate clusterConfigs id: "${id}"`);
    }
    ids.add(id);
    rejectUnknown(record, ["id", "connection", "useExisting", "cbdinocluster"], path);
    const ref: ClusterConfigRef = { id };
    if (record.connection !== undefined) {
      ref.connection = validateConnection(record.connection, `${path}.connection`);
    }
    if (record.useExisting !== undefined) {
      ref.useExisting = validateUseExisting(record.useExisting, `${path}.useExisting`);
    }
    if (record.cbdinocluster !== undefined) {
      ref.cbdinocluster = validateCbdinocluster(record.cbdinocluster, `${path}.cbdinocluster`);
    }
    const modes = [ref.connection, ref.useExisting, ref.cbdinocluster].filter(Boolean);
    if (modes.length !== 1) {
      throw new InvalidDefinitionError(`"${path}" must have exactly one of "connection", "useExisting", or "cbdinocluster".`);
    }
    return ref;
  });
}

const CONNECTION_SCHEMES: ConnectionScheme[] = ["couchbase", "couchbases", "couchbase2"];

function validateConnectionScheme(value: unknown, path: string): ConnectionScheme {
  if (!CONNECTION_SCHEMES.includes(value as ConnectionScheme)) {
    throw new InvalidDefinitionError(`"${path}" must be one of ${CONNECTION_SCHEMES.join(", ")}; got ${JSON.stringify(value)}`);
  }
  return value as ConnectionScheme;
}

function validateSchemeAndTls(value: unknown, path: string): SchemeAndTls {
  const record = requireRecord(value, path);
  rejectUnknown(record, ["scheme", "tls"], path);
  return {
    ...(record.scheme !== undefined ? { scheme: validateConnectionScheme(record.scheme, `${path}.scheme`) } : {}),
    ...(record.tls !== undefined ? { tls: record.tls } : {}),
  };
}

function validateFitConnectionSpec(value: unknown, path: string): FitConnectionSpec {
  const record = requireRecord(value, path);
  rejectUnknown(record, ["scheme", "tls", "driver", "performer"], path);
  return {
    ...(record.scheme !== undefined ? { scheme: validateConnectionScheme(record.scheme, `${path}.scheme`) } : {}),
    ...(record.tls !== undefined ? { tls: record.tls } : {}),
    ...(record.driver !== undefined ? { driver: validateSchemeAndTls(record.driver, `${path}.driver`) } : {}),
    ...(record.performer !== undefined ? { performer: validateSchemeAndTls(record.performer, `${path}.performer`) } : {}),
  };
}

function validateFitConfigs(value: unknown): FitConfigRef[] {
  if (!Array.isArray(value)) {
    throw new InvalidDefinitionError(`"fitConfigs" must be a list; got ${JSON.stringify(value)}`);
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const path = `fitConfigs[${index}]`;
    const record = requireRecord(entry, path);
    rejectUnknown(record, ["id", "config", "connection", "patch"], path);
    const id = requireString(record, "id", `${path}.id`);
    if (ids.has(id)) {
      throw new InvalidDefinitionError(`Duplicate fitConfigs id: "${id}"`);
    }
    ids.add(id);
    return {
      id,
      ...(record.config !== undefined ? { config: validateFitConfig(record.config, `${path}.config`) } : {}),
      ...(record.connection !== undefined ? { connection: validateFitConnectionSpec(record.connection, `${path}.connection`) } : {}),
      ...(record.patch !== undefined ? { patch: validateFitConfig(record.patch, `${path}.patch`) } : {}),
    };
  });
}

/** Parses a `{ source: { git: { pr | branch, repo? } } }` block, shared by instance and top-level setup. */
function validateCbdinoclusterSource(value: unknown, path: string): CbdinoclusterSource {
  const src = requireRecord(value, path);
  rejectUnknown(src, ["git"], path);
  const git = requireRecord(src.git, `${path}.git`);
  rejectUnknown(git, ["pr", "branch", "repo"], `${path}.git`);
  const repo = validateOptionalString(git, "repo", `${path}.git.repo`);
  if (git.pr !== undefined && git.branch !== undefined) {
    throw new InvalidDefinitionError(`"${path}.git" must specify only one of "pr" or "branch"`);
  }
  if (git.pr !== undefined) {
    if (typeof git.pr !== "number" || !Number.isInteger(git.pr) || git.pr <= 0) {
      throw new InvalidDefinitionError(`"${path}.git.pr" must be a positive integer; got ${JSON.stringify(git.pr)}`);
    }
    return { git: { pr: git.pr, ...(repo !== undefined ? { repo } : {}) } };
  }
  const branch = validateOptionalString(git, "branch", `${path}.git.branch`);
  if (branch === undefined) {
    throw new InvalidDefinitionError(`"${path}.git" must specify one of "pr" or "branch"`);
  }
  return { git: { branch, ...(repo !== undefined ? { repo } : {}) } };
}

function validateInstanceSetup(value: unknown, path: string): InstanceSetup | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = requireRecord(value, path);
  rejectUnknown(record, ["cbdinocluster", "capellaEnvironment"], path);
  const setup: InstanceSetup = {};
  if (record.cbdinocluster !== undefined) {
    const cbdinocluster = requireRecord(record.cbdinocluster, `${path}.cbdinocluster`);
    rejectUnknown(cbdinocluster, ["init"], `${path}.cbdinocluster`);
    const cbdinoclusterSetup: InstanceSetup["cbdinocluster"] = {};
    if (cbdinocluster.init !== undefined) {
      cbdinoclusterSetup.init = validateCbdinoclusterInit(cbdinocluster.init, `${path}.cbdinocluster.init`);
    }
    setup.cbdinocluster = cbdinoclusterSetup;
  }
  const capellaEnvironment = optionalEnvironmentName(record, "capellaEnvironment", path);
  if (capellaEnvironment !== undefined) {
    setup.capellaEnvironment = capellaEnvironment;
  }
  return setup;
}

function validateInstance(value: unknown, index: number): InstanceLifetime {
  const path = `instances[${index}]`;
  const record = requireRecord(value, path);
  rejectUnknown(record, ["aws", "gcp", "localhost", "setup", "clusters", "clusterlessSessions", "cbdinocluster"], path);
  const hasAws = record.aws !== undefined;
  const hasGcp = record.gcp !== undefined;
  const hasLocalhost = record.localhost !== undefined;
  if (Number(hasAws) + Number(hasGcp) + Number(hasLocalhost) !== 1) {
    throw new InvalidDefinitionError(`"${path}" must have exactly one of "aws", "gcp" or "localhost".`);
  }
  const clusters = Array.isArray(record.clusters)
    ? record.clusters.map((cluster, clusterIndex) => validateCluster(cluster, `${path}.clusters[${clusterIndex}]`))
    : (() => {
        throw new InvalidDefinitionError(`"${path}.clusters" must be a list; got ${JSON.stringify(record.clusters)}`);
      })();
  const clusterlessSessions = record.clusterlessSessions === undefined
    ? undefined
    : Array.isArray(record.clusterlessSessions)
      ? record.clusterlessSessions.map((session, sessionIndex) =>
          validateSession(session, `${path}.clusterlessSessions[${sessionIndex}]`, true),
        )
      : (() => {
          throw new InvalidDefinitionError(`"${path}.clusterlessSessions" must be a list when present.`);
        })();
  const instance: InstanceLifetime = {
    ...(hasAws
      ? { aws: validateAwsInstance(record.aws, `${path}.aws`) }
      : hasGcp
        ? { gcp: validateGcpInstance(record.gcp, `${path}.gcp`) }
        : { localhost: validateLocalhostInstance(record.localhost, `${path}.localhost`) }),
    clusters,
  };
  if (record.cbdinocluster !== undefined) {
    throw new InvalidDefinitionError(
      `"${path}.cbdinocluster" is no longer accepted — cbdinocluster init moved to ${path}.setup.cbdinocluster.init (set up once per instance).`,
    );
  }
  const setup = validateInstanceSetup(record.setup, `${path}.setup`);
  if (setup !== undefined) {
    instance.setup = setup;
  }
  if (clusterlessSessions !== undefined) {
    if (clusterlessSessions.length === 0) {
      throw new InvalidDefinitionError(`"${path}.clusterlessSessions" must contain at least one session when present.`);
    }
    instance.clusterlessSessions = clusterlessSessions;
  }
  if (clusters.length === 0 && (instance.clusterlessSessions?.length ?? 0) === 0) {
    throw new InvalidDefinitionError(`"${path}" must contain at least one cluster or clusterless session.`);
  }
  return instance;
}

function validateVersion(version: unknown): number {
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new InvalidDefinitionError(`Missing or invalid "version" (expected an integer); got ${JSON.stringify(version)}`);
  }
  if (version > CURRENT_FIT_DEFINITION_VERSION) {
    throw new UnsupportedDefinitionVersionError(
      `This definition file is version ${version}, but this fit-cli only understands up to version ${CURRENT_FIT_DEFINITION_VERSION}. Update fit-cli (git pull) to run it.`,
    );
  }
  if (version < CURRENT_FIT_DEFINITION_VERSION) {
    throw new UnsupportedDefinitionVersionError(
      `Definition file version ${version} is no longer supported. Recreate it as version ${CURRENT_FIT_DEFINITION_VERSION}.`,
    );
  }
  return version;
}

export function validateDefinition(raw: unknown): FitDefinition {
  if (!isRecord(raw)) {
    throw new InvalidDefinitionError("Definition file must be an object at the top level.");
  }
  rejectUnknown(raw, ["version", "type", "description", "setup", "instances", "clusterConfigs", "fitConfigs", "cycles", "iterations"], "(top level)");
  validateVersion(raw.version);
  if (raw.type !== FIT_DEFINITION_TYPE) {
    throw new InvalidDefinitionError(`Expected "type: ${FIT_DEFINITION_TYPE}"; got ${JSON.stringify(raw.type)}`);
  }
  if (raw.cycles !== undefined) {
    throw new InvalidDefinitionError(`"cycles" is no longer supported; rewrite the file to use top-level "instances".`);
  }
  if (raw.iterations !== undefined) {
    throw new InvalidDefinitionError(`"iterations" is no longer supported; rewrite the file to use "sessions[].runs".`);
  }
  if (!Array.isArray(raw.instances)) {
    throw new InvalidDefinitionError(`"instances" must be a list; got ${JSON.stringify(raw.instances)}`);
  }
  if (raw.instances.length === 0) {
    throw new InvalidDefinitionError(`"instances" must contain at least one instance.`);
  }
  return {
    version: CURRENT_FIT_DEFINITION_VERSION,
    type: FIT_DEFINITION_TYPE,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(raw.setup !== undefined ? { setup: validateSharedSetup(raw.setup) } : {}),
    instances: raw.instances.map(validateInstance),
    ...(raw.clusterConfigs !== undefined ? { clusterConfigs: validateClusterConfigs(raw.clusterConfigs) } : {}),
    ...(raw.fitConfigs !== undefined ? { fitConfigs: validateFitConfigs(raw.fitConfigs) } : {}),
  };
}

export type DefinitionFormat = "json5" | "yaml";

export function detectDefinitionFormat(path: string): DefinitionFormat {
  if (/\.json5$/i.test(path)) return "json5";
  if (/\.ya?ml$/i.test(path)) return "yaml";
  return "json5";
}

/** Parse raw text into an unknown object without validating the schema. */
export function parseDefinitionRaw(text: string, format?: DefinitionFormat): unknown {
  if (format === "yaml") {
    try { return YAML.parse(text); }
    catch (err) { throw new InvalidDefinitionError(`Could not parse YAML: ${(err as Error).message}`); }
  }
  if (format === "json5") {
    try { return JSON5.parse(text); }
    catch (err) { throw new InvalidDefinitionError(`Could not parse JSON5: ${(err as Error).message}`); }
  }
  let json5Err: Error;
  try { return JSON5.parse(text); }
  catch (err) {
    json5Err = err as Error;
    try { return YAML.parse(text); }
    catch (yamlErr) {
      throw new InvalidDefinitionError(`Could not parse definition file as JSON5 (${json5Err.message}) or YAML (${(yamlErr as Error).message})`);
    }
  }
}

export function parseDefinition(text: string, format?: DefinitionFormat): FitDefinition {
  let raw: unknown;
  if (format === "yaml") {
    try {
      raw = YAML.parse(text);
    } catch (err) {
      throw new InvalidDefinitionError(`Could not parse YAML: ${(err as Error).message}`);
    }
  } else if (format === "json5") {
    try {
      raw = JSON5.parse(text);
    } catch (err) {
      throw new InvalidDefinitionError(`Could not parse JSON5: ${(err as Error).message}`);
    }
  } else {
    let json5Err: Error;
    try {
      raw = JSON5.parse(text);
    } catch (err) {
      json5Err = err as Error;
      try {
        raw = YAML.parse(text);
      } catch (yamlErr) {
        throw new InvalidDefinitionError(
          `Could not parse definition file as JSON5 (${json5Err.message}) or YAML (${(yamlErr as Error).message})`,
        );
      }
    }
  }
  return validateDefinition(raw);
}

export function loadDefinition(path: string): FitDefinition {
  return parseDefinition(readFileSync(path, "utf8"), detectDefinitionFormat(path));
}

export function isDefinitionUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

// GitHub renders a `#file-<name>` fragment on a gist page URL when it links to one
// file of a multi-file gist, with every non-alphanumeric character (including the
// extension's `.`) turned into `-`. We only need enough of that convention back to
// guess the definition format for local caching — the `-json5` / `-yaml` / `-yml`
// suffix — not the exact original filename.
const GIST_FRAGMENT_FORMAT_PATTERN = /-(json5|ya?ml)$/i;

function gistFormatHintFromFragment(hash: string): DefinitionFormat | undefined {
  const match = GIST_FRAGMENT_FORMAT_PATTERN.exec(hash.replace(/^#file-/, ""));
  if (!match) return undefined;
  return match[1].toLowerCase().startsWith("json5") ? "json5" : "yaml";
}

function basenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "gist.github.com") {
      const formatHint = gistFormatHintFromFragment(parsed.hash);
      if (formatHint) return `gist.${formatHint}`;
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.at(-1) ?? "definition.json5";
  } catch {
    return "definition.json5";
  }
}

/**
 * A gist.github.com page URL (e.g. `https://gist.github.com/user/<id>`) is the HTML
 * gist page, not fetchable definition content — it needs rewriting to gist's raw-
 * content URL, mirroring the recipe in run-guidance.ts. Any other URL passes through
 * unchanged (e.g. an already-raw gist URL, or a plain https:// definition link).
 */
export function normalizeDefinitionUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.hostname !== "gist.github.com") return url;
  const [user, id] = parsed.pathname.split("/").filter(Boolean);
  if (!user || !id) return url;
  return `https://gist.githubusercontent.com/${user}/${id}/raw`;
}

/** Stable local cache path for a URL: ~/.fit-cli/url-cache/<12-char-hash>/<basename> */
export function localPathForUrl(url: string, home: string = homedir()): string {
  const slug = createHash("sha256").update(url).digest("hex").slice(0, 12);
  return join(home, ".fit-cli", "url-cache", slug, basenameFromUrl(url));
}

/**
 * Fetch a definition file from a URL, write it to a stable local cache path, and
 * return that path. The stable path means resume state written next to it can be
 * found again when the same URL is passed to a later `--resume-at` invocation.
 * A gist.github.com page URL is rewritten to its raw-content URL before fetching
 * (see {@link normalizeDefinitionUrl}); the cache path is keyed off the original
 * URL so both forms of the same gist link reuse the same cache entry.
 */
export async function cacheDefinition(url: string): Promise<string> {
  const fetchUrl = normalizeDefinitionUrl(url);
  let text: string;
  try {
    const response = await fetch(fetchUrl);
    if (!response.ok) {
      throw new InvalidDefinitionError(
        `Failed to fetch definition from ${fetchUrl}: HTTP ${response.status} ${response.statusText}`,
      );
    }
    text = await response.text();
  } catch (err) {
    if (err instanceof InvalidDefinitionError) throw err;
    throw new InvalidDefinitionError(`Failed to fetch definition from ${fetchUrl}: ${(err as Error).message}`);
  }
  const localPath = localPathForUrl(url);
  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, text, "utf8");
  return localPath;
}

function countSessionRuns(session: { runs: { repeat?: number }[] }): number {
  return session.runs.reduce((total, run) => total + (run.repeat ?? 1), 0);
}

export function countRuns(definition: FitDefinition): number {
  return definition.instances.reduce(
    (total, instance) =>
      total +
      instance.clusters.reduce(
        (clusterTotal, cluster) => clusterTotal + cluster.sessions.reduce((sessionTotal, session) => sessionTotal + countSessionRuns(session), 0),
        0,
      ) +
      (instance.clusterlessSessions?.reduce((sessionTotal, session) => sessionTotal + countSessionRuns(session), 0) ?? 0),
    0,
  );
}

/**
 * Resolve a path-or-URL to a local definition file (fetching and caching URLs)
 * and load it. Shared by `fit run` and `fit definition validate`.
 */
export async function resolveAndLoadDefinition(pathOrUrl: string): Promise<{ resolvedPath: string; definition: FitDefinition }> {
  if (isDefinitionUrl(pathOrUrl)) {
    console.log(`Fetching definition from ${pathOrUrl}...`);
  }
  const resolvedPath = isDefinitionUrl(pathOrUrl) ? await cacheDefinition(pathOrUrl) : pathOrUrl;
  const definition = loadDefinition(resolvedPath);
  return { resolvedPath, definition };
}

/** One-line "✓ Valid …" summary of a parsed definition, for run/validate output. */
export function definitionSummary(definition: FitDefinition): string {
  return (
    `✓ Valid ${FIT_DEFINITION_TYPE} definition (version ${definition.version}, ` +
    `${definition.instances.length} instance(s), ${countRuns(definition)} run(s)).`
  );
}

function buildHelp(): string {
  return `Validate a fit definition file and print the parsed result.

Primary usage:
  ${runScriptPrefix("definition")} validate <file.json5>

Direct invocation (for debugging):
  bun src/fit/shared/definition/parse-definition.ts <file.json5>
  bun src/fit/shared/definition/parse-definition.ts --help

Both .json5 and .yaml definition files are accepted.
Exits 0 and prints the normalised definition as JSON if the file is valid;
exits 1 with an explanation otherwise.`;
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const path = process.argv[2];
    if (!path || path === "--help" || path === "-h") {
      console.log(buildHelp());
      if (!path) process.exit(2);
      return Promise.resolve();
    }
    const definition = loadDefinition(path);
    console.log(
      `✓ Valid ${FIT_DEFINITION_TYPE} definition (version ${definition.version}, ${definition.instances.length} instance(s), ${countRuns(definition)} run(s)).`,
    );
    return Promise.resolve();
  });
}
