/**
 * Step: start fit-cli's ephemeral local otel stack — an OpenTelemetry
 * collector, Jaeger and Prometheus — on a box, so functional tests can send and
 * query traces/metrics without the old shared performance-sdk.couchbase.com box.
 *
 * Config is delivered via `docker create` + `docker cp` + `docker start` rather
 * than a bind mount: the contrib collector image runs as a non-root UID that may
 * not own a host-created directory.
 *
 * Run on its own (starts a stack on this machine and leaves it running — call
 * stop-otel-stack.ts to tear it down):
 *   bun src/fit/external-services/otel/start/start-otel-stack.ts
 *   bun src/fit/external-services/otel/start/start-otel-stack.ts --dir /tmp/fit-cli/<run>/instances/0
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactFromPath, type Artifact, type Detail } from "../../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../../util/non-fit/cli.js";
import { instanceRunDir } from "../../../../util/non-fit/replay.js";
import { type BackgroundStream } from "../../../../util/non-fit/proc.js";
import { throwFatalToCluster } from "../../../shared/failure-classification.js";
import type { ExternalServiceHandle } from "../../external-service.js";
import { createLocalFitExecutionContext, type FitExecutionContext } from "../../../shared/util/remote-fit-run.js";
import { ensureDockerNetwork } from "../../../../cluster/cluster-create/setup-declarative-cluster.js";
import { checkPortAvailability } from "../../../performers/check-running-performer/check-running-performer.js";
import { loadEnvironments, type OtelDefaults } from "../../../util/environments.js";
import {
  OTEL_CONFIG_PATHS,
  OTEL_CONTAINER_NAMES,
  OTEL_NETWORK,
  OTEL_PORTS,
  OTEL_BADGER_DIR,
  OTEL_BADGER_VOLUME,
  collectorCreateArgs,
  jaegerCreateArgs,
  otelImages,
  prometheusCreateArgs,
} from "../util/otel-topology.js";
import { collectorConfigYaml, prometheusConfigYaml } from "../util/otel-config.js";
import { otelEndpoints, type OtelEndpoints } from "../util/otel-endpoints.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Mirrors checkBuildAndRunPerformer's startup-crash watch.
const STARTUP_CRASH_CHECK_INTERVAL_MS = 250;
const STARTUP_CRASH_CHECK_TOTAL_MS = 2000;

export interface OtelContainerHandle {
  containerId: string;
  logFile: string;
  logStream: BackgroundStream;
}

export interface OtelStackHandle extends ExternalServiceHandle {
  collector: OtelContainerHandle;
  jaeger: OtelContainerHandle;
  prometheus: OtelContainerHandle;
  endpoints: OtelEndpoints;
  /**
   * When this stack became *this* run's, as the dump's window start. Set here rather
   * than read back from the collector container at dump time because an adopted stack's
   * container started during an earlier run, and a window reaching back into that run
   * pulls its traces and metrics into this run's dump.
   *
   * Absent on a handle from {@link findRunningOtelStack}, which attaches to a stack it
   * knows nothing about — the dump falls back to the container's own start time there,
   * which is what `otel stop` wants.
   */
  windowStart?: string;
}

async function pollUntil(check: () => Promise<boolean>, timeoutMs: number, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(intervalMs);
  }
}

/** Which of our 3 fixed container names already exist, and whether each is running. */
async function inspectOwnContainers(execution: FitExecutionContext): Promise<Map<string, boolean>> {
  const names = Object.values(OTEL_CONTAINER_NAMES);
  const filterArgs = names.flatMap((name) => ["--filter", `name=^${name}$`]);
  const found = new Map<string, boolean>();
  try {
    const out = await execution.capture(
      execution.dockerCommand,
      ["ps", "-a", ...filterArgs, "--format", "{{.Names}}\t{{.Status}}"],
      undefined,
      { quiet: true },
    );
    for (const line of out.split("\n")) {
      const [name, ...statusParts] = line.split("\t");
      if (!name?.trim()) continue;
      found.set(name.trim(), statusParts.join("\t").trim().startsWith("Up"));
    }
  } catch {
    // Treat "couldn't check" the same as "nothing found" — the fresh-create path
    // below will surface any real problem (e.g. Docker not running) itself.
  }
  return found;
}

