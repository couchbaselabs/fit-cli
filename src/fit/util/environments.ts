/**
 * Loader for `environments.json5` (repo root): the non-secret, per-environment
 * settings selected from a definition file, plus global defaults. Sections:
 *   - defaults: global version strings for cbdinocluster (cluster, CNG, Analytics, CAO)
 *   - testSets: the test set each preset tier runs (see TestSets)
 *   - capella: control-plane endpoint + org id per Capella environment (dev/stage/…)
 *   - results: the hosted results host per results environment (dev/prod/…), which
 *     serves both the Postgres DB and the results UI.
 *
 * Secrets are deliberately NOT here — they come from the environment at run time
 * (see resolveCapellaConfig / resolveResultsDbCredentials). A `null` value means the
 * block exists but hasn't been provisioned yet; selecting it fails fast.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";

export interface CapellaEnvironment {
  endpoint?: string | null;
  oid?: string | null;
  /** The (shared, non-secret) Capella account username for this environment. */
  username?: string | null;
  /** AWS Secrets Manager id/ARN holding { password } for this Capella environment. */
  secretId?: string | null;
}

export interface ResultsEnvironment {
  host?: string | null;
  /** The (non-secret) Postgres role fit-cli and the FIT driver connect as. */
  username?: string | null;
  /** AWS Secrets Manager id/ARN holding { password } for this results environment. */
  secretId?: string | null;
}

/** An AWS account fit-cli-role's trust policy allows a human to assume it from. */
export interface AwsTenantEnvironment {
  accountId: string;
}

/** The shared role fit-cli assumes for EC2/situational work, and the account it lives in. */
export interface FitCliRoleEnvironment {
  accountId: string;
  roleName: string;
}

export interface AwsDefaults {
  /** The single AWS region fit-cli operates in. */
  region: string;
  /** The VPC fit-cli launches instances into. */
  vpcId: string;
  /** Public subnet within that VPC (MapPublicIpOnLaunch=true). */
  subnetId: string;
  /**
   * Default SG of the fit-cli VPC; Capella's PrivateLink endpoint lands here, so
   * instances need to be in it too (see `aws.privateEndpoint` on an instance).
   */
  privateEndpointVpcSgId?: string | null;
  /**
   * IAM instance profile (name) attached to FIT-launched instances so the SSM
   * Agent can register and send command output to CloudWatch Logs. Unset until
   * the profile exists in AWS — see fit-instance.ts.
   */
  ssmInstanceProfileName?: string | null;
}

/** Global version defaults for cbdinocluster and related tools (not per-environment). */
export interface Defaults {
  /** Default Couchbase Server version, e.g. "8.0-stable" or a pinned build. */
  clusterVersion: string;
  /** The previous server release line, for presets spanning two release lines. */
  previousClusterVersion: string;
  /** Default Couchbase Server version for CNG/OpenShift (cb-rhcc registry). */
  cngClusterVersion: string;
  /** Default self-managed Enterprise Analytics build. */
  enterpriseAnalyticsVersion: string;
  /** Default Couchbase Autonomous Operator version for the cao deployer. */
  caoOperatorVersion: string;
  /** Default Cloud Native Gateway (Protostellar gateway) version. */
  cngVersion: string;
  /** Default Couchbase Server version for Capella cloud clusters. */
  capellaClusterVersion: string;
  /** The previous Capella release line, for presets spanning two release lines. */
  capellaPreviousClusterVersion: string;
  /** Default Capella environment key (a key under `capella` in this file). */
  defaultCapellaEnvironment: string;
  /** Default results environment key (a key under `results` in this file). */
  defaultResultsEnvironment: string;
  /** AWS account and network settings. */
  aws: AwsDefaults;
}

/**
 * The test set each preset tier runs, referenced from preset templates as
 * `{{environments.testSets.<NAME>}}`. Values are single selectors: a test-driver class
 * name for the sanity tiers, a named test preset (TEST_PRESETS) for the others.
 */
export interface TestSets {
  SITUATIONAL_SET_SANITY: string;
  /** CNG-specific situational sanity: SanityTest can't run on CNG (it hardcodes cbdino). */
  SITUATIONAL_CNG_SET_SANITY: string;
  SITUATIONAL_SET_LITE: string;
  SITUATIONAL_SET_RELEASE: string;
  FUNCTIONAL_SET_SANITY: string;
  FUNCTIONAL_SET_LITE: string;
  FUNCTIONAL_SET_RELEASE: string;
}

export interface EnvironmentsFile {
  defaults: Defaults;
  testSets: TestSets;
  capella: Record<string, CapellaEnvironment>;
  results: Record<string, ResultsEnvironment>;
  awsTenants: Record<string, AwsTenantEnvironment>;
  fitCliRole: FitCliRoleEnvironment;
}

/** Absolute path to the repo-root environments file (this module lives at src/fit/util/). */
export const DEFAULT_ENVIRONMENTS_PATH = fileURLToPath(new URL("../../../environments.json5", import.meta.url));

let cached: EnvironmentsFile | undefined;
const bundledDefaultEnvironmentsPath = import.meta.url.includes("/$bunfs/")
  ? (
      await import("../../../environments.json5", {
        with: { type: "file" },
      }) as { default: string }
    ).default
  : undefined;

/** Load and validate the environments file. Cached when reading the default path. */
export function loadEnvironments(path: string = DEFAULT_ENVIRONMENTS_PATH): EnvironmentsFile {
  if (path === DEFAULT_ENVIRONMENTS_PATH && cached) return cached;
  const resolvedPath = path === DEFAULT_ENVIRONMENTS_PATH && import.meta.url.includes("/$bunfs/")
    ? (bundledDefaultEnvironmentsPath ?? path)
    : path;
  const text = readFileSync(resolvedPath, "utf8");
  const parsed = JSON5.parse<EnvironmentsFile>(text);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.defaults !== "object" ||
    typeof parsed.testSets !== "object" ||
    typeof parsed.capella !== "object" ||
    typeof parsed.results !== "object" ||
    typeof parsed.awsTenants !== "object" ||
    typeof parsed.fitCliRole !== "object"
  ) {
    throw new Error(
      `Environments file at ${path} must define "defaults", "testSets", "capella", "results", "awsTenants", and "fitCliRole" sections.`,
    );
  }
  if (path === DEFAULT_ENVIRONMENTS_PATH) cached = parsed;
  return parsed;
}

/** The configured Capella environment names (e.g. ["dev", "stage"]). */
export function capellaEnvironmentNames(environments: EnvironmentsFile = loadEnvironments()): string[] {
  return Object.keys(environments.capella);
}

/** The configured results environment names (e.g. ["dev", "prod"]). */
export function resultsEnvironmentNames(environments: EnvironmentsFile = loadEnvironments()): string[] {
  return Object.keys(environments.results);
}

/** The tenant alias (e.g. "cb-sdk") for an AWS account id, or undefined if it's not a known tenant. */
export function awsTenantAliasForAccount(
  accountId: string,
  environments: EnvironmentsFile = loadEnvironments(),
): string | undefined {
  return Object.entries(environments.awsTenants).find(([, tenant]) => tenant.accountId === accountId)?.[0];
}

/** The configured AWS tenant aliases (e.g. ["cb-sdk", "cb-qe"]). */
export function awsTenantAliases(environments: EnvironmentsFile = loadEnvironments()): string[] {
  return Object.keys(environments.awsTenants);
}
