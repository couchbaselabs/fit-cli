/**
 * Read and update JSON secrets in AWS Secrets Manager using the ambient AWS credential
 * chain (env vars, SSO, shared profile, or CI OIDC) — the same credentials
 * fit-cli already needs to create instances. This is how per-environment Capella
 * and results-DB credentials are resolved at run time, so CI and laptops resolve
 * identically (see environments.json5 / resolveCapellaConfig / resolveResultsDbCredentials).
 *
 * Run on its own. Reports which fields a secret has and how long each is, never
 * their values — fit-cli has no command that prints a secret value, deliberately.
 * Use the AWS CLI directly if you genuinely need one:
 *   aws secretsmanager get-secret-value --secret-id <id> --query SecretString --output text
 *
 *   bun src/cloud/util/aws/secrets.ts <secret-id>
 *   bun src/cloud/util/aws/secrets.ts fit-cli/gerrit/ssh-key
 */
import {
  SecretsManagerClient,
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { AWS_REGION } from "./aws-target.js";
import { fitCliCredentialsProvider } from "./aws-cli.js";
import { isMain } from "../../../util/non-fit/cli.js";
import { exponentialDelays, retryWhole } from "../../../util/non-fit/retry.js";

/** Thrown when a secret can't be read (missing, access denied, or malformed). */
export class AwsSecretError extends Error {}

let client: SecretsManagerClient | undefined;
function secretsClient(): SecretsManagerClient {
  client ??= new SecretsManagerClient({ region: AWS_REGION, credentials: fitCliCredentialsProvider });
  return client;
}

// The person's own credentials from the default chain. fit-cli-role can only read
// secrets, so every write goes through this client. The chain reads the AWS_* env
// vars first, and assuming fit-cli-role overwrites them. So a process that writes
// must also read through this client, and never assume the role.
let callerClient: SecretsManagerClient | undefined;
function callerSecretsClient(): SecretsManagerClient {
  callerClient ??= new SecretsManagerClient({ region: AWS_REGION });
  return callerClient;
}

const cache = new Map<string, Record<string, string>>();

// The AWS SDK retries connection errors itself, but only ~3 times with sub-second
// backoff. That is far too short a window for the callers here: resolving Capella
// or results-DB credentials is a precondition check that gates a run which has
// already spent minutes provisioning an EC2 instance, so one transient blip throws
// all of that away. Ride out a longer wobble instead.
const SECRET_RETRY_ATTEMPTS = 6;
const SECRET_RETRY_DELAYS_MS = exponentialDelays({ attempts: SECRET_RETRY_ATTEMPTS, baseMs: 250, maxMs: 8_000 });

/**
 * Names that mean "asking again will fail the same way" — a missing secret, or
 * credentials without access to it. Everything else is treated as worth another
 * go, deliberately: the failure that motivated this (an `ECONNREFUSED` reaching
 * Secrets Manager) arrives with no useful error name, so an allowlist of known
 * transient names would have missed exactly the case we want to survive.
 */
const FATAL_SECRET_ERROR_NAMES = [
  "AccessDeniedException",
  "ResourceNotFoundException",
  "InvalidRequestException",
  "InvalidParameterException",
  "UnrecognizedClientException",
];

function isRetryableSecretError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return !FATAL_SECRET_ERROR_NAMES.some((name) => err.name === name || err.message.includes(name));
}

/**
 * Fetch a JSON secret by id or ARN and parse it as a flat string map. Cached per
 * id for the process. Throws {@link AwsSecretError} with an actionable message on
 * a missing secret, denied access, or non-JSON value. Reads through fit-cli-role,
 * or with the person's own credentials when `asCaller` is set.
 */
export async function getJsonSecret(
  secretId: string,
  options: { asCaller?: boolean } = {},
): Promise<Record<string, string>> {
  const hit = cache.get(secretId);
  if (hit) return hit;

  const reader = options.asCaller ? callerSecretsClient() : secretsClient();
  let value: string | undefined;
  try {
    const out = await retryWhole(() => reader.send(new GetSecretValueCommand({ SecretId: secretId })), {
      delaysMs: SECRET_RETRY_DELAYS_MS,
      shouldRetry: isRetryableSecretError,
      // nextAttempt counts the first attempt, so the one that just failed is nextAttempt - 1.
      onRetry: (err, waitMs, nextAttempt) =>
        console.error(
          `[secrets] "${secretId}" failed (${err.name || err.message || "unnamed error"}) ` +
            `(attempt ${nextAttempt - 1}/${SECRET_RETRY_ATTEMPTS}), retrying in ${Math.round(waitMs / 1000)}s…`,
        ),
    });
    value = out.SecretString;
  } catch (err) {
    throw new AwsSecretError(
      `Could not read AWS secret "${secretId}" in ${AWS_REGION}: ${(err as Error).message}\n` +
        `  Make sure your AWS credentials are active and have secretsmanager:GetSecretValue on this secret.`,
    );
  }
  if (!value) throw new AwsSecretError(`AWS secret "${secretId}" has no string value.`);

  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(value) as Record<string, string>;
  } catch {
    throw new AwsSecretError(`AWS secret "${secretId}" is not valid JSON (expected an object of fields).`);
  }
  cache.set(secretId, parsed);
  return parsed;
}

/**
 * Merge `updates` into a JSON secret and write it back, so one field can change
 * without touching the rest. Returns whether it was created and the field names
 * it now holds.
 *
 * Reads and writes with the person's own AWS credentials, never fit-cli-role, so
 * they need secretsmanager:GetSecretValue and secretsmanager:PutSecretValue on the
 * secret. With `createIfMissing` (the default), a secret that can't be read is
 * created, which also needs secretsmanager:CreateSecret. Without it, that throws.
 */
export async function mergeJsonSecret(
  secretId: string,
  updates: Record<string, string>,
  options: { createIfMissing?: boolean } = {},
): Promise<{ created: boolean; keys: string[] }> {
  const { createIfMissing = true } = options;
  let existing: Record<string, string> | undefined;
  try {
    existing = await getJsonSecret(secretId, { asCaller: true });
  } catch (err) {
    if (!createIfMissing) throw err;
    existing = undefined;
  }
  const merged = { ...existing, ...updates };
  const SecretString = JSON.stringify(merged);
  if (existing) {
    await callerSecretsClient().send(new PutSecretValueCommand({ SecretId: secretId, SecretString }));
  } else {
    await callerSecretsClient().send(new CreateSecretCommand({ Name: secretId, SecretString }));
  }
  cache.set(secretId, merged);
  return { created: !existing, keys: Object.keys(merged).sort() };
}

if (isMain(import.meta.url)) {
  const [secretId] = process.argv.slice(2);
  if (!secretId) {
    console.error("Usage: bun src/cloud/util/aws/secrets.ts <secret-id>");
    process.exit(2);
  }
  try {
    const secret = await getJsonSecret(secretId);
    const keys = Object.keys(secret);
    console.log(`\nSecret "${secretId}" (${keys.length} field(s)):\n`);
    // Names and lengths only. Enough to tell whether a secret is populated and
    // shaped as expected, without ever putting a credential in a terminal, a
    // scrollback, or an agent transcript.
    for (const key of keys) {
      console.log(`  ${key}: ${secret[key].length} chars`);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