interface ContainerSpec {
  name: string;
  createArgs: string[];
  /** Local config file to stage + `docker cp` in before starting; absent for jaeger (env-var configured). */
  config?: { localPath: string; content: string; containerPath: string };
}

async function createAndStartContainer(
  execution: FitExecutionContext,
  spec: ContainerSpec,
  logFile: string,
): Promise<OtelContainerHandle> {
  const containerId = (await execution.capture(execution.dockerCommand, spec.createArgs)).trim();
  if (spec.config) {
    // World-readable (not the usual 0600): `docker cp` preserves these bits, and
    // both the contrib collector and Prometheus images run as a non-root UID that
    // otherwise can't read a config `docker cp`'d in as root-owned 0600 — this is
    // not secret content, so world-readable is the simplest fix.
    writeFileSync(spec.config.localPath, spec.config.content, { mode: 0o644 });
    const stagedConfigPath = await execution.stageFile(spec.config.localPath, execution.targetFilePath(spec.config.localPath));
    await execution.run(execution.dockerCommand, ["cp", stagedConfigPath, `${containerId}:${spec.config.containerPath}`], undefined, {
      display: `docker cp ${spec.config.localPath} ${spec.name}:${spec.config.containerPath}`,
    });
  }
  return startCreatedContainer(execution, containerId, spec.name, logFile);
}

async function startCreatedContainer(
  execution: FitExecutionContext,
  containerId: string,
  name: string,
  logFile: string,
): Promise<OtelContainerHandle> {
  await execution.run(execution.dockerCommand, ["start", containerId], undefined, { display: `docker start ${name}` });
  const targetLogFile = execution.targetFilePath(logFile);
  const logStream = await execution.streamToArtifactFileInBackground(
    execution.dockerCommand,
    ["logs", "--follow", "--timestamps", containerId],
    targetLogFile,
  );

  let exitedEarly = false;
  for (let waited = 0; waited < STARTUP_CRASH_CHECK_TOTAL_MS; waited += STARTUP_CRASH_CHECK_INTERVAL_MS) {
    await sleep(STARTUP_CRASH_CHECK_INTERVAL_MS);
    const running = await execution
      .capture(execution.dockerCommand, ["inspect", "--format", "{{.State.Running}}", containerId])
      .then((out) => out.trim() === "true")
      .catch(() => true);
    if (!running) {
      exitedEarly = true;
      break;
    }
  }

  if (exitedEarly) {
    await logStream.drain();
    const collectedPath = await execution.collectFile(targetLogFile, logFile).catch(() => logFile);
    throwFatalToCluster(
      `The ${name} container exited immediately on startup instead of staying up. See the captured logs:\n  ${collectedPath}`,
    );
  }

  return { containerId, logFile, logStream };
}

async function attachToRunningContainer(execution: FitExecutionContext, name: string, logFile: string): Promise<OtelContainerHandle> {
  const containerId = (await execution.capture(execution.dockerCommand, ["inspect", "--format", "{{.Id}}", name])).trim();
  const targetLogFile = execution.targetFilePath(logFile);
  const logStream = await execution.streamToArtifactFileInBackground(
    execution.dockerCommand,
    ["logs", "--follow", "--timestamps", containerId],
    targetLogFile,
  );
  return { containerId, logFile, logStream };
}

/**
 * Find and attach to a stack already running under our fixed container names,
 * without needing the in-process {@link OtelStackHandle} the original
 * `start` call produced — the `fit external-services otel stop` command runs as a fresh
 * process with no memory of that call, so it has to rediscover the stack from
 * Docker state alone. Returns undefined unless all 3 containers exist (running
 * or not) under our names; a partial set is left for the caller to handle.
 */
