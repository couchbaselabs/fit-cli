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
 *   bun run secrets capella-key rotate [env] [--auto]  # put a new Capella v4 API key in the env's secret
 *
 * <secretId> may be a registry name (e.g. capella/dev → resolved via environments.json5)
 * or a raw Secrets Manager id/ARN.
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../../util/non-fit/fit-cli-log.js";
import { loadEnvironments } from "../../../fit/util/environments.js";
import { getJsonSecret, mergeJsonSecret, AwsSecretError } from "./secrets.js";
import { AWS_REGION } from "./aws-target.js";
import { capellaKeyRotateUsage, runCapellaKeyRotate } from "./capella-key-rotate.js";
import { GITHUB_AWS_SECRET_ID, ROSA_AWS_SECRET_ID } from "../../../fit/util/config.js";
import { GERRIT_AWS_SECRET_ID } from "../../../fit/shared/util/remote-fit-execution-context.js";

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

  const { created, keys } = await mergeJsonSecret(secretId, updates);
  if (created) {
    console.log(`Created ${secretId} — keys: ${keys.join(", ")}`);
  } else {
    console.log(`Updated ${secretId} — keys now: ${keys.join(", ")}`);
  }
}

function helpText(): string {
  const p = runScriptPrefix("secrets");
  return `fit-cli AWS secrets manager.

Usage:
  ${p} list
  ${p} set <secretId|name> key=value [key=value ...]
  ${capellaKeyRotateUsage()}

<name> may be a registry name from environments.json5 (e.g. capella/dev, results/prod)
or a raw Secrets Manager id/ARN. Secrets are JSON objects of fields. Region: ${AWS_REGION}.

set and capella-key rotate write with your own AWS credentials, not fit-cli-role, which can
only read. They need secretsmanager:PutSecretValue on the secret.

capella-key rotate puts a working Capella v4 API key into an environment's shared secret.
Run it by hand when that key stops working. See ${p} capella-key rotate --help.`;
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
      case "capella-key":
        if (rest[0] === "rotate") return runCapellaKeyRotate(rest.slice(1));
        break;
    }
    console.log(helpText());
    if (command !== undefined && command !== "--help" && command !== "-h") process.exit(2);
  });
}

if (isMain(import.meta.url)) {
  runSecretsMain();
}
