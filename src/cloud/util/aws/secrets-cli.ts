/**
 * Mini CLI for the AWS Secrets Manager secrets that back fit-cli: per-environment
 * Capella and results-DB credentials (the secretIds listed in environments.json5),
 * plus the fixed shared secrets (GitHub, Gerrit, ROSA) kept out of that file.
 *
 * Uses the ambient AWS credential chain (env / SSO / profile / OIDC) — the same
 * credentials fit-cli already needs to create instances. Secret values are JSON
 * objects of fields, e.g. {"username":"…","password":"…"}.
 *
 *   bun run secrets list                       # every env's secretId + whether it exists + which keys it has
 *   bun run secrets set  <secretId> k=v [k=v…] # create or update (merges with existing keys)
 *
 * <secretId> may be a registry name (e.g. capella/dev → resolved via environments.json5)
 * or a raw Secrets Manager id/ARN.
 */
import { SecretsManagerClient, CreateSecretCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../../util/non-fit/fit-cli-log.js";
import { loadEnvironments } from "../../../fit/util/environments.js";
import { getJsonSecret, AwsSecretError } from "./secrets.js";
import { AWS_REGION } from "./aws-target.js";
import { GITHUB_AWS_SECRET_ID, ROSA_AWS_SECRET_ID } from "../../../fit/util/config.js";
import { GERRIT_AWS_SECRET_ID } from "../../../fit/shared/util/remote-fit-execution-context.js";

let client: SecretsManagerClient | undefined;
const secrets = (): SecretsManagerClient => (client ??= new SecretsManagerClient({ region: AWS_REGION }));

/** All known fit-cli secretIds — environments.json5 entries plus the fixed shared ones — with a human label. */
function registrySecrets(): { label: string; secretId: string }[] {
  const envs = loadEnvironments();
  const out: { label: string; secretId: string }[] = [];
  for (const [name, e] of Object.entries(envs.capella)) {
    if (e.secretId) out.push({ label: `capella/${name}`, secretId: e.secretId });
  }
  for (const [name, e] of Object.entries(envs.results)) {
    if (e.secretId) out.push({ label: `results/${name}`, secretId: e.secretId });
  }
  out.push({ label: "github", secretId: GITHUB_AWS_SECRET_ID });
  out.push({ label: "gerrit", secretId: GERRIT_AWS_SECRET_ID });
  out.push({ label: "rosa", secretId: ROSA_AWS_SECRET_ID });
  return out;
}

/** Map a friendly "capella/dev" / "results/prod" to its secretId; otherwise pass through as a raw id/ARN. */
function resolveSecretId(idOrName: string): string {
  const match = registrySecrets().find((s) => s.label === idOrName);
  return match ? match.secretId : idOrName;
}

async function cmdList(): Promise<void> {
  const entries = registrySecrets();
  if (entries.length === 0) {
    console.log("No secrets referenced in environments.json5.");
    return;
  }
  for (const { label, secretId } of entries) {
    try {
      const secret = await getJsonSecret(secretId);
      const keys = Object.keys(secret).sort().join(", ") || "(no keys)";
      console.log(`✓ ${label.padEnd(14)} ${secretId}  [${keys}]`);
    } catch (err) {
      const reason = err instanceof AwsSecretError ? "missing or unreadable" : (err as Error).message;
      console.log(`✗ ${label.padEnd(14)} ${secretId}  (${reason})`);
    }
  }
}

async function cmdSet(idOrName: string, pairs: string[]): Promise<void> {
  if (pairs.length === 0) throw new Error("set needs at least one key=value pair.");
  const updates: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`Expected key=value, got "${pair}".`);
    updates[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const secretId = resolveSecretId(idOrName);

  // Merge onto whatever's already there so you can set one field without clobbering the rest.
  let existing: Record<string, string> = {};
  let exists = true;
  try {
    existing = await getJsonSecret(secretId);
  } catch {
    exists = false;
  }
  const merged = { ...existing, ...updates };
  const SecretString = JSON.stringify(merged);

  if (exists) {
    await secrets().send(new PutSecretValueCommand({ SecretId: secretId, SecretString }));
    console.log(`Updated ${secretId} — keys now: ${Object.keys(merged).sort().join(", ")}`);
  } else {
    await secrets().send(new CreateSecretCommand({ Name: secretId, SecretString }));
    console.log(`Created ${secretId} — keys: ${Object.keys(merged).sort().join(", ")}`);
  }
}

function helpText(): string {
  const p = runScriptPrefix("secrets");
  return `fit-cli AWS secrets manager.

Usage:
  ${p} list
  ${p} set <secretId|name> key=value [key=value ...]

<name> may be a registry name from environments.json5 (e.g. capella/dev, results/prod)
or a raw Secrets Manager id/ARN. Secrets are JSON objects of fields. Region: ${AWS_REGION}.`;
}

export function runSecretsMain(): void {
  runCli(async () => {
    const [command, ...rest] = process.argv.slice(2);
    switch (command) {
      case "list":
        await cmdList();
        return;
      case "set":
        if (!rest[0]) throw new Error("set needs a <secretId|name>.");
        await cmdSet(rest[0], rest.slice(1));
        return;
      default:
        console.log(helpText());
        if (command !== undefined && command !== "--help" && command !== "-h") process.exit(2);
    }
  });
}

if (isMain(import.meta.url)) {
  runSecretsMain();
}
