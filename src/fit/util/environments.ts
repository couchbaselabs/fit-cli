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
import type { CbdinoclusterSourceGit } from "../shared/definition/types.js";

export interface CapellaEnvironment {
  endpoint?: string | null;
  /** Capella Management API v4 endpoint for this environment. */
  v4Endpoint?: string | null;
  oid?: string | null;
  /** The (shared, non-secret) Capella account username for this environment. */
  username?: string | null;
  /**
   * AWS Secrets Manager id/ARN holding { password, apiKey, apiSecret,
   * internalSupportToken?, overrideToken? } for this Capella environment. The two
   * tokens are optional — only "dev" and the "sandbox" env currently have them (stage/prod leave
   * them undefined), which is what gates cbcollect support there. A sandbox's secret holds only
   * those two tokens.
   */
  secretId?: string | null;
  /**
   * A pre-deployed sandbox: endpoint/v4Endpoint/oid are null here and supplied per run via
   * {@link applyCapellaEnvironmentOverrides}; credentials come from the CAPELLA_* env vars.
   */
  sandbox?: boolean;
}

/** A sandbox's per-run coordinates, carried in the definition file since they change on redeploy. */
export interface CapellaEnvironmentOverride {
  endpoint: string;
  v4Endpoint: string;
  oid: string;
}

