/**
 * Loader for `environments.json5` (repo root): the non-secret, per-environment
 * settings selected from a definition file, plus global defaults. Sections:
 *   - defaults: global version strings for cbdinocluster (cluster, CNG, Analytics, CAO)
 *   - externalServices: settings for the services fit-cli starts itself, e.g. the otel stack
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
import { UUID_RE } from "../../util/non-fit/uuid.js";

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
   * tokens are optional — only "dev" and the sandbox currently have them, which is what
   * makes cbcollect support available there. A sandbox's secret holds only the tokens.
   */
  secretId?: string | null;
  /** A pre-deployed sandbox: nothing about its control plane is pinned here (see capellaControlPlane). */
  sandbox?: boolean;
  /** Domains a {@link sandbox}'s per-run endpoint must fall under (see assertTrustedCapellaHost). */
  endpointSuffixes?: string[] | null;
}

/**
 * Parse `value` as an https Capella URL, or null. The URL parser does the work a regex can't:
 * `https://api.x.example.com:notaport` and `https://%` look fine delimiter-wise but are not URLs.
 * Requires https, a host and no userinfo.
 */
function parseCapellaUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname) return null;
  if (url.username || url.password) return null;
  return url;
}

export function isCapellaOrganizationId(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/**
 * A sandbox's v4 and v2 control-plane origins from the URL given as its CAPELLA_V4_ENDPOINT, or null.
 * A sandbox serves `ui.`, `api.` (v2) and `cloudapi.` (v4) on one domain, so whichever of its https URLs
 * is to hand (e.g. the UI URL `fit sandbox deploy` prints, or any page a browser shows) yields both
 * origins. They're rebuilt from the parsed host, so a path, query or fragment is dropped rather than
 * carried into the endpoint cbdinocluster appends API paths to.
 */
export function sandboxControlPlaneOrigins(value: string): { endpoint: string; v4Endpoint: string } | null {
  const domain = /^(?:ui|api|cloudapi)\.(.+)$/.exec(parseCapellaUrl(value)?.host ?? "")?.[1];
  return domain ? { endpoint: `https://api.${domain}`, v4Endpoint: `https://cloudapi.${domain}` } : null;
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
  /** The upcoming (pre-GA) server release line, used by the on-prem functional presets. */
  nextClusterVersion: string;
  /** Default Couchbase Server version for CNG/OpenShift (cb-rhcc registry). */
  cngClusterVersion: string;
  /** The previous (GA) CNG server line, run by every CNG functional preset. */
  cngPreviousClusterVersion: string;
  /** Default self-managed Enterprise Analytics build. */
  enterpriseAnalyticsVersion: string;
  /** Default self-managed Operational Insights build. */
  operationalInsightsVersion: string;
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

/** Pinned image tags for fit-cli's ephemeral per-box observability stack. */
export interface OtelDefaults {
  /** Pinned otel/opentelemetry-collector-contrib image tag. */
  collectorVersion: string;
  /**
   * Pinned jaegertracing/all-in-one image tag — MUST be a 1.x tag. Jaeger 2.x
   * reorganizes the io.jaegertracing.api_v2 gRPC query API and badger storage
   * semantics the driver's fetchJaeger depends on; a floating/unpinned tag
   * would silently roll onto it.
   */
  jaegerVersion: string;
  /** Pinned prom/prometheus image tag. */
  prometheusVersion: string;
}

/** Settings for the services fit-cli starts alongside a run (see src/fit/external-services/). */
export interface ExternalServicesDefaults {
  otel: OtelDefaults;
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
  externalServices: ExternalServicesDefaults;
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
    typeof parsed.externalServices !== "object" ||
    typeof parsed.testSets !== "object" ||
    typeof parsed.capella !== "object" ||
    typeof parsed.results !== "object" ||
    typeof parsed.awsTenants !== "object" ||
    typeof parsed.fitCliRole !== "object"
  ) {
    throw new Error(
      `Environments file at ${path} must define "defaults", "externalServices", "testSets", "capella", "results", "awsTenants", and "fitCliRole" sections.`,
    );
  }
  if (path === DEFAULT_ENVIRONMENTS_PATH) cached = parsed;
  return parsed;
}

/** The configured Capella environment names (e.g. ["dev", "stage"]). */
export function capellaEnvironmentNames(environments: EnvironmentsFile = loadEnvironments()): string[] {
  return Object.keys(environments.capella);
}

export function isSandboxCapellaEnvironment(
  name: string,
  environments: EnvironmentsFile = loadEnvironments(),
): boolean {
  return environments.capella[name]?.sandbox === true;
}

/** Where a Capella environment's control plane is. `endpoint` is the v2 one, used only for the optional v2 login. */
export interface CapellaControlPlane {
  endpoint?: string;
  v4Endpoint?: string;
  oid?: string;
}

/**
 * Where `entry`'s control plane is. A standing environment's is pinned in this file. A sandbox's is
 * recreated too often to pin, so it comes from CAPELLA_V4_ENDPOINT/CAPELLA_OID; its endpoints are left
 * unset unless CAPELLA_V4_ENDPOINT is one of its `ui.`/`api.`/`cloudapi.` URLs (see sandboxControlPlaneOrigins).
 */
export function capellaControlPlane(entry: CapellaEnvironment, env: NodeJS.ProcessEnv = process.env): CapellaControlPlane {
  if (entry.sandbox !== true) {
    return {
      endpoint: entry.endpoint?.trim() || undefined,
      v4Endpoint: entry.v4Endpoint?.trim() || undefined,
      oid: entry.oid?.trim() || undefined,
    };
  }
  const origins = sandboxControlPlaneOrigins(env.CAPELLA_V4_ENDPOINT ?? "");
  return {
    endpoint: origins?.endpoint,
    v4Endpoint: origins?.v4Endpoint,
    oid: env.CAPELLA_OID?.trim() || undefined,
  };
}

/**
 * A sandbox endpoint receives this run's Capella credentials and the shared support tokens, so it
 * must be under one of the environment's `endpointSuffixes` domains: a mistyped or pasted
 * CAPELLA_V4_ENDPOINT shouldn't send them elsewhere. Fails closed when no domain is configured.
 */
export function assertTrustedCapellaHost(name: string, hostname: string, suffixes: string[] | null | undefined): void {
  const domains = (suffixes ?? []).map((suffix) => suffix.trim().replace(/^\./, "").toLowerCase()).filter(Boolean);
  if (domains.length === 0) {
    throw new Error(`Capella environment "${name}" has no endpointSuffixes in environments.json5, so no endpoint is trusted for it.`);
  }
  const host = hostname.toLowerCase();
  if (!domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    throw new Error(
      `Capella environment "${name}" endpoint host "${host}" is not under ${domains.join(", ")}. ` +
        `A sandbox endpoint receives this run's Capella credentials, so only those domains are accepted; ` +
        `add the domain to environments.json5 if this sandbox is legitimately served elsewhere.`,
    );
  }
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
