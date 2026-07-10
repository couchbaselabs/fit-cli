/**
 * aws-cli — shared helpers for the rest of cloud/util/aws. Provides config
 * preparation (so AWS_PROFILE / credentials are in place before SDK calls),
 * the fit-cli-role assumption, and console logging conventions.
 *
 * Run on its own (checks the AWS config is ready):
 *   bun src/cloud/util/aws/aws-cli.ts
 */
import { userInfo } from "node:os";
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@aws-sdk/types";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { loadFitCliConfigEnv } from "../../../fit/util/config.js";
import { loadEnvironments } from "../../../fit/util/environments.js";
import { AWS_REGION } from "./aws-target.js";

/** Who a set of AWS credentials belongs to. */
export interface CallerIdentity {
  account: string;
  arn: string;
  userId: string;
  /** Active AWS profile, if set via AWS_PROFILE or AWS_DEFAULT_PROFILE. */
  profile?: string;
}

/** The result of a credentials check: usable identity, or a reason it failed. */
export type CredentialsCheck = { ok: true; identity: CallerIdentity } | { ok: false; message: string };

const FIT_CLI_ROLE = loadEnvironments().fitCliRole;
const FIT_CLI_ROLE_ARN = `arn:aws:iam::${FIT_CLI_ROLE.accountId}:role/${FIT_CLI_ROLE.roleName}`;
export const FIT_CLI_ROLE_ACCOUNT = FIT_CLI_ROLE.accountId;

/**
 * Requested session length for the assumed role, in seconds. 12 hours (43200s) is
 * AWS's absolute ceiling for AssumeRole — there is no way to get a longer single
 * session (e.g. 24h) regardless of the role's own MaxSessionDuration setting, which
 * is already configured at this max. If AssumeRole is called again after expiry
 * (e.g. a new fit-cli invocation), it transparently gets a fresh 12h session.
 */
const ASSUME_ROLE_DURATION_SECONDS = 12 * 60 * 60;

/**
 * GetCallerIdentity using a fresh STSClient rather than the shared singleton, so we
 * don't prime the shared client's credential cache with whichever identity happens
 * to be active at the time (important before/after assuming fit-cli-role, where the
 * active identity changes mid-process).
 */
