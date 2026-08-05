/**
 * identity — the one-stop AWS credentials preflight fit-cli runs before any
 * EC2/situational work. Always prints where it looked for credentials, which
 * AWS profile is active, and (on success) which fit-cli-role session resulted;
 * on failure it explains exactly what to try next.
 *
 * Run on its own:
 *   bun src/cloud/util/aws/identity.ts check
 *
 * Preview the various failure/success outputs without touching real AWS or your
 * local ~/.aws files:
 *   bun src/cloud/util/aws/identity.ts simulate no-creds
 *   bun src/cloud/util/aws/identity.ts simulate wrong-tenant
 *   bun src/cloud/util/aws/identity.ts simulate assume-fail
 *   bun src/cloud/util/aws/identity.ts simulate success
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { fromIni, fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { loadSharedConfigFiles } from "@aws-sdk/shared-ini-file-loader";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { awsTenantAliasForAccount, loadEnvironments, type EnvironmentsFile } from "../../../fit/util/environments.js";
import { loadFitCliConfigEnv } from "../../../fit/util/config.js";
import { AWS_REGION } from "./aws-target.js";
import {
  assumeFitCliRole,
  freshCallerIdentity,
  logAwsAction,
  type AssumeRoleOutcome,
  type CallerIdentity,
  type CredentialsCheck,
} from "./aws-cli.js";

export type { CallerIdentity, CredentialsCheck };

/** Raw AWS credential values needed to forward to a remote execution target. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** A configured AWS profile, with its account/tenant when we could determine it. */
export interface AwsProfileEntry {
  name: string;
  /** undefined when the profile's credentials couldn't be used (expired, not logged in, etc). */
  accountId?: string;
  /** undefined when accountId is unset, or the account isn't a known tenant (see awsTenants). */
  tenant?: string;
}

/** The active AWS profile and every profile found in ~/.aws/{config,credentials}, each resolved to an account/tenant. */
export interface AwsProfilesInfo {
  active: string;
  profiles: AwsProfileEntry[];
}

const PROFILE_ACCOUNT_LOOKUP_TIMEOUT_MS = 4000;

/** The AWS account id `profile`'s credentials resolve to, or undefined if they don't work right now. */
async function accountIdForProfile(profile: string): Promise<string | undefined> {
  try {
    const client = new STSClient({ region: AWS_REGION, credentials: fromIni({ profile }) });
    const response = await Promise.race([
      client.send(new GetCallerIdentityCommand({})),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), PROFILE_ACCOUNT_LOOKUP_TIMEOUT_MS)),
    ]);
    return response.Account;
  } catch {
    return undefined;
  }
}

/**
 * Which AWS profiles are configured, which one is active, and (best-effort, in
 * parallel) the account id / tenant each profile's credentials currently resolve
 * to. A profile that's expired/not logged in just shows no account — this never
 * throws or blocks indefinitely (each lookup is time-boxed).
 */
export async function listAwsProfiles(
  env: NodeJS.ProcessEnv = process.env,
  environments: EnvironmentsFile = loadEnvironments(),
): Promise<AwsProfilesInfo> {
  const active = env.AWS_PROFILE?.trim() || env.AWS_DEFAULT_PROFILE?.trim() || "default";
  let names: string[];
  try {
    const { configFile, credentialsFile } = await loadSharedConfigFiles();
    const nameSet = new Set<string>();
    for (const key of Object.keys(configFile)) nameSet.add(key.replace(/^profile\s+/, ""));
    for (const key of Object.keys(credentialsFile)) nameSet.add(key);
    names = [...nameSet].sort();
  } catch {
    names = [];
  }

  const profiles = await Promise.all(
    names.map(async (name) => {
      const accountId = await accountIdForProfile(name);
      const tenant = accountId ? awsTenantAliasForAccount(accountId, environments) : undefined;
      return { name, ...(accountId ? { accountId } : {}), ...(tenant ? { tenant } : {}) };
    }),
  );

  return { active, profiles };
}

function describeProfile(p: AwsProfileEntry): string {
  if (!p.accountId) return `${p.name} (account unknown — not logged in / expired)`;
  return `${p.name} (${p.accountId}${p.tenant ? `, ${p.tenant}` : ""})`;
}

