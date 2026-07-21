/**
 * The "Check and run performer" guided flow.
 *
 * Performers are always prebuilt images pulled from GHCR; fit-cli no longer
 * builds them from source.
 *
 * Run this flow on its own (skipping the top-level menu):
 *   bun src/fit/performers/check-build-and-run-performer/check-build-and-run-performer.ts
 */
import { join } from "node:path";
import { artifactFromPath, type RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { createLogFile, type BackgroundStream } from "../../../util/non-fit/proc.js";
import { sanitizePathSeg, type DefinitionRunPath } from "../../../util/non-fit/replay.js";
import { type Sdk } from "../../../util/sdk/sdks.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import {
  createLocalFitExecutionContext,
  type FitExecutionContext,
} from "../../shared/util/remote-fit-run.js";
import { askPerformerTag } from "../util/ask-performer-image.js";
import { checkoutFitGerritRef } from "../checkout-fit-gerrit-ref/checkout-fit-gerrit-ref.js";
import { checkAndPullPerformer } from "../check-and-pull-performer/check-and-pull-performer.js";
import { logPerformerImageMetadata } from "../check-performer/check-performer.js";
import { performerImageName } from "../util/performer-image.js";
import { checkRunningPerformer, stopRunningPerformer } from "../check-running-performer/check-running-performer.js";
export { DEFAULT_PERFORMER_PORT } from "../util/performer-port.js";
import { DEFAULT_PERFORMER_PORT, type PortInUsePolicy } from "../util/performer-port.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// How long we watch a freshly-started container for an immediate crash before
// declaring it up. The container is never started with --rm, so it sticks
// around either way — this just decides how long we wait before reporting the
// crash to the user rather than letting it surface later as a confusing
// "no such container" sanity-check failure.
const STARTUP_CRASH_CHECK_INTERVAL_MS = 250;
const STARTUP_CRASH_CHECK_TOTAL_MS = 2000;

/** Normalize a performer tag into a filesystem-safe log-file component. */
function tagLogComponent(version?: string): string {
  return (
    (version ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[._-]+|[._-]+$/g, "") || "main"
  );
}

export interface RunningPerformer extends RunOutput {
  // Absent when reusing a performer we didn't start (an external process on the
  // port), in which case there's no container for us to manage or log.
  containerId?: string;
  logFile?: string;
  // Active background log stream (docker logs --follow) started at container
  // startup. drain() is called in stopManagedPerformer after docker stop so the
  // final bytes flush before we collect the file.
  logStream?: BackgroundStream;
  // True when we're testing against a performer that was already running rather
  // than one we started, so we should leave it alone instead of stopping it.
  reused?: boolean;
}

export function performerLogStem(path: DefinitionRunPath, sdk: Sdk, version?: string): string {
  const instanceSeg = sanitizePathSeg(path.dirSegments?.instance ?? String(path.instanceIndex));
  const sessionSeg = sanitizePathSeg(path.dirSegments?.session ?? String(path.sessionIndex));
  const base = path.clusterlessSession
    ? join("instances", instanceSeg, "clusterless-sessions", sessionSeg)
    : join("instances", instanceSeg, "clusters", sanitizePathSeg(path.dirSegments?.cluster ?? String(path.clusterIndex)), "sessions", sessionSeg);
  return join(base, `${sdk.value}-${tagLogComponent(version)}-performer`);
}

function performerLogFile(path: DefinitionRunPath, sdk: Sdk, version?: string): string {
  return createLogFile(performerLogStem(path, sdk, version));
}

/**
 * Attach an already running performer to the cluster's Docker network, so it can
 * reach the cluster's containers.
 *
 * This is deliberately a second step rather than a `--network` on `docker run`,
 * because `--network` replaces the default bridge rather than adding to it, and
 * the published port the test-driver connects on only exists if the container has
 * a bridge endpoint. If `--network` is set to the cluster's network instead,
 * the port set by `--publish` is not reachable by the driver. Starting on the default
 * bridge and attaching to the cluster's network afterwards leaves the container on both,
 * with the port binding intact.
 */
async function connectPerformerToClusterNetwork(
  execution: FitExecutionContext,
  dockerNetwork: string,
  containerId: string,
): Promise<boolean> {
  const args = ["network", "connect", dockerNetwork, containerId];
  console.log(
    `\n→ Attaching the performer to Docker network ${dockerNetwork} so it can reach the cluster ` +
      `(its published port stays on the default network):\n  docker ${args.join(" ")}\n`,
  );
  try {
    await execution.run(execution.dockerCommand, args);
    console.log(`✓ Attached the performer to ${dockerNetwork}`);
    return true;
  } catch (err) {
    console.error(
      `\n✗ Couldn't attach the performer to Docker network ${dockerNetwork}, so it won't be able to ` +
        `reach the cluster: ${(err as Error).message}`,
    );
    return false;
  }
}

