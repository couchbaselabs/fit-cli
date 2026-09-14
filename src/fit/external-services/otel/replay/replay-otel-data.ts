/**
 * Step: bring the Jaeger and Prometheus UIs back up over a *finished* run's
 * dumped traces and metrics.
 *
 * This is the payoff for dump-otel-data.ts. The stack a run used is long
 * gone, but its artifacts aren't, so this starts a fresh throwaway stack over the
 * dumps instead of over a live performer. Both servers work the same way: each is
 * handed the other one's dumped store as its own, so nothing is re-ingested and no
 * collector is involved at all.
 *
 *  - Jaeger runs on the dumped badger store, so the spans come back with their
 *    original trace IDs and timestamps.
 *  - Prometheus runs on the dumped TSDB snapshot, so all of PromQL works over the
 *    original run window.
 *
 * Separate container names and ports from the live stack (see REPLAY_* below), so
 * replaying an old run can't collide with a run in progress on the same box.
 *
 * Run on its own:
 *   bun src/fit/external-services/otel/replay/replay-otel-data.ts /tmp/fit-cli/<run>/instances/0/otel
 *   bun src/fit/external-services/otel/replay/replay-otel-data.ts --stop
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Detail, type RunOutput } from "../../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../../../util/non-fit/fit-cli-log.js";
import { throwFatalToCluster } from "../../../shared/failure-classification.js";
import { createLocalFitExecutionContext, type FitExecutionContext } from "../../../shared/util/remote-fit-run.js";
import { ensureDockerNetwork } from "../../../../cluster/cluster-create/setup-declarative-cluster.js";
import { loadEnvironments, type OtelDefaults } from "../../../util/environments.js";
import {
  OTEL_BADGER_DIR,
  OTEL_BADGER_TAR_FILENAME,
  OTEL_CONFIG_PATHS,
  otelImages,
  PROMETHEUS_TSDB_PATH,
} from "../util/otel-topology.js";
import { jaegerSearchUrl, prometheusGraphUrl, type OtelWindow } from "../util/otel-dump-format.js";

/**
 * Deliberately distinct from the live stack's names, network and ports: someone
 * debugging yesterday's failure should be able to do it while a run is going on.
 */
export const REPLAY_NETWORK = "fit-otel-replay";

export const REPLAY_CONTAINER_NAMES = {
  jaeger: "fit-cli-otel-replay-jaeger",
  prometheus: "fit-cli-otel-replay-prometheus",
} as const;

export const REPLAY_PORTS = {
  jaegerUi: 26686,
  prometheus: 19090,
} as const;

/**
 * Where the tarballs are unpacked before being `docker cp`'d in.
 *
 * Deliberately NOT inside the dump directory. That directory is a run's artifact
 * tree: putting an extracted TSDB and badger store there leaves hundreds of
 * kilobytes of pure duplicate next to the tarballs they came from, unregistered as
 * artifacts (so invisible in the run summary) yet swept up by
 * `archive s3-upload --zip`. Replaying a dump should leave it exactly as the dump
 * wrote it.
 *
 * Fixed path, like the container names and ports, and removed on `--stop`: there is
 * one replay stack per box, so there is one staging directory.
 */
export const REPLAY_STAGING_DIR = "/tmp/fit-cli-otel-replay";

/** Filenames the dump step writes, that this step reads back. */
export const DUMP_FILENAMES = {
  badgerTar: OTEL_BADGER_TAR_FILENAME,
  jaegerTraces: "traces.json",
  snapshotTar: "prometheus-snapshot.tar.gz",
  window: "window.json",
} as const;

/**
 * The replay Jaeger serves the dumped badger store as its own. The store is
 * `docker cp`'d into the container's own filesystem before it starts — no volume
 * and no bind mount, for the reasons on start-otel-stack.ts (in short:
 * fit-cli's artifacts live under /tmp, and a Docker Desktop whose file-sharing list
 * omits /tmp silently mounts an empty directory instead of the host one, which
 * fails as missing data rather than as an error).
 *
 * `--user 0:0` because `docker cp` lands the store root-owned, and badger needs to
 * write to it — it takes a lock and compacts on open, so this is not a read-only
 * workload even when only serving history. Least privilege buys nothing here: it's
 * a throwaway local container serving a dump already on the developer's disk.
 */