function printAwsProfileSummary(profiles: AwsProfilesInfo): void {
  console.log("fit-cli and AWS explained:");
  console.log("  fit-cli will try and assume the role 'fit-cli-role' from the cb-sdk account, which has all AWS permissions needed.");
  console.log("  This is done both on localhost testing and when run on a GHA, so that the two environments are similar and isolated from user's setup.");
  console.log("  There are some limits on how long a role can be assumed: 1-12 hours, depending on how logged in.  But fit-cli should automatically refresh the role as needed.");
  console.log("  'fit-cli-role' can only be assumed from specific repos (for CI) and these two AWS accounts (for local testing): cb-sdk (958525475024) and cb-qe (516524556673).");
  console.log("  E.g. you must be on one of these two accounts for local testing: if not, create an IT ticket.");
  console.log("  Instances are always created on us-west-2 and in VPC `fit-cli-vpc` for several reasons (see README).");
  console.log("AWS profile:");
  const activeEntry = profiles.profiles.find((p) => p.name === profiles.active);
  console.log(`  active: ${activeEntry ? describeProfile(activeEntry) : profiles.active}`);
  console.log(`  configured (${profiles.profiles.length}):`);
  if (profiles.profiles.length === 0) {
    console.log("    (none found)");
  } else {
    for (const p of profiles.profiles) {
      console.log(`    ${describeProfile(p)}`);
    }
  }
}

/** Print a ✓/✗ checklist of which AWS credential sources are present. */
export function printCredentialsDiagnostic(env: NodeJS.ProcessEnv = process.env): void {
  const hasEnvVars = Boolean(env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim());
  const home = env.HOME ?? homedir();
  const hasCredentialsFile = existsSync(join(home, ".aws", "credentials"));
  const hasConfigFile = existsSync(join(home, ".aws", "config"));

  console.log("AWS credential sources (✓ indicates it exists):");
  console.log(`  ${hasEnvVars ? "✓" : "✗"} AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (env vars)`);
  console.log(`  ${hasCredentialsFile ? "✓" : "✗"} ~/.aws/credentials`);
  console.log(`  ${hasConfigFile ? "✓" : "✗"} ~/.aws/config`);
}

/** Guidance printed on any failure — how to get from "broken" to "working". */
function printAwsFailureGuidance(profiles: AwsProfilesInfo, _environments: EnvironmentsFile): void {
  console.log("");
  console.log("To fix this:");
  console.log(`  1. You will need AWS access if you don't have it already, and be on either the "cb-sdk" or "cb-qe" tenants: 
      Install aws cli (https://aws.amazon.com/cli/).
      Create an IT ticket asking for access to the "cb-sdk" tenant.`);
  console.log(`  2. Make sure you've logged into AWS recently so your cached credentials are up-to-date:`);
  console.log(`       aws configure --profile cb-sdk`);
  console.log(`       aws sso login    (if you use AWS SSO)`);
  if (profiles.profiles.length > 1) {
    console.log(`  3. You have multiple AWS profiles configured (note you have ${profiles.profiles.map((p) => p.name).join(", ")}).`);
    console.log(`     Then run with the right one with (note that only "cb-sdk" and "cb-qe" are supported):`);
    console.log(`       AWS_PROFILE="cb-sdk" fit ...  or AWS_PROFILE="cb-qe" fit ...`);
  }
}

/** Raw credential values for `env`: explicit env vars first, then the SDK provider chain. */
async function extractRawCredentials(env: NodeJS.ProcessEnv): Promise<AwsCredentials | string> {
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
  if (accessKeyId && secretAccessKey) {
    const sessionToken = env.AWS_SESSION_TOKEN?.trim() || undefined;
    return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
  }

  try {
    const creds = await fromNodeProviderChain()();
    if (!creds.accessKeyId || !creds.secretAccessKey) {
      return (
        "AWS credentials were validated but their raw values could not be read. " +
        "Please export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY explicitly."
      );
    }
    return {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    };
  } catch (err) {
    return (
      "AWS credentials were validated but could not be read for forwarding. " +
      "Please export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY explicitly. " +
      `(${err instanceof Error ? err.message : String(err)})`
    );
  }
}

