/**
 * How `fit ingest` reaches the results database, and what it prints when it cannot.
 *
 * The password is never read from a file. It comes from FIT_INGESTER_PG_PASSWORD for
 * local development, and otherwise from the AWS Secrets Manager secret below. The
 * password is never printed or logged.
 *
 * Run on its own (says where the password came from, never what it is):
 *   bun src/fit/ingest/credentials.ts
 */
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { AWS_REGION } from "../../cloud/util/aws/aws-target.js";
import { isMain, runCli } from "../../util/non-fit/cli.js";

/** The only role the ingester writes as. */
export const INGEST_DB_USERNAME = "results_ingester";
/** Set this to skip Secrets Manager. For local development. */
export const INGEST_PASSWORD_ENV_VAR = "FIT_INGESTER_PG_PASSWORD";
/** Holds {"password": "..."} for {@link INGEST_DB_USERNAME}. */
export const INGEST_SECRET_ID = "performance-sdk/results-ingester";

/** Thrown when the password cannot be resolved. The message is the one line to print. */
export class IngestCredentialsError extends Error {}

export interface IngestPassword {
  password: string;
  /** Where the password came from. Handy for logs, and it never reveals the value. */
  source: "env" | "secret";
}

function secretFailure(reason: string): IngestCredentialsError {
  return new IngestCredentialsError(
    `Could not read Secrets Manager secret ${INGEST_SECRET_ID} (${reason}). ` +
      `Set ${INGEST_PASSWORD_ENV_VAR} or run on a host whose IAM role can read the secret.`,
  );
}

/** AWS SDK v3 puts the exception name in `name`. A plain Error has the useless name "Error". */
function awsErrorName(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.name === "Error" ? err.message : err.name;
}

/**
 * Read the secret with the default AWS credential chain, not the shared fit-cli-role
 * client. On the database host the instance role already has GetSecretValue on this
 * secret, and it cannot assume fit-cli-role.
 */
async function fetchSecretString(secretId: string): Promise<string> {
  const client = new SecretsManagerClient({ region: AWS_REGION });
  const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!out.SecretString) throw new Error("the secret has no string value");
  return out.SecretString;
}

/**
 * Resolve the results_ingester password. FIT_INGESTER_PG_PASSWORD wins so a developer
 * can run against a local database without AWS. Otherwise the password comes from
 * Secrets Manager. Throws {@link IngestCredentialsError} with a single actionable
 * line when the secret cannot be read.
 */
export async function resolveIngestPassword(
  options: {
    env?: NodeJS.ProcessEnv;
    fetchSecret?: (secretId: string) => Promise<string>;
  } = {},
): Promise<IngestPassword> {
  const env = options.env ?? process.env;
  const fromEnv = env[INGEST_PASSWORD_ENV_VAR]?.trim();
  if (fromEnv) return { password: fromEnv, source: "env" };

  const fetchSecret = options.fetchSecret ?? fetchSecretString;
  let raw: string;
  try {
    raw = await fetchSecret(INGEST_SECRET_ID);
  } catch (err) {
    throw secretFailure(awsErrorName(err));
  }

  let password: string | undefined;
  try {
    password = (JSON.parse(raw) as { password?: string }).password?.trim();
  } catch {
    throw secretFailure("the value is not valid JSON");
  }
  if (!password) throw secretFailure('the value has no "password" field');
  return { password, source: "secret" };
}

// Socket and driver codes that all mean the same thing to a user. The database is not
// reachable, so there is nothing to say about credentials yet.
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
]);

// 28P01 is invalid_password, 28000 is invalid_authorization_specification.
const AUTH_CODES = new Set(["28P01", "28000"]);

/**
 * Turn a Postgres failure into one clear line, or null when it is not a connection
 * or credentials problem and the caller should report the error as-is.
 */
export function ingestDbFailureLine(err: unknown, target: { host: string; port: number }): string | null {
  const code = (err as { code?: unknown })?.code;
  if (typeof code !== "string") return null;
  if (UNREACHABLE_CODES.has(code)) {
    return `Could not connect to Postgres at ${target.host}:${target.port}. Check the database is running.`;
  }
  if (AUTH_CODES.has(code)) {
    return (
      `Postgres rejected the ${INGEST_DB_USERNAME} password. ` +
      `The ${INGEST_SECRET_ID} secret does not match the database role.`
    );
  }
  return null;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { source } = await resolveIngestPassword();
    console.log(
      source === "env"
        ? `Password came from ${INGEST_PASSWORD_ENV_VAR}.`
        : `Password came from Secrets Manager secret ${INGEST_SECRET_ID} in ${AWS_REGION}.`,
    );
  });
}