function jaegerReplayCreateArgs(image: string): string[] {
  return [
    "create",
    "--name",
    REPLAY_CONTAINER_NAMES.jaeger,
    "--network",
    REPLAY_NETWORK,
    "--publish",
    `${REPLAY_PORTS.jaegerUi}:16686`,
    "--user",
    "0:0",
    "--env",
    "SPAN_STORAGE_TYPE=badger",
    "--env",
    "BADGER_EPHEMERAL=false",
    "--env",
    `BADGER_DIRECTORY_KEY=${OTEL_BADGER_DIR}/key`,
    "--env",
    `BADGER_DIRECTORY_VALUE=${OTEL_BADGER_DIR}/data`,
    image,
  ];
}

/**
 * The replay Prometheus serves the dumped snapshot as its whole TSDB. A snapshot
 * directory is a valid TSDB on its own, so there is no import step — the extracted
 * blocks are `docker cp`'d into the container's own /prometheus before it starts.
 *
 * NOT a bind mount, for the reason the rest of this stack avoids them too (see
 * start-otel-stack.ts): fit-cli's artifact tree lives under /tmp, and a
 * Docker Desktop install whose file-sharing list omits /tmp silently mounts an
 * empty VM-local directory instead of the host one. That fails as an empty
 * Prometheus rather than an error — the blocks are simply never seen.
 *
 * `--user 0:0` is required, not incidental, and for two reasons. Prometheus is not
 * read-only even when only serving history: it mmaps `queries.active` and takes a
 * lock in its TSDB directory, dying with "Unable to create mmap-ed active query
 * log" if it can't. And `docker cp` lands the blocks root-owned, which the image's
 * default `nobody` then cannot read. Least privilege buys nothing here: this is a
 * throwaway local container serving a dump already sitting on the developer's disk.
 */
function prometheusReplayCreateArgs(image: string): string[] {
  return [
    "create",
    "--name",
    REPLAY_CONTAINER_NAMES.prometheus,
    "--network",
    REPLAY_NETWORK,
    "--publish",
    `${REPLAY_PORTS.prometheus}:9090`,
    "--user",
    "0:0",
    image,
    `--config.file=${OTEL_CONFIG_PATHS.prometheus}`,
    `--storage.tsdb.path=${PROMETHEUS_TSDB_PATH}`,
  ];
}

/**
 * Read the run window and the services seen back out of the dump, so the deep links
 * land on the right time range and name a service — a Jaeger search link without one
 * is rejected outright by Jaeger's own API. Both are optional: a dump written before
 * they were recorded still replays, just with a plainer link.
 */
function readWindowFile(dumpDir: string): { window?: OtelWindow; services: string[] } {
  const path = join(dumpDir, DUMP_FILENAMES.window);
  if (!existsSync(path)) return { services: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { window?: OtelWindow; services?: string[] };
    return { window: parsed.window, services: parsed.services ?? [] };
  } catch {
    return { services: [] };
  }
}

async function removeReplayStack(execution: FitExecutionContext): Promise<void> {
  await execution.run(execution.dockerCommand, ["rm", "-f", ...Object.values(REPLAY_CONTAINER_NAMES)]).catch(() => {});
  await execution.run(execution.dockerCommand, ["network", "rm", REPLAY_NETWORK]).catch(() => {});
  // The containers hold their own copies of the stores, so the staging copies are
  // dead weight the moment they've been cp'd in.
  await execution.removeTree(REPLAY_STAGING_DIR).catch(() => {});
}

export async function stopReplayStack(execution: FitExecutionContext): Promise<RunOutput> {
  console.log(`\nStopping the otel replay stack...`);
  await removeReplayStack(execution);
  console.log(`  ✓ Replay stack stopped.`);
  return { artifacts: [], details: [] };
}