// Scheme + host only: these get concatenated with API paths, so a path would corrupt them, and `@`
// is excluded so `https://user:pass@host` can't smuggle a credential into the shareable definition.
const CAPELLA_ENDPOINT_ORIGIN = /^https?:\/\/[^\s/?#@]+$/i;
/** Canonical 8-4-4-4-12 hex form; shape only, so an org id issued any way passes. */
const CAPELLA_ORGANIZATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Endpoints derived from a sandbox URL; `recognised` is false when the host wasn't a ui./api./cloudapi.
 * one. These live beside {@link CapellaEnvironmentOverride} so the wizard (which asks for the values)
 * and the parser (which accepts them) share one rule set without importing each other.
 */
export interface CapellaSandboxEndpoints {
  endpoint: string;
  v4Endpoint: string;
  recognised: boolean;
}

/** Whether `value` is a usable control-plane endpoint (scheme + host, no path) for a definition file. */
export function isCapellaEndpointOrigin(value: string): boolean {
  return CAPELLA_ENDPOINT_ORIGIN.test(value.trim());
}

/** Whether `value` is a bare Capella org id — rejects the `oid=<uuid>` a UI URL paste carries. */
export function isCapellaOrganizationId(value: string): boolean {
  return CAPELLA_ORGANIZATION_ID.test(value.trim());
}

/** `url` reduced to its origin, dropping any path/query/fragment. Returned trimmed if it has no host. */
export function capellaEndpointOrigin(url: string): string {
  const match = /^(https?:\/\/[^\s/?#@]+)/i.exec(url.trim());
  return match ? match[1].toLowerCase() : url.trim().replace(/\/+$/, "");
}

/**
 * A `scheme://<ui|api|cloudapi>.host` origin split into its scheme and bare host, or null when the
 * host carries no such label. The single source of truth for the sandbox host layout — a sandbox
 * serves `ui.` (UI), `api.` (v2) and `cloudapi.` (v4) on one domain — so every caller that swaps one
 * label for another agrees on what a labelled host is. The `(?=[/?#]|$)` lookahead makes a userinfo
 * URL (https://ui.u:p@host) fail outright rather than truncate at the "@".
 */
export function capellaLabelledOrigin(origin: string): { scheme: string; host: string } | null {
  const match = /^(https?:\/\/)(?:ui|api|cloudapi)\.([^\s/?#@]+)(?=[/?#]|$)/i.exec(origin.trim().replace(/\/+$/, ""));
  return match ? { scheme: match[1].toLowerCase(), host: match[2].toLowerCase() } : null;
}

/**
 * Both control-plane endpoints for a sandbox URL, whichever of its `ui.`/`api.`/`cloudapi.` hosts the
 * user pasted. An unlabelled host can't be rewritten, so it's returned as-is with `recognised: false`.
 */
export function deriveCapellaSandboxEndpoints(url: string): CapellaSandboxEndpoints {
  const trimmed = url.trim().replace(/\/+$/, "");
  const parts = capellaLabelledOrigin(trimmed);
  if (!parts) return { endpoint: trimmed, v4Endpoint: trimmed, recognised: false };
  return {
    endpoint: `${parts.scheme}api.${parts.host}`,
    v4Endpoint: `${parts.scheme}cloudapi.${parts.host}`,
    recognised: true,
  };
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

export interface GcpDefaults {
  /** The GCP project fit-cli operates in. */
  project?: string | null;
  /** The single GCP region fit-cli operates in (must match cbdinocluster's DEFAULT_GCP_REGION, us-west1, so the box and Capella's PSC endpoint share a region). */
  region?: string | null;
  /** Zone within `region` the test box is launched into. */
  zone?: string | null;
  /** The VPC network the box must sit in for PSC to bind to it. */
  network?: string | null;
  /** Subnet within that network. */
  subnet?: string | null;
  /** Service account attached to launched instances; ADC on the box resolves to it. */
  serviceAccountEmail?: string | null;
}

/** The ephemeral Capella API key pool a remote run creates for itself. */
export interface CapellaKeyPoolDefaults {
  /** Whether remote runs create a pool at all. */
  enabled: boolean;
  /** How many extra API keys the pool holds, on top of the primary key. */
  size: number;
  /** How long a pooled key lives, in days, if teardown never removes it. */
  expiryDays: number;
}

/** Global version defaults for cbdinocluster and related tools (not per-environment). */
export interface Defaults {
  /** Default Couchbase Server version, e.g. "8.0-stable" or a pinned build. */
  clusterVersion: string;
  /** The previous server release line, for presets spanning two release lines. */
  previousClusterVersion: string;
  /** The upcoming server release line, not yet used by any preset. */
  nextClusterVersion: string;
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
  /**
   * Default cbdinocluster build installed onto remote boxes: either a GitHub
   * release tag (e.g. "v0.0.120"), or a {@link CbdinoclusterSourceGit} object
   * to build from a PR or branch instead (e.g. `{ pr: 123 }` or
   * `{ branch: "my-fix" }`).
   */
  cbdinoclusterVersion: string | CbdinoclusterSourceGit;
  /** The per-run Capella API key pool cbdinocluster creates on the remote box. */
  capellaKeyPool: CapellaKeyPoolDefaults;
  /** AWS account and network settings. */
  aws: AwsDefaults;
  /** GCP account and network settings. */
  gcp?: GcpDefaults;
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

/** Whether `name` is a sandbox Capella environment (see {@link CapellaEnvironment.sandbox}). */
export function isSandboxCapellaEnvironment(
  name: string,
  environments: EnvironmentsFile = loadEnvironments(),
): boolean {
  return environments.capella[name]?.sandbox === true;
}

/**
 * Patch sandbox coordinates from a definition's `setup.capellaEnvironments` into the (process-cached)
 * registry, so every consumer reads them like a normal environment. Rewrites every sandbox each call,
 * so a later definition supplying none can't inherit an earlier one's. Throws for an unknown/non-sandbox
 * name (validated before anything is mutated).
 */
export function applyCapellaEnvironmentOverrides(
  overrides: Record<string, CapellaEnvironmentOverride>,
  environments: EnvironmentsFile = loadEnvironments(),
): void {
  for (const name of Object.keys(overrides)) {
    const entry = environments.capella[name];
    if (!entry) {
      throw new Error(`Unknown Capella environment "${name}" — not defined in environments.json5.`);
    }
    if (entry.sandbox !== true) {
      throw new Error(
        `Capella environment "${name}" is not a sandbox, so its endpoint and org id can't be set from a definition file.`,
      );
    }
  }
  for (const [name, entry] of Object.entries(environments.capella)) {
    if (entry.sandbox !== true) continue;
    const override = overrides[name];
    entry.endpoint = override?.endpoint ?? null;
    entry.v4Endpoint = override?.v4Endpoint ?? null;
    entry.oid = override?.oid ?? null;
  }
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

/** The configured AWS tenant aliases (e.g. ["cb-sdk"]). */
export function awsTenantAliases(environments: EnvironmentsFile = loadEnvironments()): string[] {
  return Object.keys(environments.awsTenants);
}