/** The result of {@link checkAwsCredentials}: a working fit-cli-role session, or why we don't have one. */
export type AwsCredentialsResult =
  | { ok: true; identity: CallerIdentity; credentials: AwsCredentials; tenant: string }
  | { ok: false; message: string };

export interface CheckAwsCredentialsOptions {
  env?: NodeJS.ProcessEnv;
  environments?: EnvironmentsFile;
  /** Override the pre-assume identity lookup (STS GetCallerIdentity) — for testing/simulation. */
  getPreAssumeIdentity?: () => Promise<CredentialsCheck>;
  /** Override the fit-cli-role assumption — for testing/simulation. */
  assumeRole?: () => Promise<AssumeRoleOutcome>;
  /** Override AWS profile enumeration — for testing/simulation. */
  listProfiles?: (env: NodeJS.ProcessEnv) => Promise<AwsProfilesInfo>;
}

let cachedResult: AwsCredentialsResult | undefined;

/**
 * The one method fit-cli uses to check and fetch AWS credentials for EC2/situational
 * work. Always prints (success or failure): where it looked for credentials and which
 * sources are set, the active AWS profile and how many are configured, the caller
 * identity, and (on success) the fit-cli-role session it assumed. Fails fast — with
 * guidance on how to fix it — if the account isn't a supported tenant (cb-sdk/cb-qe,
 * per fit-cli-role's trust policy) or the role can't be assumed.
 *
 * Call this as early as possible in any workflow that will need AWS (see the
 * "check very early" rule) rather than deep inside EC2 provisioning. Cached for the
 * lifetime of the process when called with no overrides, so calling it again later
 * in the same run (e.g. once in select-execution-target, again in provisionFitInstance)
 * doesn't reprint the whole diagnostic a second time.
 */
export async function checkAwsCredentials(options: CheckAwsCredentialsOptions = {}): Promise<AwsCredentialsResult> {
  const usingDefaults = Object.keys(options).length === 0;
  if (usingDefaults && cachedResult) return cachedResult;
  const result = await runCheckAwsCredentials(options);
  if (usingDefaults) cachedResult = result;
  return result;
}

async function runCheckAwsCredentials(options: CheckAwsCredentialsOptions): Promise<AwsCredentialsResult> {
  const env = options.env ?? process.env;
  const environments = options.environments ?? loadEnvironments();
  const getPreAssumeIdentity = options.getPreAssumeIdentity ?? freshCallerIdentity;
  const doAssumeRole = options.assumeRole ?? assumeFitCliRole;
  const listProfiles = options.listProfiles ?? listAwsProfiles;

  loadFitCliConfigEnv(undefined, env);

  const profiles = await listProfiles(env);
  printAwsProfileSummary(profiles);
  printCredentialsDiagnostic(env);

  const pre = await getPreAssumeIdentity();
  if (!pre.ok) {
    const message = `Could not find working AWS credentials: ${pre.message}`;
    console.error(`\n✗ ${message}`);
    printAwsFailureGuidance(profiles, environments);
    return { ok: false, message };
  }
  console.log(`\nAWS identity: ${pre.identity.arn}`);

  const tenant = awsTenantAliasForAccount(pre.identity.account, environments);
  if (!tenant) {
    const supported = Object.keys(environments.awsTenants).join("/");
    const message = `AWS account ${pre.identity.account} is not a supported fit-cli tenant (need ${supported}).`;
    console.error(`✗ ${message}`);
    printAwsFailureGuidance(profiles, environments);
    return { ok: false, message };
  }
  console.log(`AWS tenant/account: ${tenant}`);

  const assumed = await doAssumeRole();
  if (!assumed.ok) {
    const message = `Could not assume fit-cli-role: ${assumed.message}`;
    console.error(`✗ ${message}`);
    printAwsFailureGuidance(profiles, environments);
    return { ok: false, message };
  }

  const credentials = await extractRawCredentials(env);
  if (typeof credentials === "string") {
    console.error(`✗ ${credentials}`);
    printAwsFailureGuidance(profiles, environments);
    return { ok: false, message: credentials };
  }

  console.log(`✓ Using AWS account ${assumed.identity.account} (${assumed.identity.arn})`);
  return { ok: true, identity: assumed.identity, credentials, tenant };
}