export async function findRunningOtelStack(
  execution: FitExecutionContext,
  instanceDir: string,
): Promise<OtelStackHandle | undefined> {
  const existing = await inspectOwnContainers(execution);
  const names = OTEL_CONTAINER_NAMES;
  if (![names.collector, names.jaeger, names.prometheus].every((name) => existing.has(name))) {
    return undefined;
  }

  const otelDir = join(instanceDir, "otel");
  mkdirSync(otelDir, { recursive: true, mode: 0o700 });
  const collector = await attachToRunningContainer(execution, names.collector, join(otelDir, "fit-cli-otel-collector.log"));
  const jaeger = await attachToRunningContainer(execution, names.jaeger, join(otelDir, "fit-cli-otel-jaeger.log"));
  const prometheus = await attachToRunningContainer(execution, names.prometheus, join(otelDir, "fit-cli-otel-prometheus.log"));
  return { service: "otel", collector, jaeger, prometheus, endpoints: otelEndpoints(), artifacts: [], details: [] };
}

/** Best-effort `docker rm -f` of a stale/partial set of our own containers before recreating. */
async function removeStaleContainers(execution: FitExecutionContext, names: readonly string[]): Promise<void> {
  if (names.length === 0) return;
  console.log(`\n→ Removing stale otel container(s): ${names.join(", ")}`);
  await execution.run(execution.dockerCommand, ["rm", "-f", ...names]).catch(() => {});
}

async function removeStackResources(execution: FitExecutionContext): Promise<void> {
  await execution.run(execution.dockerCommand, ["rm", "-f", ...Object.values(OTEL_CONTAINER_NAMES)]).catch(() => {});
  await execution.run(execution.dockerCommand, ["network", "rm", OTEL_NETWORK]).catch(() => {});
  await execution.run(execution.dockerCommand, ["volume", "rm", OTEL_BADGER_VOLUME]).catch(() => {});
}

/**
 * Clean up after a start that failed part-way, and keep the logs that say why.
 *
 * Removal comes first because `docker logs --follow` only reaches EOF once its
 * container is gone — draining a still-running container would hang here forever.
 * Nothing is returned as an artifact: the caller is about to throw, so the handle
 * carrying those artifacts never reaches the run, hence the paths printed instead.
 */
async function teardownPartialStack(execution: FitExecutionContext, started: readonly OtelContainerHandle[]): Promise<void> {
  await removeStackResources(execution);
  const collected: string[] = [];
  for (const handle of started) {
    await handle.logStream.drain().catch(() => {});
    const path = await execution.collectFile(execution.targetFilePath(handle.logFile), handle.logFile).catch(() => undefined);
    if (path) collected.push(path);
  }
  if (collected.length > 0) {
    console.log(`  Kept the failed stack's container logs:\n${collected.map((path) => `    ${path}`).join("\n")}`);
  }
}

/**
 * Remove a partial set of our own containers — one that isn't all three, so
 * {@link findRunningOtelStack} can't build a handle for it and `otel stop` would
 * otherwise walk away leaving them behind. Returns the names it found, empty if
 * the box holds none of ours.
 */
export async function removeOtelStackRemnants(execution: FitExecutionContext): Promise<string[]> {
  const existing = await inspectOwnContainers(execution);
  if (existing.size === 0) {
    return [];
  }
  await removeStackResources(execution);
  return [...existing.keys()];
}

/**
 * Create the named volume Jaeger persists its badger store to, world writable so
 * the image's non-root UID can actually open it — see OTEL_BADGER_VOLUME
 * for why a volume and not a bind mount.
 *
 * Removed and recreated rather than reused: the volume name is fixed per box, so a
 * leaked one would show a previous run's traces in this run's dump. Must be called
 * after the stale containers are removed, or `docker volume rm` refuses while one
 * still references it.
 *
 * `chmodImage` only has to be some image with a shell utility and a non-distroless
 * base; the Prometheus image is used because it is already being pulled for this
 * same stack, so this costs no extra download. `--user 0:0` because it otherwise
 * runs as that image's own non-root user and the chmod fails with "Operation not
 * permitted".
 */
