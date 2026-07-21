/**
 * Step: run a single prebuilt performer Docker image, for manual testing
 * outside a full FIT run. Pulls the image from GHCR if needed and leaves it
 * running in the background.
 *
 * Run on its own:
 *   bun src/fit/performer/run/run-performer.ts scala
 *   bun src/fit/performer/run/run-performer.ts scala 1.2.3
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../../util/non-fit/fit-cli-log.js";
import type { RunOutput } from "../../../util/non-fit/artifacts.js";
import {
  SDKS,
  sdkByPerformerImageBasename,
  sdkByValue,
} from "../../../util/sdk/sdks.js";
import { validatePerformerVersion } from "../../performers/util/performer-image.js";
import { createLocalFitExecutionContext } from "../../shared/util/remote-fit-run.js";
import { checkBuildAndRunPerformer } from "../../performers/check-build-and-run-performer/check-build-and-run-performer.js";

function helpText(): string {
  const sdks = SDKS.map((s) => s.value).join(", ");
  return `Run a single prebuilt performer Docker image, for manual testing outside a full FIT run.

Usage:
  ${runScriptPrefix("performer")} run <sdk> [version]
  ${runScriptPrefix("performer")} run --help

  sdk      SDK performer to run (${sdks}).
  version  Performer image tag to run. Omit for the SDK's default (usually "main").

The image is pulled from GHCR if needed, then started detached. It's left
running — stop it yourself with the "docker stop <container>" command printed
once it starts.

Example:
  ${runScriptPrefix("performer")} run scala`;
}

export async function runPerformerRunMain(argv: string[]): Promise<RunOutput | void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(helpText());
    return;
  }

  const [sdkValue, version, ...extra] = argv;
  if (!sdkValue || extra.length > 0) {
    console.error(helpText());
    process.exit(2);
  }

  const sdk = sdkByValue(sdkValue) ?? sdkByPerformerImageBasename(sdkValue);
  if (!sdk) {
    const supported = SDKS.map((s) => s.value).join(", ");
    console.error(`Unknown SDK "${sdkValue}". Supported SDKs: ${supported}.\n`);
    console.error(helpText());
    process.exit(2);
  }

  if (version !== undefined) {
    const error = validatePerformerVersion(version);
    if (error !== true) {
      console.error(`${error}\n`);
      console.error(helpText());
      process.exit(2);
    }
  }

  const performer = await checkBuildAndRunPerformer(
    createLocalFitExecutionContext(),
    sdk,
    { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0 },
    version,
  );
  if (!performer) {
    throw new Error(`Failed to run the ${sdk.name} performer.`);
  }

  if (performer.logFile) {
    console.log(`\nPerformer logs are streaming to:\n  ${performer.logFile}`);
  }

  return { artifacts: performer.artifacts, details: performer.details };
}

if (isMain(import.meta.url)) {
  runCli(() => runPerformerRunMain(process.argv.slice(2)));
}