function helpText(): string {
  return `fit-cli AWS credentials preflight.

Usage:
  bun src/cloud/util/aws/identity.ts check
  bun src/cloud/util/aws/identity.ts simulate <scenario>

Scenarios (no real AWS calls, no ~/.aws files read):
  no-creds       no AWS credentials found anywhere
  wrong-tenant   valid credentials, but not on the cb-sdk/cb-qe tenant
  assume-fail    on a supported tenant, but assuming fit-cli-role fails (e.g. expired session)
  success        everything works`;
}

type Scenario = "no-creds" | "wrong-tenant" | "assume-fail" | "success";

function simulatedOptions(scenario: Scenario): CheckAwsCredentialsOptions {
  const fakeEnv: NodeJS.ProcessEnv = { HOME: "/nonexistent" };
  const fakeProfiles: AwsProfilesInfo = {
    active: "cb-sdk",
    profiles: [
      { name: "default", accountId: "958525475024", tenant: "cb-sdk" },
      { name: "cb-sdk", accountId: "958525475024", tenant: "cb-sdk" },
      { name: "cb-qe-shared", accountId: "516524556673", tenant: "cb-qe" },
    ],
  };
  const environments = loadEnvironments();

  switch (scenario) {
    case "no-creds":
      return {
        env: fakeEnv,
        listProfiles: () => Promise.resolve({ active: "default", profiles: [] }),
        getPreAssumeIdentity: () =>
          Promise.resolve({
            ok: false,
            message: "Could not load credentials from any providers",
          }),
      };
    case "wrong-tenant":
      return {
        env: fakeEnv,
        listProfiles: () => Promise.resolve(fakeProfiles),
        getPreAssumeIdentity: () =>
          Promise.resolve({
            ok: true,
            identity: { account: "044057754343", arn: "arn:aws:iam::044057754343:user/some.user@couchbase.com", userId: "AIDAEXAMPLE" },
          }),
      };
    case "assume-fail":
      return {
        env: fakeEnv,
        listProfiles: () => Promise.resolve(fakeProfiles),
        getPreAssumeIdentity: () =>
          Promise.resolve({
            ok: true,
            identity: {
              account: Object.values(environments.awsTenants)[0].accountId,
              arn: "arn:aws:iam::958525475024:user/some.user@couchbase.com",
              userId: "AIDAEXAMPLE",
            },
          }),
        assumeRole: () =>
          Promise.resolve({
            ok: false,
            message: "The security token included in the request is invalid",
          }),
      };
    case "success":
      return {
        env: { ...fakeEnv, AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "example-secret" },
        listProfiles: () => Promise.resolve(fakeProfiles),
        getPreAssumeIdentity: () =>
          Promise.resolve({
            ok: true,
            identity: {
              account: Object.values(environments.awsTenants)[0].accountId,
              arn: "arn:aws:iam::958525475024:user/some.user@couchbase.com",
              userId: "AIDAEXAMPLE",
            },
          }),
        assumeRole: () =>
          Promise.resolve({
            ok: true,
            preAssumeIdentity: { account: "958525475024", arn: "arn:aws:iam::958525475024:user/some.user@couchbase.com", userId: "AIDAEXAMPLE" },
            identity: { account: "958525475024", arn: "arn:aws:sts::958525475024:assumed-role/fit-cli-role/fit-cli-some-user", userId: "" },
            sessionExpiry: "2026-07-01T12:00:00.000Z",
            isChained: false,
          }),
      };
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const [command, arg] = process.argv.slice(2);
    switch (command) {
      case "check": {
        logAwsAction("Checking AWS credentials");
        const result = await checkAwsCredentials();
        if (!result.ok) process.exit(1);
        return;
      }
      case "simulate": {
        const scenarios: Scenario[] = ["no-creds", "wrong-tenant", "assume-fail", "success"];
        if (!scenarios.includes(arg as Scenario)) {
          console.log(helpText());
          process.exit(2);
        }
        console.log(`(Simulating: ${arg} — no real AWS calls)\n`);
        const result = await checkAwsCredentials(simulatedOptions(arg as Scenario));
        if (!result.ok) process.exit(1);
        return;
      }
      default:
        console.log(helpText());
        if (command !== undefined && command !== "--help" && command !== "-h") process.exit(2);
    }
  });
}