export async function ensureBadgerVolume(execution: FitExecutionContext, chmodImage: string): Promise<void> {
  await execution.run(execution.dockerCommand, ["volume", "rm", OTEL_BADGER_VOLUME]).catch(() => {});
  await execution.runHiddenUntilFailure(execution.dockerCommand, ["volume", "create", OTEL_BADGER_VOLUME]);
  await execution.run(
    execution.dockerCommand,
    [
      "run",
      "--rm",
      "--user",
      "0:0",
      "--entrypoint",
      "chmod",
      "--volume",
      `${OTEL_BADGER_VOLUME}:${OTEL_BADGER_DIR}`,
      chmodImage,
      "1777",
      OTEL_BADGER_DIR,
    ],
    undefined,
    { display: `docker run --rm --entrypoint chmod ... 1777 ${OTEL_BADGER_DIR}` },
  );
}

async function checkPortsFreeOrFail(execution: FitExecutionContext): Promise<void> {
  for (const port of Object.values(OTEL_PORTS)) {
    const availability = await checkPortAvailability(execution, port);
    if (availability.available === false) {
      throwFatalToCluster(
        `Port ${port} (needed by fit-cli's otel stack) is already in use on ${execution.description} ` +
          `by something other than fit-cli's own containers. Free it and try again, or run ` +
          `\`docker ps\` to see what's holding it.`,
      );
    }
  }
}

/**
 * Poll `GET /api/v1/targets` and confirm Prometheus is actually scraping the
 * collector — up but unscraped is exactly the silent failure this whole
 * feature exists to avoid, and no per-container health check catches it.
 */
async function waitForPrometheusScrapingCollector(execution: FitExecutionContext): Promise<boolean> {
  return pollUntil(
    async () => {
      const out = await execution.capture("curl", ["-sf", `http://localhost:${OTEL_PORTS.prometheus}/api/v1/targets`], undefined, {
        quiet: true,
      });
      const parsed = JSON.parse(out) as { data?: { activeTargets?: Array<{ labels?: { job?: string }; health?: string }> } };
      return (parsed.data?.activeTargets ?? []).some((target) => target.labels?.job === "otel-collector" && target.health === "up");
    },
    20_000,
    1000,
  );
}

async function runHealthGate(execution: FitExecutionContext): Promise<void> {
  const collectorUp = await pollUntil(
    () => execution.capture("curl", ["-sf", `http://localhost:${OTEL_PORTS.collectorHealth}/`], undefined, { quiet: true }).then(() => true),
    10_000,
  );
  if (!collectorUp) {
    throwFatalToCluster(`The otel collector's health_check endpoint (http://localhost:${OTEL_PORTS.collectorHealth}/) never came up.`);
  }

  const jaegerUp = await pollUntil(
    () => execution.capture("curl", ["-sf", `http://localhost:${OTEL_PORTS.jaegerUi}/`], undefined, { quiet: true }).then(() => true),
    10_000,
  );
  if (!jaegerUp) {
    throwFatalToCluster(`Jaeger (http://localhost:${OTEL_PORTS.jaegerUi}/, fronting the gRPC query port ${OTEL_PORTS.jaegerQueryGrpc}) never came up.`);
  }

  const prometheusUp = await pollUntil(
    () => execution.capture("curl", ["-sf", `http://localhost:${OTEL_PORTS.prometheus}/-/ready`], undefined, { quiet: true }).then(() => true),
    10_000,
  );
  if (!prometheusUp) {
    throwFatalToCluster(`Prometheus (http://localhost:${OTEL_PORTS.prometheus}/-/ready) never came up.`);
  }

  if (!(await waitForPrometheusScrapingCollector(execution))) {
    throwFatalToCluster(
      `Prometheus is up but isn't scraping the otel collector (checked ` +
        `http://localhost:${OTEL_PORTS.prometheus}/api/v1/targets). Metrics tests would silently ` +
        `time out against this stack, so failing fast instead.`,
    );
  }
}

