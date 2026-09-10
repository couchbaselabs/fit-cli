/**
 * The "Check and pull performer" guided flow.
 *
 * Run this flow on its own:
 *   bun src/fit/performers/check-and-pull-performer/check-and-pull-performer.ts
 */
import { rmSync, writeFileSync } from "node:fs";
import { fitCliError, runScriptPrefix } from "../../../util/non-fit/fit-cli-log.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { posixQuote } from "../../../util/non-fit/remote-target.js";
import { createRunFilePath } from "../../../util/non-fit/replay.js";
import { GITHUB_AWS_SECRET_ID, resolveGithubTokenWithSource } from "../../util/config.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import { type Sdk } from "../../../util/sdk/sdks.js";
import { createLocalFitExecutionContext, type FitExecutionContext } from "../../shared/util/remote-fit-run.js";
import { choosePerformerVersion } from "../list-docker-containers/list-docker-containers.js";
import { GHCR_REGISTRY, performerImageName } from "../util/performer-image.js";
import { logPerformerImageMetadata, performerImageInspectArgs, performerStatus } from "../check-performer/check-performer.js";

/** Build the `docker login` args used for GHCR. */
export function dockerLoginArgs(registry: string = GHCR_REGISTRY): string[] {
  return ["login", registry, "--username", "x-access-token", "--password-stdin"];
}

/** Build the `docker pull` args used to fetch a performer image. */
export function dockerPullArgs(imageName: string): string[] {
  return ["pull", imageName];
}

/** Build the shell command that logs Docker into GHCR without exposing the token on argv. */
export function dockerLoginCommand(dockerCommand: string, tokenPath: string): string {
  const docker = [dockerCommand, ...dockerLoginArgs()].map(posixQuote).join(" ");
  return `cat ${posixQuote(tokenPath)} | ${docker}`;
}

async function loginToGhcr(execution: FitExecutionContext, token: string): Promise<void> {
  const localTokenPath = createRunFilePath("ghcr-token");
  writeFileSync(localTokenPath, `${token}\n`, { mode: 0o600 });

  let targetTokenPath: string | undefined;
  try {
    targetTokenPath = await execution.stageFile(localTokenPath);
    await execution.runHiddenUntilFailure("sh", ["-lc", dockerLoginCommand(execution.dockerCommand, targetTokenPath)]);
  } finally {
    if (targetTokenPath) {
      await execution.removeTree(targetTokenPath);
    }
    rmSync(localTokenPath, { force: true });
  }
}

async function ghcrImageExists(execution: FitExecutionContext, imageName: string): Promise<boolean> {
  try {
    await execution.capture(execution.dockerCommand, performerImageInspectArgs(imageName));
    return true;
  } catch {
    return false;
  }
}

/** Check for a performer image and pull it from GHCR, always refreshing a mutable tag. */
export async function checkAndPullPerformer(
  execution: FitExecutionContext,
  sdk: Sdk,
  version?: string,
): Promise<boolean> {
  const status = await performerStatus(execution, sdk, version);
  const imageName = performerImageName(sdk, version);

  if (!status.dockerAvailable) {
    fitCliError("Could not find docker on your PATH");
    return false;
  }

  const existedBefore = await ghcrImageExists(execution, imageName);
  const { token: githubToken, source: tokenSource } = await resolveGithubTokenWithSource();
  console.log(`\nPulling performer with:\n  docker ${dockerPullArgs(imageName).join(" ")}\n`);

  try {
    if (githubToken) {
      console.log("Authenticating Docker to GHCR...");
      await loginToGhcr(execution, githubToken);
    }
    console.log("\nPulling performer container...\n");
    await execution.runHiddenUntilFailure(execution.dockerCommand, dockerPullArgs(imageName));
  } catch (err) {
    const message = (err as Error).message;
    const denied = /denied/i.test(message);
    let hint = "";
    if (!githubToken) {
      hint = `\nAdd a GitHub token with read:packages scope via \`${runScriptPrefix("config")} edit\`, GITHUB_TOKEN, or GH_TOKEN, then try again.`;
    } else if (denied && tokenSource === "config") {
      hint =
        `\nPull denied even though a GitHub token was found in ~/.fit-cli/config.json5. If it's a personal PAT, it may not be ` +
        `SSO-authorized for couchbaselabs — see https://github.com/settings/tokens -> Configure SSO.`;
    } else if (denied && tokenSource === "env") {
      hint =
        `\nPull denied even though GITHUB_TOKEN/GH_TOKEN was set. If it's a personal PAT, it may not be SSO-authorized ` +
        `for couchbaselabs — see https://github.com/settings/tokens -> Configure SSO.`;
    } else if (denied && tokenSource === "aws") {
      hint = `\nPull denied using the shared AWS-secret GitHub token. Check whether the "${GITHUB_AWS_SECRET_ID}" AWS secret needs updating.`;
    }
    fitCliError(`\nFailed to pull the ${sdk.name} performer image ${imageName}: ${message}${hint}`);
    return false;
  }

  if (!(await ghcrImageExists(execution, imageName))) {
    fitCliError(`\nPulled the ${sdk.name} performer, but ${imageName} is still missing`);
    return false;
  }

  console.log(`\n✓ ${existedBefore ? "Refreshed" : "Pulled"} the ${sdk.name} performer Docker image ${imageName}`);
  await logPerformerImageMetadata(execution, imageName);
  return true;
}

/** Guided flow for choosing a performer and pulling it locally. */
export async function runCheckAndPullPerformer(): Promise<void> {
  const sdk = await chooseSdk("Which SDK performer do you want to check?");
  const version = await choosePerformerVersion(sdk);
  await checkAndPullPerformer(createLocalFitExecutionContext(), sdk, version);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    await runCheckAndPullPerformer();
  });
}