export async function replayOtelData(
  execution: FitExecutionContext,
  dumpDir: string,
  otel: OtelDefaults,
): Promise<RunOutput> {
  const resolvedDumpDir = resolve(dumpDir);
  if (!existsSync(resolvedDumpDir)) {
    throwFatalToCluster(`No such dump directory: ${resolvedDumpDir}`);
  }

  const badgerTarPath = join(resolvedDumpDir, DUMP_FILENAMES.badgerTar);
  const snapshotTarPath = join(resolvedDumpDir, DUMP_FILENAMES.snapshotTar);
  const hasTraces = existsSync(badgerTarPath);
  const hasMetrics = existsSync(snapshotTarPath);
  if (!hasTraces && !hasMetrics) {
    throwFatalToCluster(
      `${resolvedDumpDir} has neither ${DUMP_FILENAMES.badgerTar} nor ${DUMP_FILENAMES.snapshotTar}, so there's nothing to replay.\n` +
        `  Point this at a run's <instance>/otel directory — e.g. /tmp/fit-cli/<run>/instances/0/otel`,
    );
  }

  const { window, services } = readWindowFile(resolvedDumpDir);
  const images = otelImages(otel);

  // A previous replay of a different run would otherwise be silently reused. This
  // also clears the staging directory, so it has to happen before it's populated.
  await removeReplayStack(execution);

  const workDir = REPLAY_STAGING_DIR;
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  await ensureDockerNetwork(execution, REPLAY_NETWORK);

  const details: Detail[] = [];

  if (hasMetrics) {
    const snapshotDir = join(workDir, "prometheus-tsdb");
    await execution.removeTree(snapshotDir).catch(() => {});
    mkdirSync(snapshotDir, { recursive: true, mode: 0o755 });
    // The tarball holds a single `prometheus-snapshot/` directory; --strip-components
    // lifts its contents up so the mount point itself is the TSDB root.
    await execution.run("tar", ["xzf", snapshotTarPath, "-C", snapshotDir, "--strip-components", "1"]);

    const configPath = join(workDir, "prometheus.yml");
    // No scrape_configs: this Prometheus serves history and must never try to
    // scrape a collector that no longer exists.
    writeFileSync(configPath, `# Replay-only Prometheus: serves the dumped TSDB, scrapes nothing.\nglobal:\n  scrape_interval: 1s\n`, { mode: 0o644 });

    const containerId = (await execution.capture(execution.dockerCommand, prometheusReplayCreateArgs(images.prometheus))).trim();
    await execution.run(execution.dockerCommand, ["cp", configPath, `${containerId}:${OTEL_CONFIG_PATHS.prometheus}`], undefined, {
      display: `docker cp prometheus.yml ${REPLAY_CONTAINER_NAMES.prometheus}:${OTEL_CONFIG_PATHS.prometheus}`,
    });
    // `<dir>/.` copies the blocks themselves in, rather than nesting them under
    // another directory level that Prometheus would not scan.
    await execution.run(execution.dockerCommand, ["cp", `${snapshotDir}/.`, `${containerId}:${PROMETHEUS_TSDB_PATH}`], undefined, {
      display: `docker cp <snapshot blocks> ${REPLAY_CONTAINER_NAMES.prometheus}:${PROMETHEUS_TSDB_PATH}`,
    });
    await execution.run(execution.dockerCommand, ["start", containerId], undefined, { display: `docker start ${REPLAY_CONTAINER_NAMES.prometheus}` });

    const baseUrl = `http://localhost:${REPLAY_PORTS.prometheus}`;
    details.push({
      label: "Prometheus (replay)",
      value: window ? prometheusGraphUrl(baseUrl, window, '{__name__=~"db_.+"}') : baseUrl,
      callToAction: true,
    });
  } else {
    console.warn(`  ⚠ No ${DUMP_FILENAMES.snapshotTar} in the dump — replaying traces only.`);
  }

  if (hasTraces) {
    const storeDir = join(workDir, "jaeger-badger");
    await execution.removeTree(storeDir).catch(() => {});
    mkdirSync(storeDir, { recursive: true, mode: 0o755 });
    await execution.run("tar", ["xzf", badgerTarPath, "-C", storeDir]);

    const jaegerId = (await execution.capture(execution.dockerCommand, jaegerReplayCreateArgs(images.jaeger))).trim();
    // `<dir>/.` so the store's own key/ and data/ land directly in the badger dir,
    // which is where BADGER_DIRECTORY_KEY/VALUE point.
    await execution.run(execution.dockerCommand, ["cp", `${storeDir}/.`, `${jaegerId}:${OTEL_BADGER_DIR}`], undefined, {
      display: `docker cp <badger store> ${REPLAY_CONTAINER_NAMES.jaeger}:${OTEL_BADGER_DIR}`,
    });
    await execution.run(execution.dockerCommand, ["start", jaegerId], undefined, { display: `docker start ${REPLAY_CONTAINER_NAMES.jaeger}` });

    const uiBase = `http://localhost:${REPLAY_PORTS.jaegerUi}`;
    // A pre-filled search needs both a window and a service; with either missing,
    // link the bare search page rather than a URL Jaeger would reject.
    for (const service of services.length > 0 ? services : [undefined]) {
      details.push({
        label: services.length > 1 ? `Jaeger (replay) — ${service ?? "search"}` : "Jaeger (replay)",
        value: window && service ? jaegerSearchUrl(uiBase, window, service) : `${uiBase}/search`,
        callToAction: true,
      });
    }
  } else {
    console.warn(`  ⚠ No ${DUMP_FILENAMES.badgerTar} in the dump — replaying metrics only.`);
  }

  console.log(`\n✓ Replaying ${resolvedDumpDir}`);
  if (window) {
    console.log(`  Run window: ${window.start} → ${window.end}`);
    console.log(`  The links below already have that window applied — without it both UIs default to "last hour" and look empty.`);
  }
  for (const detail of details) {
    console.log(`  ${detail.label}: ${detail.value}`);
  }
  if (hasTraces) {
    console.log(`\n  Jaeger opens its restored store on startup; give it a few seconds before searching.`);
    console.log(`  ${join(resolvedDumpDir, DUMP_FILENAMES.jaegerTraces)} can also be loaded straight into any Jaeger UI via its "JSON File" tab.`);
  }
  console.log(`\nThe replay stack keeps running after this command exits. Stop it with:\n  ${runScriptPrefix("external-services otel")} replay --stop`);

  details.push({ label: "Stop the replay stack", value: `${runScriptPrefix("external-services otel")} replay --stop` });
  return { artifacts: [], details };
}