/** Build the docker args needed to run a performer locally for FIT. */
export function checkBuildAndRunPerformerArgs(
  sdk: Sdk,
  version?: string,
  hostPort: number = DEFAULT_PERFORMER_PORT,
): string[] {
  return [
    "run",
    "--detach",
    "--publish",
    `${hostPort}:${DEFAULT_PERFORMER_PORT}`,
    performerImageName(sdk, version),
  ];
}

/**
 * Pull the prebuilt performer image from GHCR, then start it in Docker for FIT.
 *
 * @param onPortInUse When set, decide non-interactively what to do if the port
 *   is already taken (the definition-driven flow passes the file's policy);
 *   when omitted, the guided flow prompts.
 * @param hostPort The host port the performer listens on; defaults to
 *   {@link DEFAULT_PERFORMER_PORT}. The container always listens on
 *   {@link DEFAULT_PERFORMER_PORT} internally; this is the published host port
 *   that test-driver connects to.
 * @param dockerNetwork The cluster's Docker network, which the performer is
 *   attached to, in addition to the default bridge network. See
 *   {@link connectPerformerToClusterNetwork} for why the order matters.
 */
export async function checkBuildAndRunPerformer(
  execution: FitExecutionContext,
  sdk: Sdk,
  path: DefinitionRunPath,
  version?: string,
  dockerNetwork?: string,
  onPortInUse?: PortInUsePolicy,
  hostPort: number = DEFAULT_PERFORMER_PORT,
  gerritRef?: string,
): Promise<RunningPerformer | undefined> {
  // A Gerrit ref checks out transactions-fit-performer (the FIT test driver) at a
  // specific patchset; the performer image itself is always a prebuilt GHCR image
  // and independent of the ref. The repo must be present before we can check it out.
  if (gerritRef) {
    if (!(await execution.ensureWorkspace())) {
      return undefined;
    }
    if (!(await checkoutFitGerritRef(execution, gerritRef))) {
      return undefined;
    }
  }

  // Check what's already running first: if a performer is up (a recognised
  // container, or just something on the port), we can test against it and skip
  // pulling the image entirely.
  const runCheck = await checkRunningPerformer(execution, sdk, version, onPortInUse, hostPort);
  if (runCheck.action === "abort") {
    return undefined;
  }

  if (runCheck.action === "external") {
    console.log(
      `\n→ Testing against the performer already listening on port ${hostPort}; fit-cli won't manage or stop it.`,
    );
    return { artifacts: [], details: [] };
  }

  if (runCheck.action === "reuse") {
    const containerId = runCheck.containers[0]?.id;
    if (!containerId) {
      return undefined;
    }
    const imageName = performerImageName(sdk, version);
    await logPerformerImageMetadata(execution, imageName);
    const logFile = performerLogFile(path, sdk, version);
    return {
      containerId,
      logFile,
      reused: true,
      artifacts: [artifactFromPath(logFile, `${sdk.name} performer logs captured for this FIT run`)],
      details: [],
    };
  }

  // We're going to start (or restart) the performer ourselves, so pull the
  // prebuilt image from GHCR first.
  if (!(await checkAndPullPerformer(execution, sdk, version))) {
    return undefined;
  }

  if (runCheck.action === "restart" && !(await stopRunningPerformer(execution, runCheck.containers))) {
    return undefined;
  }

  const imageName = performerImageName(sdk, version);
  const args = execution.performerRunArgs(imageName, hostPort);
  console.log(`\nStarting performer with:\n  docker ${args.join(" ")}\n`);

  try {
    const containerId = (await execution.capture(execution.dockerCommand, args)).trim();
    console.log(`\n✓ Started the ${sdk.name} performer in container ${containerId}`);

    if (dockerNetwork && !(await connectPerformerToClusterNetwork(execution, dockerNetwork, containerId))) {
      await execution.run(execution.dockerCommand, ["rm", "--force", containerId]).catch(() => {});
      return undefined;
    }

    const logFile = performerLogFile(path, sdk, version);
    const targetLogFile = execution.targetFilePath(logFile);
    const logStream = await execution.streamToArtifactFileInBackground(
      execution.dockerCommand,
      ["logs", "--follow", "--timestamps", containerId],
      targetLogFile,
    );

    // Watch for a container that crashes right on startup (e.g. an incompatible
    // CPU under Rosetta emulation). Without --rm the container isn't torn down
    // out from under us, so the logs above and the inspect below both still see
    // it even if it already exited.
    console.log(`Checking the performer doesn't crash on startup (polling for ${STARTUP_CRASH_CHECK_TOTAL_MS}ms)...`);
    let exitedEarly = false;
    for (let waited = 0; waited < STARTUP_CRASH_CHECK_TOTAL_MS; waited += STARTUP_CRASH_CHECK_INTERVAL_MS) {
      await sleep(STARTUP_CRASH_CHECK_INTERVAL_MS);
      const running = await execution
        .capture(execution.dockerCommand, ["inspect", "--format", "{{.State.Running}}", containerId])
        .then((out) => out.trim() === "true")
        .catch(() => true); // if inspect itself fails, don't second-guess a running container
      if (!running) {
        exitedEarly = true;
        break;
      }
    }

    if (exitedEarly) {
      const exitCode = await execution
        .capture(execution.dockerCommand, ["inspect", "--format", "{{.State.ExitCode}}", containerId])
        .then((out) => out.trim())
        .catch(() => "unknown");
      await logStream.drain();
      const collectedPath = await execution.collectFile(targetLogFile, logFile).catch(() => logFile);
      await execution.run(execution.dockerCommand, ["rm", containerId]).catch(() => {});
      console.error(
        `\n✗ The ${sdk.name} performer container exited immediately (exit code ${exitCode}) instead of staying up. See the captured logs:\n  ${collectedPath}`,
      );
      return undefined;
    }

    return {
      containerId,
      logFile,
      logStream,
      artifacts: [artifactFromPath(logFile, `${sdk.name} performer logs captured for this FIT run`)],
      details: [],
    };
  } catch (err) {
    console.error(`\n✗ Failed to start the ${sdk.name} performer: ${(err as Error).message}`);
    return undefined;
  }
}

