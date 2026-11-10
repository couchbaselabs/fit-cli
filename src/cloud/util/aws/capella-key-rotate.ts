/**
 * Step: put a working Capella v4 organization API key into the shared fit-cli AWS
 * secret of one Capella environment. fit-cli and FIT CI use that key for every
 * Capella run, so when someone deletes it each run fails with HTTP 401 at cluster
 * allocation. A person runs this by hand. Nothing calls it automatically.
 *
 * The new key comes from the user, who made it in the Capella UI. With --auto it
 * is created through the shared account's v2 login instead. The secret only
 * changes once Capella v4 accepts the new key. The key's token goes into the
 * secret and nowhere else. It never reaches the terminal, the logs or the prompt log.
 *
 * Run on its own:
 *   bun src/cloud/util/aws/capella-key-rotate.ts [env] [--auto]
 *   bun src/cloud/util/aws/capella-key-rotate.ts --help
 * The stable command is `fit secrets capella-key rotate [env] [--auto]`.
 */
import type { Detail, RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../../util/non-fit/fit-cli-log.js";
import { confirm, input, password } from "../../../util/non-fit/prompts.js";
import { extractInteractiveFlag, extractReplayFlag } from "../../../util/non-fit/replay.js";
import { exponentialDelays, retryWhole } from "../../../util/non-fit/retry.js";
import { DEFAULT_CAPELLA_ENV } from "../../../fit/util/config.js";
import { loadEnvironments, type CapellaEnvironment } from "../../../fit/util/environments.js";
import { AWS_REGION } from "./aws-target.js";
import {
  CapellaHttpError,
  apiKeyUrl,
  checkApiKey,
  createApiKey,
  createApiKeyRequest,
  createApiKeyUrl,
  deleteApiKey,
  loginUrl,
  loginV2,
  organizationUrl,
  type CapellaOrg,
} from "./capella-api-keys.js";
import { getJsonSecret, mergeJsonSecret } from "./secrets.js";

export const CAPELLA_KEY_NAME = "FIT-CLI-DONT-DELETE";
export const CAPELLA_KEY_DESCRIPTION =
  "Used by fit-cli and FIT CI for all Capella test runs. Do not delete it, or every run fails with HTTP 401.";

const AUTO_FLAG = "--auto";
const VERIFY_BUDGET_MS = 60_000;
const VERIFY_DELAYS_MS = exponentialDelays({ attempts: 10, baseMs: 2_000, maxMs: 10_000 });

export const capellaKeyRotateUsage = (): string =>
  `${runScriptPrefix("secrets")} capella-key rotate [env] [${AUTO_FLAG}]`;

export interface RotateArgs {
  env?: string;
  auto: boolean;
}

/** One Capella environment, with every field this step needs. */
export interface RotateTarget extends CapellaOrg {
  env: string;
  secretId: string;
  /** The shared v2 account from environments.json5. */
  username?: string;
}

interface NewKey {
  id: string;
  /** Unknown for a key made in the Capella UI. */
  name?: string;
  token: string;
}

/**
 * A key ID as printed: its last 4 characters. The ID goes into the shared secret, and
 * fit-cli never prints secret values. The last 4 characters are enough to find the key
 * in the Capella UI.
 */
export function shortKeyId(id: string): string {
  return `…${id.slice(-4)}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function parseRotateArgs(argv: string[]): RotateArgs {
  const args = extractInteractiveFlag(extractReplayFlag(argv).positionals).positionals;
  let env: string | undefined;
  let auto = false;
  for (const arg of args) {
    if (arg === AUTO_FLAG) auto = true;
    else if (arg.startsWith("-")) throw new Error(`Unexpected argument: ${arg}`);
    else if (env === undefined) env = arg;
    else throw new Error("Expected at most one environment.");
  }
  return { env, auto };
}

export function resolveRotateTarget(capella: Readonly<Record<string, CapellaEnvironment>>, env: string): RotateTarget {
  const entry = Object.hasOwn(capella, env) ? capella[env] : undefined;
  if (!entry) {
    throw new Error(`Unknown Capella environment "${env}". environments.json5 has ${Object.keys(capella).join(", ")}.`);
  }
  const endpoint = entry.endpoint?.trim();
  const v4Endpoint = entry.v4Endpoint?.trim();
  const organizationId = entry.oid?.trim();
  const secretId = entry.secretId?.trim();
  if (!endpoint || !v4Endpoint || !organizationId || !secretId) {
    const missing = [!endpoint && "endpoint", !v4Endpoint && "v4Endpoint", !organizationId && "oid", !secretId && "secretId"]
      .filter(Boolean)
      .join(", ");
    throw new Error(`Capella environment "${env}" in environments.json5 has no ${missing}.`);
  }
  return { env, endpoint, v4Endpoint, organizationId, secretId, username: entry.username?.trim() || undefined };
}

/**
 * The shared v2 account. Like resolveCapellaConfig, the username in environments.json5
 * wins, and a username in the secret is the fallback.
 */
export function v2Credentials(target: RotateTarget, secret: Readonly<Record<string, string>>): { username: string; password: string } {
  const username = target.username || secret.username?.trim();
  const password = secret.password?.trim();
  if (!username || !password) {
    const missing = [!username && "username", !password && "password"].filter(Boolean).join(" and ");
    throw new Error(
      `${AUTO_FLAG} logs in to Capella v2, but there is no ${missing} for "${target.env}" ` +
        `in environments.json5 or AWS secret ${target.secretId}.`,
    );
  }
  return { username, password };
}

async function askForKey(): Promise<NewKey> {
  console.log(
    `Enter the key you created in the Capella UI. It should be named ${CAPELLA_KEY_NAME}, ` +
      `with the Organization Owner role, no expiry, and access from 0.0.0.0/0.`,
  );
  const id = await input({
    promptId: "secrets.capella-key.id",
    message: "API key ID:",
    validate: (value) => value.trim() !== "" || "Enter the key ID.",
  });
  const token = await password({
    promptId: "secrets.capella-key.secret",
    message: "API key secret, the token Capella shows only once (hidden):",
    mask: "*",
    validate: (value) => value.trim() !== "" || "Enter the key secret.",
    // The prompt log stores a blank in its place, so the token never lands on disk.
    replay: { serializeResponse: () => "" },
  });
  if (token.trim() === "") throw new Error("No API key secret was entered.");
  return { id: id.trim(), token: token.trim() };
}

async function createKey(target: RotateTarget, secret: Readonly<Record<string, string>>): Promise<NewKey> {
  const { username, password } = v2Credentials(target, secret);
  console.log(
    `Logging in to Capella v2 as ${username}, with the password from AWS secret ${target.secretId}.\n` +
      `  POST ${loginUrl(target)}`,
  );
  const jwt = await loginV2(target, username, password);
  const request = createApiKeyRequest(CAPELLA_KEY_NAME, CAPELLA_KEY_DESCRIPTION);
  console.log(
    `Creating API key ${request.name} with the organizationOwner role, no expiry, and access from 0.0.0.0/0.\n` +
      `  POST ${createApiKeyUrl(target)}`,
  );
  const key = await createApiKey(target, jwt, request);
  console.log(`Created key ${shortKeyId(key.id)} (${key.name}).`);
  return key;
}

async function verifyKey(target: RotateTarget, key: NewKey): Promise<void> {
  console.log(
    `Checking that Capella v4 accepts key ${shortKeyId(key.id)}. A new key can take a few seconds to work, ` +
      `so this retries for up to ${VERIFY_BUDGET_MS / 1000}s.\n  GET ${organizationUrl(target)}`,
  );
  await retryWhole(() => checkApiKey(target, key.token), {
    delaysMs: VERIFY_DELAYS_MS,
    totalBudgetMs: VERIFY_BUDGET_MS,
    onRetry: (err, waitMs, nextAttempt) => {
      const reason = err instanceof CapellaHttpError ? `HTTP ${err.status}` : err.message;
      console.log(`  Not accepted yet (${reason}). Attempt ${nextAttempt} in ${Math.round(waitMs / 1000)}s.`);
    },
  });
  console.log(`Capella v4 accepts key ${shortKeyId(key.id)}.`);
}

async function writeKey(target: RotateTarget, key: NewKey): Promise<void> {
  console.log(
    `Writing the key ID to apiKey and its secret to apiSecret in AWS secret ${target.secretId}. ` +
      `Every other field stays as it is.`,
  );
  const { keys } = await mergeJsonSecret(
    target.secretId,
    { apiKey: key.id, apiSecret: key.token },
    { createIfMissing: false },
  );
  console.log(`Updated ${target.secretId}. Its fields are now ${keys.join(", ")}.`);
}

/**
 * Deletes with the new key, since the previous one may already be gone or broken. Nothing here
 * prints the previous key ID, as it comes from the secret. Its name is unknown too, as a key
 * made by hand can have any name.
 */
async function offerToDeletePreviousKey(target: RotateTarget, previousKeyId: string, key: NewKey): Promise<Detail> {
  const label = "Previous key";
  const inUi =
    `In the Capella UI it is a key other than the new one, ${shortKeyId(key.id)}. ` +
    `It is often an older key named ${CAPELLA_KEY_NAME}, but a key made by hand can have another name.`;
  console.log("The secret held another key before. Runs that started earlier may still use it.");
  if (!process.stdin.isTTY) {
    console.log(`Not deleting it without a terminal. If it still exists, delete it in the Capella UI. ${inUi}`);
    return { label, value: "kept (no terminal)" };
  }
  const remove = await confirm({
    promptId: "secrets.capella-key.delete-previous",
    message: "Delete the previous key?",
    default: false,
  });
  if (!remove) return { label, value: "kept" };

  console.log(`Deleting the previous key with the new key.\n  DELETE ${apiKeyUrl(target, "<previous key ID>")}`);
  try {
    const outcome = await deleteApiKey(target, previousKeyId, key.token);
    console.log(outcome === "deleted" ? "Deleted the previous key." : "The previous key was already gone.");
    return { label, value: outcome === "deleted" ? "deleted" : "already gone" };
  } catch (err) {
    // The error message repeats the request URL, which holds the previous key ID.
    const reason = err instanceof CapellaHttpError ? `HTTP ${err.status}` : "the request failed";
    console.warn(`Could not delete the previous key (${reason}). ${inUi}`);
    return { label, value: `not deleted (${reason}). Delete it in the Capella UI.`, callToAction: true };
  }
}

export async function rotateCapellaKey(args: RotateArgs): Promise<RunOutput> {
  const target = resolveRotateTarget(loadEnvironments().capella, args.env ?? DEFAULT_CAPELLA_ENV);
  console.log(
    `Reading AWS secret ${target.secretId} for Capella environment "${target.env}", with your own AWS credentials.`,
  );
  // Read as the caller too, so fit-cli-role is never assumed and the write later uses the caller's credentials.
  const secret = await getJsonSecret(target.secretId, { asCaller: true });
  const previousKeyId = secret.apiKey?.trim() || undefined;
  console.log(previousKeyId ? "It holds a key." : "It holds no key yet.");

  const key = args.auto ? await createKey(target, secret) : await askForKey();
  const newKey = shortKeyId(key.id);
  const createdNote = args.auto ? `\nfit-cli created key ${newKey} (${key.name}). Delete it in the Capella UI.` : "";
  try {
    await verifyKey(target, key);
  } catch (err) {
    throw new Error(
      `Capella v4 does not accept key ${newKey}. AWS secret ${target.secretId} is unchanged.${createdNote}`,
      { cause: err },
    );
  }
  try {
    await writeKey(target, key);
  } catch (err) {
    throw new Error(`Could not write key ${newKey} to AWS secret ${target.secretId}.${createdNote}`, { cause: err });
  }

  const details: Detail[] = [
    { label: "Capella environment", value: target.env },
    { label: "AWS secret", value: target.secretId },
    { label: "New key", value: key.name ? `${newKey} (${key.name})` : newKey },
  ];
  if (previousKeyId && previousKeyId !== key.id) {
    details.push(await offerToDeletePreviousKey(target, previousKeyId, key));
  }
  console.log(`Done. fit-cli and FIT CI now use key ${newKey} for Capella "${target.env}".`);
  return { artifacts: [], details };
}

function rotateHelpText(): string {
  const prefix = runScriptPrefix("secrets");
  const envs = Object.keys(loadEnvironments().capella).join(", ");
  return `Put a working Capella v4 API key into the shared fit-cli AWS secret.

Usage:
  ${capellaKeyRotateUsage()}
  ${prefix} capella-key rotate --help

  [env]     Capella environment from environments.json5 (${envs}). Default ${DEFAULT_CAPELLA_ENV}.
  ${AUTO_FLAG}    Create the key through the Capella API, instead of asking for one made in the UI.

fit-cli and FIT CI use one shared organization API key per Capella environment, named
${CAPELLA_KEY_NAME}. Do not delete it. Without it every Capella FIT run fails with HTTP 401
when it allocates a cluster. This command puts a new key in place. Nothing runs it
automatically, so a person runs it by hand when the key stops working.

Without ${AUTO_FLAG}, create the key in the Capella UI first. Name it ${CAPELLA_KEY_NAME}, give it the
Organization Owner role and no expiry, and allow access from 0.0.0.0/0. The command then asks
for the key ID and the key secret. The secret is hidden as you type.

With ${AUTO_FLAG}, the command logs in to Capella v2 as the shared account, with the password from
the AWS secret. It then creates that same key itself.

In both modes the command then
  - checks that Capella v4 accepts the new key. It retries for up to ${VERIFY_BUDGET_MS / 1000}s, as a new key
    can take a few seconds to work. If the check fails, the AWS secret stays unchanged.
  - writes the key ID to apiKey and the secret to apiSecret in the AWS secret. Every other field
    stays as it is.
  - asks whether to delete the previous key in the secret. The default is No. Without a terminal
    it never deletes.

It never prints the key secret, and shows a key ID by its last 4 characters only. It only
updates a secret that exists, and never creates one. It uses your own AWS credentials, not
fit-cli-role, which can only read secrets.
They need secretsmanager:GetSecretValue and secretsmanager:PutSecretValue on the secret in ${AWS_REGION}.`;
}

/** Entry point shared by `fit secrets capella-key rotate` and this file's mini CLI. */
export async function runCapellaKeyRotate(argv: string[]): Promise<RunOutput | undefined> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(rotateHelpText());
    return undefined;
  }
  let args: RotateArgs;
  try {
    args = parseRotateArgs(argv);
  } catch (err) {
    console.error(`${errorMessage(err)}\n\n${rotateHelpText()}`);
    process.exit(2);
  }
  return rotateCapellaKey(args);
}

if (isMain(import.meta.url)) {
  runCli(() => runCapellaKeyRotate(process.argv.slice(2)));
}