const REPLAY_OTEL_DATA_HELP = `Bring the Jaeger and Prometheus UIs back up over a finished run's dumped traces and metrics.

The otel stack a run uses is torn down with the run, so this starts a fresh
throwaway stack wired to the dump artifacts instead of a live performer. It uses its
own container names and ports (Jaeger UI ${REPLAY_PORTS.jaegerUi}, Prometheus ${REPLAY_PORTS.prometheus}), so it
can't collide with a run in progress.

Usage:
  bun src/fit/external-services/otel/replay/replay-otel-data.ts <dump-dir>
  bun src/fit/external-services/otel/replay/replay-otel-data.ts --stop

Arguments:
  <dump-dir>   A run's otel artifact directory, e.g.
               /tmp/fit-cli/<run>/instances/0/otel

Options:
  --stop       Tear the replay stack down.
  --help, -h   Show this help.`;

if (isMain(import.meta.url)) {
  runCli(async () => {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
      console.log(REPLAY_OTEL_DATA_HELP);
      return;
    }
    const execution = createLocalFitExecutionContext();
    if (args.includes("--stop")) {
      return await stopReplayStack(execution);
    }
    const dumpDir = args.find((arg) => !arg.startsWith("-"));
    if (!dumpDir) {
      console.error(`A dump directory is required.\n`);
      console.error(REPLAY_OTEL_DATA_HELP);
      process.exit(2);
    }
    return await replayOtelData(execution, dumpDir, loadEnvironments().externalServices.otel);
  });
}