export async function freshCallerIdentity(): Promise<CredentialsCheck> {
  const freshSts = new STSClient({ region: AWS_REGION });
  try {
    const response = await freshSts.send(new GetCallerIdentityCommand({}));
    const profile = process.env.AWS_PROFILE ?? process.env.AWS_DEFAULT_PROFILE;
    return {
      ok: true,
      identity: {
        account: response.Account ?? "",
        arn: response.Arn ?? "",
        userId: response.UserId ?? "",
        ...(profile ? { profile } : {}),
      },
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** The outcome of {@link assumeFitCliRole}. */
export type AssumeRoleOutcome =
  | { ok: true; preAssumeIdentity: CallerIdentity; identity: CallerIdentity; sessionExpiry: string }
  | { ok: false; preAssumeIdentity?: CallerIdentity; message: string };

let cachedAssumeResult: AssumeRoleOutcome | undefined;

/**
 * State needed to refresh the assumed role mid-run (see {@link ensureFreshFitCliRole}).
 * A single fit-cli run can outlive the assumed session — role chaining (assuming from
 * SSO / an instance profile / an already-assumed role) caps the session at 1 hour, and
 * long situational suites exceed that. Without refresh, teardown's AWS calls fail with
 * `RequestExpired` and instances/clusters are orphaned.
 */
// Expiry of the credentials we assumed (undefined when we didn't assume — e.g. already
// fit-cli-role via OIDC/instance profile, which the standard provider chain refreshes itself).
let credsExpiration: Date | undefined;
// True only when we actually assumed and wrote AWS_* env vars (not the already-active or failed cases).
let didSetEnvCreds = false;
// The AWS_* env values that were present *before* we clobbered them, so a refresh can restore the
// original master-credential resolution (SSO profile / IAM user / OIDC) and re-assume cleanly —
// otherwise re-assuming would see our own (expired) assumed creds as the source and no-op.
let preAssumeAwsEnv: { id?: string; secret?: string; token?: string } | undefined;

function capturePreAssumeEnv(): void {
  preAssumeAwsEnv ??= {
    id: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
    token: process.env.AWS_SESSION_TOKEN,
  };
}

function restorePreAssumeEnv(): void {
  // Never assumed yet → we have no snapshot, so there's nothing to restore (and we must not
  // wipe whatever credentials are currently in the environment).
  if (preAssumeAwsEnv === undefined) return;
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("AWS_ACCESS_KEY_ID", preAssumeAwsEnv?.id);
  restore("AWS_SECRET_ACCESS_KEY", preAssumeAwsEnv?.secret);
  restore("AWS_SESSION_TOKEN", preAssumeAwsEnv?.token);
}

/**
 * Assume fit-cli-role if the current identity is not already that role. Cached for
 * the lifetime of the process — repeated calls (from multiple call sites) return the
 * same outcome without re-hitting STS.
 *
 * Unlike the old (pre-merge) version, failures are NOT swallowed: callers that need
 * fit-cli-role's permissions (situational/EC2 work) should treat a failed outcome as
 * fatal. {@link prepareAwsCli} (used by dozens of call sites that don't specifically
 * need the role — e.g. reading a public AMI) still calls this but ignores the outcome,
 * so those call sites keep their previous fall-back-to-current-credentials behaviour.
 */
export async function assumeFitCliRole(): Promise<AssumeRoleOutcome> {
  if (cachedAssumeResult) return cachedAssumeResult;

  // Snapshot the original AWS_* env (once) before we potentially clobber it, so a later
  // refresh can restore master-credential resolution and re-assume. No-op after first call.
  capturePreAssumeEnv();

  const pre = await freshCallerIdentity();
  if (!pre.ok) {
    cachedAssumeResult = { ok: false, message: pre.message };
    return cachedAssumeResult;
  }

  if (pre.identity.arn.includes("fit-cli-role")) {
    console.log(`Assuming fit-cli-role (already assumed as ${pre.identity.arn})`);
    // We didn't assume anything, so there's nothing for us to refresh — whatever provided
    // these credentials (OIDC / instance profile / a prior assume) owns their lifecycle.
    didSetEnvCreds = false;
    credsExpiration = undefined;
    cachedAssumeResult = {
      ok: true,
      preAssumeIdentity: pre.identity,
      identity: pre.identity,
      sessionExpiry: "already active",
    };
    return cachedAssumeResult;
  }

  console.log(`Assuming fit-cli-role...`);
  console.log(`  current identity: ${pre.identity.arn}`);

  let sessionName: string;
  try {
    sessionName = `fit-cli-${userInfo().username}`;
  } catch {
    sessionName = "fit-cli-local";
  }

  // AWS caps "role chaining" — assuming a role using credentials that are themselves
  // temporary (SSO, an EC2 instance profile, an already-assumed role) — at 1 hour,
  // hard-erroring if DurationSeconds is set higher. Only a direct long-term IAM user
  // (arn contains ":user/") can be granted the longer session requested below.
  const isChained = !pre.identity.arn.includes(":user/");

  try {
    const freshSts = new STSClient({ region: AWS_REGION });
    const result = await freshSts.send(
      new AssumeRoleCommand({
        RoleArn: FIT_CLI_ROLE_ARN,
        RoleSessionName: sessionName,
        ...(isChained ? {} : { DurationSeconds: ASSUME_ROLE_DURATION_SECONDS }),
      }),
    );
    const creds = result.Credentials;
    if (!creds?.AccessKeyId || !creds?.SecretAccessKey || !creds?.SessionToken) {
      throw new Error("AssumeRole returned incomplete credentials");
    }
    process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
    process.env.AWS_SESSION_TOKEN = creds.SessionToken;
    // Record what we assumed so {@link ensureFreshFitCliRole} can re-assume before expiry.
    credsExpiration = creds.Expiration;
    didSetEnvCreds = true;
    const sessionExpiry = creds.Expiration?.toISOString() ?? "unknown";
    console.log(`✓ Assumed fit-cli-role (session expires: ${sessionExpiry})`);
    cachedAssumeResult = {
      ok: true,
      preAssumeIdentity: pre.identity,
      identity: {
        account: FIT_CLI_ROLE_ACCOUNT,
        arn: `arn:aws:sts::${FIT_CLI_ROLE_ACCOUNT}:assumed-role/fit-cli-role/${sessionName}`,
        userId: "",
      },
      sessionExpiry,
    };
    return cachedAssumeResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`⚠  Could not assume fit-cli-role: ${message}`);
    cachedAssumeResult = { ok: false, preAssumeIdentity: pre.identity, message };
    return cachedAssumeResult;
  }
}

/**
 * Return a valid fit-cli-role session, re-assuming if the current one is expired or within
 * `marginMs` of expiry. This is what lets a single long run (situational suites can exceed the
 * ~1h role-chaining cap) keep making AWS calls — most importantly teardown, which would otherwise
 * fail with `RequestExpired` and orphan the EC2 instance and any Capella clusters.
 *
 * Returns the cached outcome unchanged when we didn't assume the role ourselves: an
 * already-fit-cli-role identity (OIDC / instance profile) is refreshed by its own provider.
 */
export async function ensureFreshFitCliRole(marginMs = 5 * 60 * 1000): Promise<AssumeRoleOutcome> {
  const cached = cachedAssumeResult;
  const stillFresh =
    cached?.ok === true &&
    // credsExpiration is undefined when we didn't assume — nothing for us to refresh.
    (credsExpiration === undefined || credsExpiration.getTime() - Date.now() > marginMs);
  if (stillFresh) return cached;

  // Expired or near expiry: restore the original master credentials, drop the cache, re-assume.
  restorePreAssumeEnv();
  cachedAssumeResult = undefined;
  credsExpiration = undefined;
  didSetEnvCreds = false;
  return assumeFitCliRole();
}

/**
 * Shared credentials provider for fit-cli's own AWS SDK clients (see aws-clients.ts, secrets.ts).
 * Unlike static env vars set once at startup, the SDK re-invokes this once the returned
 * `expiration` passes, so clients transparently pick up a re-assumed session mid-run — the fix
 * for teardown failing with `RequestExpired` on runs longer than the assumed session.
 *
 * When we assumed the role ourselves it returns those credentials (with their expiry); otherwise
 * it defers to the standard provider chain (OIDC / instance profile / SSO / IAM user), which
 * manages its own refresh.
 */
export const fitCliCredentialsProvider: AwsCredentialIdentityProvider = async (): Promise<AwsCredentialIdentity> => {
  await ensureFreshFitCliRole();
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (didSetEnvCreds && accessKeyId && secretAccessKey) {
    return {
      accessKeyId,
      secretAccessKey,
      ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
      ...(credsExpiration ? { expiration: credsExpiration } : {}),
    };
  }
  return fromNodeProviderChain()();
};

/**
 * The freshest assumed-role credentials to forward to a remote box (re-assuming first if near
 * expiry), or undefined when we didn't assume them ourselves (caller should keep whatever it
 * already resolved). NB the forwarded values are a point-in-time snapshot that still expires on
 * the box — surviving a multi-hour run there needs the box to have its own refreshing source
 * (e.g. an EC2 instance profile); this just gives it as long a head start as possible.
 */
export async function freshAssumedCredentials(): Promise<
  { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined
> {
  await ensureFreshFitCliRole();
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (didSetEnvCreds && accessKeyId && secretAccessKey) {
    return {
      accessKeyId,
      secretAccessKey,
      ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
    };
  }
  return undefined;
}

/**
 * Apply fit-cli config to env (sets AWS_PROFILE if configured), then assume
 * fit-cli-role. Soft: ignores the outcome, so callers that don't specifically need
 * the role's permissions keep working with whatever credentials were already active
 * if the assume fails. Callers that DO need the role (or want to report why it
 * failed) should call {@link assumeFitCliRole} directly via `checkAwsCredentials`.
 */
export async function prepareAwsCli(): Promise<void> {
  loadFitCliConfigEnv();
  await assumeFitCliRole();
}

function formatAwsDetail(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") {
    return value.description ? `Symbol(${value.description})` : "Symbol()";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return typeof value;
}

/** Print a short, consistent summary of the AWS action about to be run. */
export function logAwsAction(action: string, details: Record<string, unknown> = {}): void {
  console.log(`${action} (region: ${AWS_REGION})`);
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      console.log(`  ${key}: ${value.join(", ")}`);
      continue;
    }
    console.log(`  ${key}: ${formatAwsDetail(value)}`);
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    await prepareAwsCli();
    console.log(`✓ AWS config ready (region: ${AWS_REGION})`);
  });
}
