/**
 * Step: stop fit-cli's ephemeral local otel stack, dumping everything it
 * collected as artifacts before anything is torn down — see
 * dump-otel-data.ts, and `fit external-services otel replay` for viewing the
 * result once this stack no longer exists.
 *
 * Run against a stack this same machine started (there's no `--dir` support —
 * it needs the in-memory handle from starting it, so this only really makes
 * sense chained after start-otel-stack.ts in the same process; use
 * `docker rm -f` by hand to clean up a stack from an earlier process):
 *   bun src/fit/external-services/otel/stop/stop-otel-stack.ts
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { artifactFromPath, type Artifact, type Detail, type RunOutput } from "../../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../../util/non-fit/cli.js";
import { createLocalFitExecutionContext, type FitExecutionContext } from "../../../shared/util/remote-fit-run.js";
import { loadEnvironments } from "../../../util/environments.js";
import { instanceRunDir } from "../../../../util/non-fit/replay.js";
import {
  OTEL_BADGER_VOLUME,
  OTEL_CONTAINER_NAMES,
  OTEL_NETWORK,
  OTEL_PORTS,
} from "../util/otel-topology.js";
import { startOtelStack, type OtelContainerHandle, type OtelStackHandle } from "../start/start-otel-stack.js";
import { curlToLocalFile, dumpJaegerBadgerStore, dumpOtelData } from "./dump-otel-data.js";

/**
 * Best-effort snapshot of every db_* series Prometheus currently holds — the
 * cheapest end-to-end check that the exported_instance label shaping survived.
 * One line per series, so on a real run this is far past what a captured stdout
 * survives on a remote box; it travels as a file for the reasons in
 * {@link curlToLocalFile}.
 */
async function dumpPrometheusFederate(execution: FitExecutionContext, localPath: string): Promise<Artifact | undefined> {
  try {
    mkdirSync(dirname(localPath), { recursive: true, mode: 0o700 });
    const collectedPath = await curlToLocalFile(
      execution,
      `http://localhost:${OTEL_PORTS.prometheus}/federate?${new URLSearchParams({ "match[]": '{__name__=~"db_.+"}' }).toString()}`,
      localPath,
    );
    return artifactFromPath(collectedPath, "Every db_* metric series Prometheus held for this run, fetched via /federate");
  } catch (err) {
    console.warn(`  ⚠ Couldn't snapshot the Prometheus federate dump: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Each of these is one command over all three containers rather than one per
 * container: Docker stops/removes them concurrently itself, and on a remote box every
 * command is a multi-second round trip. Stop and remove are split because the badger
 * store snapshot has to happen in between: with Jaeger stopped so its store is flushed
 * and released, but before the container it lives in is removed.
 */
async function forAllContainers(execution: FitExecutionContext, stack: OtelStackHandle, verb: "stop" | "rm"): Promise<void> {
  const containerIds = [stack.collector, stack.jaeger, stack.prometheus].map((handle) => handle.containerId);
  const names = Object.values(OTEL_CONTAINER_NAMES).join(" ");
  try {
    await execution.runHiddenUntilFailure(execution.dockerCommand, [verb, ...containerIds], undefined, { display: `docker ${verb} ${names}` });
  } catch (err) {
    console.error(`  ✗ Failed to ${verb === "rm" ? "remove" : verb} one or more of ${names}: ${(err as Error).message}`);
  }
}

async function collectContainerLog(execution: FitExecutionContext, handle: OtelContainerHandle, explanation: string): Promise<Artifact> {
  // docker logs --follow only reaches EOF once the container has stopped, so
  // drain has to happen after the containers are removed.
  await handle.logStream.drain();
  const targetLogFile = execution.targetFilePath(handle.logFile);
  const collectedPath = await execution.collectFile(targetLogFile, handle.logFile).catch(() => handle.logFile);
  return artifactFromPath(collectedPath, explanation);
}

export async function stopOtelStack(execution: FitExecutionContext, stack: OtelStackHandle): Promise<RunOutput> {
  const otelDir = dirname(stack.collector.logFile);
  const artifacts: Artifact[] = [];
  const details: Detail[] = [];

  console.log(`\nStopping the otel stack on ${execution.description}...`);

  // The dump is deliberately spread either side of the shutdown, because the two
  // halves need opposite states. These first two need the servers UP — they're HTTP
  // queries against Jaeger and Prometheus.
  const [federateArtifact, dump] = await Promise.all([
    dumpPrometheusFederate(execution, join(otelDir, "prometheus-federate.txt")),
    dumpOtelData(execution, otelDir, stack.windowStart),
  ]);
  if (federateArtifact) artifacts.push(federateArtifact);
  artifacts.push(...dump.artifacts);
  details.push(...dump.details);

  await forAllContainers(execution, stack, "stop");

  // ...whereas this one needs Jaeger STOPPED (so badger has flushed and released
  // its store) but not yet removed (so there's still a container to copy from).
  artifacts.push(...(await dumpJaegerBadgerStore(execution, otelDir)));

  await forAllContainers(execution, stack, "rm");

  const [collectorLog, jaegerLog, prometheusLog] = await Promise.all([
    collectContainerLog(execution, stack.collector, "OTel collector container logs for this run's otel stack"),
    collectContainerLog(execution, stack.jaeger, "Jaeger container logs for this run's otel stack"),
    collectContainerLog(execution, stack.prometheus, "Prometheus container logs for this run's otel stack"),
  ]);
  artifacts.push(collectorLog, jaegerLog, prometheusLog);

  await Promise.all([
    execution.runHiddenUntilFailure(execution.dockerCommand, ["network", "rm", OTEL_NETWORK]).catch(() => {}),
    // Safe only now the containers referencing it are gone. The spans it held have
    // already been captured as jaeger-badger.tar.gz above.
    execution.runHiddenUntilFailure(execution.dockerCommand, ["volume", "rm", OTEL_BADGER_VOLUME]).catch(() => {}),
  ]);

  console.log(`  ✓ Otel stack stopped.`);
  return { artifacts, details };
}

const STOP_OTEL_STACK_HELP = `Start fit-cli's ephemeral local otel stack, then immediately stop it — a smoke test for the stop path.

Usage:
  bun src/fit/external-services/otel/stop/stop-otel-stack.ts [--dir <instance-dir>]

Options:
  --dir <path>   Instance artifact directory to write configs/logs under. Defaults to a fresh run directory.
  --help, -h     Show this help.`;

if (isMain(import.meta.url)) {
  runCli(async () => {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
      console.log(STOP_OTEL_STACK_HELP);
      return;
    }
    const dirIndex = args.indexOf("--dir");
    const dir = dirIndex !== -1 ? args[dirIndex + 1] : undefined;
    const execution = createLocalFitExecutionContext();
    const instanceDir = dir ?? instanceRunDir({ instanceIndex: 0 });
    const stack = await startOtelStack(execution, instanceDir, loadEnvironments().externalServices.otel);
    console.log(`\n→ Started the stack; stopping it again immediately as a smoke test.`);
    await stopOtelStack(execution, stack);
  });
}
