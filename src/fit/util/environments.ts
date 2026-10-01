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
  secretId?: string | null;
  sandbox?: boolean;
  /**
   * Host suffixes a {@link sandbox}'s per-run endpoints must fall under. A sandbox's control plane
   * comes from a definition file or the environment, and the run then sends CAPELLA_USER/PASS and
   * the v4 API key to it — so a shared or CI-supplied definition could otherwise point those
   * credentials at an attacker's HTTPS host. Leave unset only for an environment whose endpoints
   * are pinned in this file and therefore already trusted.
   */
  endpointSuffixes?: string[] | null;
}

export interface CapellaEnvironmentOverride {
  endpoint: string;
  v4Endpoint: string;
  oid: string;
}

// Origin host chars: no whitespace, `/?#` or backslash (a path would corrupt concatenated API paths,
// and WHATWG URL parsing treats `\` as `/`, so a backslash smuggles one past an origin-only check) and

export interface CapellaSandboxEndpoints {
  endpoint: string;
  v4Endpoint: string;
  recognised: boolean;
}

/**
 * Parse `value` as a Capella endpoint origin, or null. The URL parser does the work a regex can't:
 * `https://api.x.example.com:notaport` and `https://%` look fine delimiter-wise but are not URLs.
 * Requires https, a host, no userinfo (which would smuggle a credential into a shareable
 * definition file) and no path/query/fragment (these get concatenated with API paths).
 */
function parseCapellaOrigin(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname) return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  return url;
}

export function isCapellaEndpointOrigin(value: string): boolean {
  const trimmed = value.trim();
  // `new URL` tolerates a trailing slash; the stored form must not carry one.
  return !trimmed.endsWith("/") && parseCapellaOrigin(trimmed) !== null;
}

export function isCapellaOrganizationId(value: string): boolean {
  // A Capella org id is a plain UUID, so reuse the canonical pattern rather than restating it.
  return UUID_RE.test(value.trim());
}

/**
 * Whether `value` is acceptable as the URL a user pastes for a sandbox. Unlike
 * {@link isCapellaEndpointOrigin} a path is allowed — a browser UI URL is the expected input, and
 * {@link deriveCapellaSandboxEndpoints} drops the path.
 */
export function isCapellaSandboxUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
}

/** `url` reduced to its origin (scheme + host + any port), or the trimmed input if it won't parse. */
export function capellaEndpointOrigin(url: string): string {
  const trimmed = url.trim();
  try {
    return new URL(trimmed).origin.toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

/** An origin's scheme and host with a leading ui./api./cloudapi. label stripped, or null. */
export function capellaLabelledOrigin(origin: string): { scheme: string; host: string } | null {
  const url = parseCapellaOrigin(origin.trim().replace(/\/+$/, ""));
  if (!url) return null;
  const match = /^(?:ui|api|cloudapi)\.(.+)$/i.exec(url.host);
  return match ? { scheme: `${url.protocol}//`, host: match[1].toLowerCase() } : null;
}

/**
 * A sandbox serves `ui.`, `api.` (v2) and `cloudapi.` (v4) on one domain, so whichever URL the
 * user has to hand yields the other two; a browser UI URL's path is dropped rather than carried
 * into the APIs. `recognised` is true only when both derived endpoints are valid origins, so a
 * caller that trusts the flag cannot end up with an unusable endpoint.
 */
export function deriveCapellaSandboxEndpoints(url: string): CapellaSandboxEndpoints {
  const trimmed = url.trim().replace(/\/+$/, "");
  const unrecognised = { endpoint: trimmed, v4Endpoint: trimmed, recognised: false };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return unrecognised;
  }
  if (parsed.protocol !== "https:" || !parsed.host || parsed.username || parsed.password) return unrecognised;
  const base = parsed.host.replace(/^(?:ui|api|cloudapi)\./i, "").toLowerCase();
  const endpoint = `https://api.${base}`;
  const v4Endpoint = `https://cloudapi.${base}`;
  return isCapellaEndpointOrigin(endpoint) && isCapellaEndpointOrigin(v4Endpoint)
    ? { endpoint, v4Endpoint, recognised: true }
    : unrecognised;
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

// Rewrites every sandbox each call, so a later definition supplying none can't inherit an earlier one's.
/**
 * A sandbox endpoint receives this run's Capella credentials, so it must be a host we trust.
 * Without this, any definition file could redirect them to a server of its author's choosing.
 */
function assertTrustedCapellaHost(
  name: string,
  field: string,
  value: string,
  suffixes: string[] | null | undefined,
): void {
  if (!suffixes?.length) return;
  let hostname: string;
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    throw new Error(`Capella environment "${name}" ${field} is not a URL: ${JSON.stringify(value)}`);
  }
  if (!suffixes.some((suffix) => hostname === suffix.replace(/^\./, "") || hostname.endsWith(suffix.toLowerCase()))) {
    throw new Error(
      `Capella environment "${name}" ${field} host "${hostname}" is not under ${suffixes.join(", ")}. ` +
        `A sandbox endpoint receives this run's Capella credentials, so only those hosts are accepted; ` +
        `add the suffix to environments.json5 if this sandbox is legitimately served elsewhere.`,
    );
  }
}

export function applyCapellaEnvironmentOverrides(
  overrides: Record<string, CapellaEnvironmentOverride>,
  environments: EnvironmentsFile = loadEnvironments(),
): void {
  for (const [name, override] of Object.entries(overrides)) {
    const entry = environments.capella[name];
    if (!entry) {
      throw new Error(`Unknown Capella environment "${name}" — not defined in environments.json5.`);
    }
    if (entry.sandbox !== true) {
      throw new Error(
        `Capella environment "${name}" is not a sandbox, so its endpoint and org id can't be set from a definition file.`,
      );
    }
    for (const [field, value] of [["endpoint", override.endpoint], ["v4Endpoint", override.v4Endpoint]] as const) {
      assertTrustedCapellaHost(name, field, value, entry.endpointSuffixes);
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