/** Stop a performer started by checkBuildAndRunPerformer, collecting logs when needed. */
export async function stopManagedPerformer(
  execution: FitExecutionContext,
  performer: RunningPerformer | undefined,
): Promise<void> {
  if (!performer?.containerId) {
    if (performer?.logFile) {
      console.log(`\nPerformer logs:\n  ${performer.logFile}`);
    }
    return;
  }

  // We didn't start this performer (we're reusing one that was already up), so
  // leave it running rather than stopping someone else's process.
  if (performer.reused) {
    console.log(`\n→ Leaving the reused performer container ${performer.containerId} running.`);
    return;
  }

  // Stop the container first — this causes docker logs --follow to see EOF and exit.
  console.log(`\nStopping performer container with:\n  docker stop ${performer.containerId}\n`);
  try {
    await execution.run(execution.dockerCommand, ["stop", performer.containerId]);
    console.log(`\n✓ Stopped performer container ${performer.containerId}`);
  } catch (err) {
    console.error(`\n✗ Failed to stop performer container ${performer.containerId}: ${(err as Error).message}`);
  }

  // We no longer run the container with --rm (that raced its own crash logs and
  // sanity checks — see checkBuildAndRunPerformerArgs), so it isn't auto-removed
  // on stop. Clean it up ourselves now that we're done with it.
  try {
    await execution.run(execution.dockerCommand, ["rm", performer.containerId]);
  } catch (err) {
    console.error(`\n✗ Failed to remove performer container ${performer.containerId}: ${(err as Error).message}`);
  }

  if (performer.logFile) {
    // Wait for the live log stream to finish flushing now that the container has stopped.
    await performer.logStream?.drain();
    const targetLogFile = execution.targetFilePath(performer.logFile);
    try {
      const collectedPath = await execution.collectFile(targetLogFile, performer.logFile);
      if (collectedPath !== performer.logFile) {
        // Collection kept the file gzipped (too large to decompress locally) — swap
        // the pre-registered artifact entry so it doesn't point at a file that was
        // never created.
        const staleFilename = artifactFromPath(performer.logFile, "").filename;
        const explanation =
          performer.artifacts.find((artifact) => artifact.filename === staleFilename)?.explanation ??
          "performer logs captured for this FIT run";
        performer.artifacts = performer.artifacts
          .filter((artifact) => artifact.filename !== staleFilename)
          .concat(artifactFromPath(collectedPath, explanation));
        performer.logFile = collectedPath;
      }
      console.log(`\n✓ Saved performer logs to ${performer.logFile}`);
    } catch (err) {
      console.warn(`\nCould not collect performer logs from ${execution.description}: ${(err as Error).message}`);
    }
    console.log(`\nPerformer logs:\n  ${performer.logFile}`);
  }
}

/** Guided flow for choosing a performer, pulling it, and running it. */
export async function runCheckBuildAndRunPerformer(): Promise<void> {
  const sdk = await chooseSdk("Which SDK performer do you want to check and run?");
  const version = await askPerformerTag(sdk);
  const execution = createLocalFitExecutionContext();
  const performer = await checkBuildAndRunPerformer(execution, sdk, { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0 }, version);
  await stopManagedPerformer(execution, performer);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    await runCheckBuildAndRunPerformer();
  });
}
