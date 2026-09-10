/**
 * Step: fetch and checkout transactions-fit-performer at a specific Gerrit ref.
 *
 * Run on its own:
 *   bun src/fit/performers/checkout-fit-gerrit-ref/checkout-fit-gerrit-ref.ts refs/changes/29/246329/1
 */
import { captureValueSync } from "../../../util/non-fit/proc.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliError, runScriptPrefix } from "../../../util/non-fit/fit-cli-log.js";
import { posixQuote } from "../../../util/non-fit/remote-target.js";
import { resolveGerritUser } from "../../util/config.js";
import { createLocalFitExecutionContext, type FitExecutionContext } from "../../shared/util/remote-fit-run.js";
import { getJsonSecret, AwsSecretError } from "../../../cloud/util/aws/secrets.js";

export const FIT_GERRIT_HOST = "review.couchbase.org";
export const FIT_GERRIT_PORT = 29418;
export const FIT_PERFORMER_GERRIT_REPO = "transactions-fit-performer";


/** Build the GIT_SSH_COMMAND value for authenticating to Gerrit with a specific key. */
export function gerritSshCommand(keyPath: string): string {
  return `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o IdentitiesOnly=yes`;
}

export function resolveFitGerritUser(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.FIT_GERRIT_USER ?? env.GERRIT_USER;
  const trimmed = configured?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveGerritUserFromGitConfig(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // Quiet metadata probe: a non-zero exit just means "not configured" → undefined.
  return captureValueSync("git", ["config", "--global", "github.user"], { quiet: true, allowFailure: true, env }).trim() || undefined;
}

export function resolveGerritUserFromGhCli(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // Quiet metadata probe: a non-zero exit just means "not configured" → undefined.
  return captureValueSync("gh", ["config", "get", "user", "-h", "github.com"], { quiet: true, allowFailure: true, env }).trim() || undefined;
}

export function requireFitGerritUser(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = resolveFitGerritUser(env);
  if (fromEnv) {
    return fromEnv;
  }
  const fromGitConfig = resolveGerritUserFromGitConfig(env);
  if (fromGitConfig) {
    return fromGitConfig;
  }
  const fromGhCli = resolveGerritUserFromGhCli(env);
  if (fromGhCli) {
    return fromGhCli;
  }
  throw new Error(
    "Cannot determine Gerrit username. Set FIT_GERRIT_USER, GERRIT_USER, or run: git config --global github.user <your-username>",
  );
}

/**
 * Resolve the Gerrit username using all sources: config file, env vars, git
 * config, gh CLI, and (last resort) the `username` field of the
 * `fit-cli/gerrit/ssh-key` AWS Secrets Manager secret. Throws with a helpful
 * message if nothing is found.
 */
export async function requireGerritUser(): Promise<string> {
  const fromConfig = resolveGerritUser();
  if (fromConfig) {
    return fromConfig;
  }
  const fromGitConfig = resolveGerritUserFromGitConfig();
  if (fromGitConfig) {
    return fromGitConfig;
  }
  const fromGhCli = resolveGerritUserFromGhCli();
  if (fromGhCli) {
    return fromGhCli;
  }
  try {
    const secret = await getJsonSecret("fit-cli/gerrit/ssh-key");
    const fromAws = (secret.username as string | undefined)?.trim();
    if (fromAws) {
      console.log(`\n→ Loaded Gerrit username from AWS Secrets Manager (fit-cli/gerrit/ssh-key)`);
      return fromAws;
    }
  } catch (err) {
    if (!(err instanceof AwsSecretError)) throw err;
  }
  throw new Error(
    `Cannot determine Gerrit username. Set gerrit.user in ~/.fit-cli/config.json5 (${runScriptPrefix("config")} edit), or set FIT_GERRIT_USER / GERRIT_USER.`,
  );
}

export function fitPerformerGerritUrl(gerritUser: string): string {
  return `ssh://${gerritUser}@${FIT_GERRIT_HOST}:${FIT_GERRIT_PORT}/${FIT_PERFORMER_GERRIT_REPO}`;
}

export function fitPerformerGerritFetchArgs(gerritRef: string, gerritUser: string): string[] {
  return ["fetch", fitPerformerGerritUrl(gerritUser), gerritRef];
}

export function checkoutFetchHeadArgs(): string[] {
  return ["checkout", "FETCH_HEAD"];
}

export function gitStatusIsClean(status: string): boolean {
  return status.trim() === "";
}

export async function checkoutFitGerritRef(
  execution: FitExecutionContext,
  gerritRef: string,
): Promise<boolean> {
  const trimmedRef = gerritRef.trim();
  if (!trimmedRef) {
    fitCliError("A FIT Gerrit ref was requested, but it was blank.");
    return false;
  }

  let gerritUser: string;
  try {
    gerritUser = await requireGerritUser();
  } catch (err) {
    fitCliError((err as Error).message);
    return false;
  }

  let status: string;
  try {
    status = await execution.capture("git", ["status", "--porcelain", "--untracked-files=no"], execution.fitPerformerDir);
  } catch (err) {
    fitCliError(
      `Could not inspect ${execution.fitPerformerDir} before checking out Gerrit ref ${trimmedRef}: ${(err as Error).message}`,
    );
    return false;
  }

  if (!gitStatusIsClean(status)) {
    fitCliError(
      `Refusing to checkout Gerrit ref ${trimmedRef} because ${execution.fitPerformerDir} is not clean:\n${status.trim()}`,
    );
    return false;
  }

  const fetchArgs = fitPerformerGerritFetchArgs(trimmedRef, gerritUser);
  const sshKeyPath = execution.gerritSshKeyPath;

  try {
    if (sshKeyPath) {
      const sshCmd = gerritSshCommand(sshKeyPath);
      const shScript = `GIT_SSH_COMMAND=${posixQuote(sshCmd)} git ${fetchArgs.map(posixQuote).join(" ")}`;
      console.log(`\nFetching FIT Gerrit ref with:\n  GIT_SSH_COMMAND=${posixQuote(sshCmd)} git ${fetchArgs.join(" ")}\n`);
      await execution.runHiddenUntilFailure("sh", ["-c", shScript], execution.fitPerformerDir, {
        display: `GIT_SSH_COMMAND=<gerrit-key> git ${fetchArgs.join(" ")}`,
      });
    } else {
      console.log(
        `\nAdding ${FIT_GERRIT_HOST} to known_hosts with:\n  ssh-keyscan -p ${FIT_GERRIT_PORT} ${FIT_GERRIT_HOST} >> ~/.ssh/known_hosts\n`,
      );
      try {
        await execution.runHiddenUntilFailure("sh", [
          "-c",
          `mkdir -p ~/.ssh && chmod 700 ~/.ssh && ssh-keyscan -p ${FIT_GERRIT_PORT} ${FIT_GERRIT_HOST} >> ~/.ssh/known_hosts`,
        ]);
      } catch (err) {
        console.warn(`Warning: could not pre-seed known_hosts for ${FIT_GERRIT_HOST}: ${(err as Error).message}`);
      }
      console.log(`\nFetching FIT Gerrit ref with:\n  git ${fetchArgs.join(" ")}\n`);
      await execution.runHiddenUntilFailure("git", fetchArgs, execution.fitPerformerDir);
    }

    console.log(`\nChecking out fetched FIT Gerrit ref with:\n  git ${checkoutFetchHeadArgs().join(" ")}\n`);
    await execution.runHiddenUntilFailure("git", checkoutFetchHeadArgs(), execution.fitPerformerDir);
  } catch (err) {
    const message = (err as Error).message;
    const hints: string[] = [];
    if (message.includes("Host key verification failed")) {
      hints.push(`The machine running git does not trust ${FIT_GERRIT_HOST} yet.`);
    }
    if (!sshKeyPath) {
      hints.push(
        execution.kind === "remote"
          ? "Set FIT_GERRIT_KEY to a private key registered with Gerrit, or GERRIT_SSH_KEY."
          : "Set FIT_GERRIT_KEY or GERRIT_SSH_KEY, or ensure your SSH agent has a key registered with Gerrit.",
      );
    }
    fitCliError(
      `Failed to checkout FIT Gerrit ref ${trimmedRef}: ${message}${hints.length > 0 ? ` ${hints.join(" ")}` : ""}`,
    );
    return false;
  }

  console.log(`\n✓ Checked out FIT Gerrit ref ${trimmedRef}`);
  return true;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const positionals = process.argv.slice(2);
    const gerritRef = positionals[0];
    if (!gerritRef || positionals.length > 1) {
      console.error(
        "Usage: tsx src/fit/performers/checkout-fit-gerrit-ref/checkout-fit-gerrit-ref.ts <refs/changes/...>",
      );
      process.exit(2);
    }
    process.exit((await checkoutFitGerritRef(createLocalFitExecutionContext(), gerritRef)) ? 0 : 1);
  });
}
