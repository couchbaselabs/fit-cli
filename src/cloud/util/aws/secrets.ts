/**
 * Read JSON secrets from AWS Secrets Manager using the ambient AWS credential
 * chain (env vars, SSO, shared profile, or CI OIDC) — the same credentials
 * fit-cli already needs to create instances. This is how per-environment Capella
 * and results-DB credentials are resolved at run time, so CI and laptops resolve
 * identically (see environments.json5 / resolveCapellaConfig / resolveResultsDbCredentials).
 *
 * Run on its own:
 *   bun src/cloud/util/aws/secrets.ts <secret-id>
 *   bun src/cloud/util/aws/secrets.ts fit-cli/gerrit/ssh-key
 */
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { AWS_REGION } from "./aws-target.js";
import { fitCliCredentialsProvider } from "./aws-cli.js";
import { isMain } from "../../../util/non-fit/cli.js";

/** Thrown when a secret can't be read (missing, access denied, or malformed). */
export class AwsSecretError extends Error {}

let client: SecretsManagerClient | undefined;
function secretsClient(): SecretsManagerClient {
  client ??= new SecretsManagerClient({ region: AWS_REGION, credentials: fitCliCredentialsProvider });
  return client;
}

const cache = new Map<string, Record<string, string>>();

/**
 * Fetch a JSON secret by id or ARN and parse it as a flat string map. Cached per
 * id for the process. Throws {@link AwsSecretError} with an actionable message on
 * a missing secret, denied access, or non-JSON value.
 */
export async function getJsonSecret(secretId: string): Promise<Record<string, string>> {
  const hit = cache.get(secretId);
  if (hit) return hit;

  let value: string | undefined;
  try {
    const out = await secretsClient().send(new GetSecretValueCommand({ SecretId: secretId }));
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

if (isMain(import.meta.url)) {
  const secretId = process.argv[2];
  if (!secretId) {
    console.error("Usage: bun src/cloud/util/aws/secrets.ts <secret-id>");
    process.exit(2);
  }
  try {
    const secret = await getJsonSecret(secretId);
    const keys = Object.keys(secret);
    console.log(`\nSecret "${secretId}" (${keys.length} field(s)):\n`);
    for (const key of keys) {
      const val = secret[key];
      const display = key.toLowerCase().includes("key") || key.toLowerCase().includes("token") || key.toLowerCase().includes("password")
        ? `${val.slice(0, 8)}... (${val.length} chars)`
        : val;
      console.log(`  ${key}: ${display}`);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