/**
 * @param instanceDir The box's instance artifact directory (e.g. the result of
 *   `instanceRunDir(group.path)`) — configs/logs are written under
 *   `<instanceDir>/otel`.
 */
export async function startOtelStack(
  execution: FitExecutionContext,
  instanceDir: string,
  otel: OtelDefaults,
): Promise<OtelStackHandle> {
  if (!(await execution.commandAvailable("docker")) || !(await execution.capture(execution.dockerCommand, ["info"], undefined, { quiet: true }).then(() => true).catch(() => false))) {
    throwFatalToCluster(`Docker isn't available (or isn't running) on ${execution.description} — start Docker and retry.`);
  }

  const otelDir = join(instanceDir, "otel");
  mkdirSync(otelDir, { recursive: true, mode: 0o700 });

  const artifacts: Artifact[] = [];
  const details: Detail[] = [];
  const endpoints = otelEndpoints();
  const endpointsPath = join(otelDir, "endpoints.json");
  writeFileSync(endpointsPath, `${JSON.stringify(endpoints, null, 2)}\n`, { mode: 0o600 });
  artifacts.push(artifactFromPath(endpointsPath, "The exact otel endpoints injected into FITConfiguration.json for this run"));

  const collectorLogFile = join(otelDir, "fit-cli-otel-collector.log");
  const jaegerLogFile = join(otelDir, "fit-cli-otel-jaeger.log");
  const prometheusLogFile = join(otelDir, "fit-cli-otel-prometheus.log");
  artifacts.push(
    artifactFromPath(collectorLogFile, "OTel collector container logs for this run's otel stack"),
    artifactFromPath(jaegerLogFile, "Jaeger container logs for this run's otel stack"),
    artifactFromPath(prometheusLogFile, "Prometheus container logs for this run's otel stack"),
  );

  const existing = await inspectOwnContainers(execution);
  const runningNames = [...existing.entries()].filter(([, running]) => running).map(([name]) => name);
  const allThreeRunning = Object.values(OTEL_CONTAINER_NAMES).every((name) => runningNames.includes(name));

  let collector: OtelContainerHandle;
  let jaeger: OtelContainerHandle;
  let prometheus: OtelContainerHandle;
  let windowStart: string;
  // Whatever has actually come up, so a failure part-way can still collect its logs.
  const started: OtelContainerHandle[] = [];

  if (allThreeRunning) {
    console.log(`→ Adopting the otel stack already running on ${execution.description}.`);
    // Now, not the container's start time: this stack ran for an earlier process, and
    // its data belongs to that run rather than this one.
    windowStart = new Date().toISOString();
    collector = await attachToRunningContainer(execution, OTEL_CONTAINER_NAMES.collector, collectorLogFile);
    jaeger = await attachToRunningContainer(execution, OTEL_CONTAINER_NAMES.jaeger, jaegerLogFile);
    prometheus = await attachToRunningContainer(execution, OTEL_CONTAINER_NAMES.prometheus, prometheusLogFile);
    started.push(collector, jaeger, prometheus);
  } else {
    if (existing.size > 0) {
      await removeStaleContainers(execution, [...existing.keys()]);
    }
    await checkPortsFreeOrFail(execution);

    const images = otelImages(otel);
    console.log(`\nPulling otel stack images on ${execution.description}...`);
    for (const image of [images.collector, images.jaeger, images.prometheus]) {
      try {
        await execution.runHiddenUntilFailure(execution.dockerCommand, ["pull", image]);
      } catch (err) {
        throwFatalToCluster(
          `Failed to pull ${image}: ${(err as Error).message}\n` +
            `  If this is a Docker Hub rate limit, \`docker login\` first to raise the anonymous pull limit.`,
        );
      }
    }

    await ensureDockerNetwork(execution, OTEL_NETWORK);

    const collectorConfigPath = join(otelDir, "otel-collector-config.yaml");
    const prometheusConfigPath = join(otelDir, "prometheus.yml");
    artifacts.push(
      artifactFromPath(collectorConfigPath, "OTel collector config for this run's ephemeral otel stack"),
      artifactFromPath(prometheusConfigPath, "Prometheus config for this run's ephemeral otel stack"),
    );

    await ensureBadgerVolume(execution, images.prometheus);

    // Before the containers rather than after: a window that opens a few seconds early
    // costs an empty leading range, whereas one that opens late drops real data.
    windowStart = new Date().toISOString();
    try {
      collector = await createAndStartContainer(
        execution,
        {
          name: OTEL_CONTAINER_NAMES.collector,
          createArgs: collectorCreateArgs(images.collector),
          config: { localPath: collectorConfigPath, content: collectorConfigYaml(), containerPath: OTEL_CONFIG_PATHS.collector },
        },
        collectorLogFile,
      );
      started.push(collector);
      jaeger = await createAndStartContainer(execution, { name: OTEL_CONTAINER_NAMES.jaeger, createArgs: jaegerCreateArgs(images.jaeger) }, jaegerLogFile);
      started.push(jaeger);
      prometheus = await createAndStartContainer(
        execution,
        {
          name: OTEL_CONTAINER_NAMES.prometheus,
          createArgs: prometheusCreateArgs(images.prometheus),
          config: { localPath: prometheusConfigPath, content: prometheusConfigYaml(), containerPath: OTEL_CONFIG_PATHS.prometheus },
        },
        prometheusLogFile,
      );
      started.push(prometheus);
    } catch (err) {
      // Best-effort teardown of whatever partial set came up, so a failed start
      // doesn't leave half a stack squatting on our fixed names/ports.
      await teardownPartialStack(execution, started);
      throw err;
    }
  }

  try {
    await runHealthGate(execution);
  } catch (err) {
    // Inside the cleanup path, not before it: the gate is the likeliest thing to fail on
    // a flaky box, and it throws before a handle exists — so nothing would have been in
    // activeExternalServices for teardown to stop, and all three containers, the network
    // and the badger volume would have been left on the box. An adopted stack goes the
    // same way: it just failed its own health gate, so leaving it up only means the next
    // run adopts it and fails identically.
    await teardownPartialStack(execution, started);
    throw err;
  }

  return { service: "otel", collector, jaeger, prometheus, endpoints, windowStart, artifacts, details };
}

async function runStartOtelStack(dir?: string): Promise<void> {
  const execution = createLocalFitExecutionContext();
  const instanceDir = dir ?? instanceRunDir({ instanceIndex: 0 });
  const stack = await startOtelStack(execution, instanceDir, loadEnvironments().externalServices.otel);
  console.log(`\n✓ Otel stack is up:`);
  console.log(JSON.stringify(stack.endpoints, null, 2));
}

const START_OTEL_STACK_HELP = `Start fit-cli's ephemeral local otel stack (collector + Jaeger + Prometheus).

Usage:
  bun src/fit/external-services/otel/start/start-otel-stack.ts [--dir <instance-dir>]

Options:
  --dir <path>   Instance artifact directory to write configs/logs under (e.g. /tmp/fit-cli/<run>/instances/0).
                 Defaults to a fresh run directory when omitted.
  --help, -h     Show this help.`;

if (isMain(import.meta.url)) {
  runCli(async () => {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
      console.log(START_OTEL_STACK_HELP);
      return;
    }
    const dirIndex = args.indexOf("--dir");
    const dir = dirIndex !== -1 ? args[dirIndex + 1] : undefined;
    await runStartOtelStack(dir);
  });
}
