/**
 * Step: dump everything the ephemeral otel stack collected, as
 * artifacts that outlive it.
 *
 * The stack is torn down at the end of every run, so by the time anyone debugs a
 * failing otel test the Jaeger and Prometheus UIs that would have shown
 * the traces/metrics are gone. This pulls the data out first.
 *
 * Both signals are captured the same way — snapshot the backing store, so it can be
 * restored into a fresh server later (see replay-otel-data.ts):
 *
 *  - `jaeger-badger.tar.gz` — Jaeger's badger span store.
 *  - `prometheus-snapshot.tar.gz` — a real Prometheus TSDB snapshot, i.e. full
 *    metric history rather than final values.
 *
 * Plus three things readable without starting anything at all:
 *
 *  - `traces.json` — Jaeger's own `/api/traces` format, which Jaeger UI can load
 *    directly via its "JSON File" upload. Drop it into any Jaeger and you get the
 *    real waterfall view.
 *  - `metrics.json` — the same history from `query_range`.
 *  - `traces.txt`/`metrics.txt` — ISO-8601 UTC sorted indexes, for lining the data
 *    up against the driver log — and `window.json` with the run window and
 *    pre-built deep links.
 *
 * Run on its own against a stack that's already up (start one with
 * start-otel-stack.ts first — this dumps and changes nothing):
 *   bun src/fit/external-services/otel/stop/dump-otel-data.ts
 *   bun src/fit/external-services/otel/stop/dump-otel-data.ts --dir /tmp/fit-cli/<run>/instances/0
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { artifactFromPath, type Artifact, type Detail, type RunOutput } from "../../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../../util/non-fit/cli.js";
import { posixQuote } from "../../../../util/non-fit/remote-target.js";
import { instanceRunDir } from "../../../../util/non-fit/replay.js";
import { throwFatalToCluster } from "../../../shared/failure-classification.js";
import { createLocalFitExecutionContext, type FitExecutionContext } from "../../../shared/util/remote-fit-run.js";
import {
  OTEL_BADGER_DIR,
  OTEL_BADGER_TAR_FILENAME,
  OTEL_CONTAINER_NAMES,
  OTEL_PORTS,
  PROMETHEUS_TSDB_PATH,
} from "../util/otel-topology.js";
import {
  isInterestingJaegerService,
  JAEGER_INTERNAL_SERVICE,
  jaegerSearchUrl,
  metricNamesToDump,
  prometheusGraphUrl,
  renderMetricIndex,
  renderTraceIndex,
  type JaegerTrace,
  type OtelWindow,
  type PrometheusRangeSeries,
} from "../util/otel-dump-format.js";
import { runScriptPrefix } from "../../../../util/non-fit/fit-cli-log.js";

/** Cap on spans pulled per service. High enough for any functional run; stops a runaway from hanging teardown. */
const TRACE_LIMIT_PER_SERVICE = 1500;

/** Target number of points per series in the query_range dump — keeps it readable and well under Prometheus' 11k cap. */
const MAX_POINTS_PER_SERIES = 2000;

const jaegerBase = `http://localhost:${OTEL_PORTS.jaegerUi}`;
const prometheusBase = `http://localhost:${OTEL_PORTS.prometheus}`;

/**
 * Responses that are parsed and re-serialised, rather than kept exactly as they
 * arrive, land here first — on the execution target and locally. Removed at the end
 * of the dump so only the artifacts themselves are left behind.
 */
const DUMP_SCRATCH_DIRNAME = ".scratch";

/**
 * Fetch a URL from the stack straight into a file on the execution target, collect
 * that file, and return the local path written.
 *
 * Deliberately not `capture`. A captured stdout comes back from a remote box through
 * SSM, whose inline copy is capped at ~24000 characters (see ssm-target.ts), and every
 * real trace or metric dump is far larger than that — which is how this dump came back
 * all but empty from EC2 while passing locally. A collected file is relayed via S3 and
 * has no such ceiling; it is how the TSDB snapshot already travels.
 */
export async function curlToLocalFile(execution: FitExecutionContext, url: string, localPath: string, extraArgs: string[] = []): Promise<string> {
  const targetPath = execution.targetFilePath(localPath);
  // --create-dirs: the target-side directory may not exist yet, and this saves a round
  // trip to make it. -S: keep curl's own diagnostics, which -s alone suppresses, so a
  // failure says what went wrong.
  await execution.runHiddenUntilFailure("curl", ["-sS", "-f", "--create-dirs", "-o", targetPath, ...extraArgs, url], undefined, {
    display: `curl ${url} -> ${basename(localPath)}`,
  });
  const collected = await execution.collectFile(targetPath, localPath);
  if (collected !== localPath) {
    throw new Error(`Expected the response at ${localPath}, but it was too large to decompress and was kept at ${collected}.`);
  }
  return tightenPermissions(collected);
}

/** {@link curlToLocalFile} for a response we parse and discard rather than keep. */
async function fetchJson<T>(execution: FitExecutionContext, url: string, localPath: string, extraArgs: string[] = []): Promise<T> {
  await curlToLocalFile(execution, url, localPath, extraArgs);
  return JSON.parse(readFileSync(localPath, "utf8")) as T;
}

/**
 * The one shape of response still safe to read off stdout: one structurally short
 * line, however large the run was. Anything whose size grows with the data collected
 * must go through {@link fetchJson} instead.
 */
async function captureShortJson<T>(execution: FitExecutionContext, url: string, extraArgs: string[] = []): Promise<T> {
  const out = await execution.capture("curl", ["-sf", ...extraArgs, url], undefined, { quiet: true });
  return JSON.parse(out) as T;
}

/**
 * Hand back ownership of a tree just copied out of a container with `docker cp`.
 *
 * `docker cp` preserves the in-container ownership, so on a Linux target (every EC2
 * box) files a container wrote as root land root-owned — and the `tar` and cleanup
 * that follow, which run as the login user, fail with "Cannot open: Permission
 * denied". Best-effort on purpose: where Docker already writes the copy user-owned
 * (Docker Desktop on macOS) there is nothing to fix and no passwordless sudo to do it
 * with, and if the chown really was needed the `tar` that follows still says so.
 */
async function takeOwnershipOfCopiedTree(execution: FitExecutionContext, targetDir: string): Promise<void> {
  await execution
    .run("sh", ["-c", `sudo -n chown -R "$(id -u):$(id -g)" ${posixQuote(targetDir)}`], undefined, {
      display: `sudo chown -R $(id -u):$(id -g) ${basename(targetDir)}`,
    })
    .catch(() => {});
}

/** Remove the scratch tree from both sides. Best-effort: leftovers are noise, not a failed dump. */
async function removeScratchDir(execution: FitExecutionContext, scratchDir: string): Promise<void> {
  await execution.removeTree(execution.targetFilePath(scratchDir)).catch(() => {});
  rmSync(scratchDir, { recursive: true, force: true });
}

/**
 * Files that arrive via `docker cp`/`tar` land 0644, unlike the 0600 everything
 * written directly by fit-cli uses. Normalised so the artifact tree has one
 * permission story rather than two.
 */
function tightenPermissions(path: string): string {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Non-fatal: the file is already inside a 0700 artifact directory.
  }
  return path;
}

/**
 * The run window, used for the query_range range, the Jaeger search bounds, and both
 * deep links: from when the stack became this run's, to now.
 *
 * `windowStart` comes from the stack handle whenever there is one. Falling back to
 * Docker's record of the collector's start is only right when there isn't — the
 * standalone CLI below, and `otel stop` attaching to a stack it didn't start, both of
 * which do want everything the containers have held. For a run it would be wrong: an
 * adopted stack's collector started during an earlier run, and that run's traces and
 * metrics would land in this one's dump.
 */
async function resolveWindow(execution: FitExecutionContext, windowStart?: string): Promise<OtelWindow> {
  const end = new Date().toISOString();
  if (windowStart) {
    return { start: windowStart, end };
  }
  try {
    const startedAt = await execution.capture(
      execution.dockerCommand,
      ["inspect", "--format", "{{.State.StartedAt}}", OTEL_CONTAINER_NAMES.collector],
      undefined,
      { quiet: true },
    );
    // Docker returns RFC3339Nano; normalise to the same ISO-8601 millis everything else uses.
    return { start: new Date(startedAt.trim()).toISOString(), end };
  } catch {
    // Fall back to a generous window rather than giving up on the whole dump.
    return { start: new Date(Date.parse(end) - 60 * 60 * 1000).toISOString(), end };
  }
}

/**
 * Pull every trace Jaeger holds, per service, and merge them into one
 * `/api/traces`-shaped document. Deduplicated by traceID: a trace crossing two
 * services comes back from both queries.
 */
async function dumpJaegerTraces(
  execution: FitExecutionContext,
  otelDir: string,
  scratchDir: string,
  window: OtelWindow,
): Promise<{ artifacts: Artifact[]; services: string[] }> {
  try {
    const services = await fetchJson<{ data?: string[] }>(execution, `${jaegerBase}/api/services`, join(scratchDir, "services.json"));
    const wanted = (services.data ?? []).filter(isInterestingJaegerService).sort();
    if (wanted.length === 0) {
      console.warn(`  ⚠ Jaeger reported no services other than ${JAEGER_INTERNAL_SERVICE} — no traces to dump.`);
      return { artifacts: [], services: [] };
    }

    const byTraceId = new Map<string, JaegerTrace>();
    for (const [index, service] of wanted.entries()) {
      const params = new URLSearchParams({
        service,
        limit: String(TRACE_LIMIT_PER_SERVICE),
        start: String(Date.parse(window.start) * 1000),
        end: String(Date.parse(window.end) * 1000),
      });
      const response = await fetchJson<{ data?: JaegerTrace[] }>(
        execution,
        `${jaegerBase}/api/traces?${params.toString()}`,
        join(scratchDir, `traces-${index}.json`),
      );
      for (const trace of response.data ?? []) {
        byTraceId.set(trace.traceID, trace);
      }
    }

    const traces = [...byTraceId.values()];
    const jsonPath = join(otelDir, "traces.json");
    const indexPath = join(otelDir, "traces.txt");
    // Shaped exactly like a real /api/traces response so Jaeger UI's "JSON File"
    // upload accepts it — it validates the envelope, not just the data array.
    writeFileSync(jsonPath, `${JSON.stringify({ data: traces, total: traces.length, limit: 0, offset: 0, errors: null }, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(indexPath, renderTraceIndex(traces), { mode: 0o600 });

    console.log(`  ✓ Dumped ${traces.length} trace(s) from ${wanted.length} service(s).`);
    return {
      artifacts: [
        artifactFromPath(jsonPath, "Every trace Jaeger held for this run, in Jaeger's own format — load it via the Jaeger UI's 'JSON File' upload"),
        artifactFromPath(indexPath, "One line per span, sorted by ISO-8601 UTC start time, for lining traces up against the driver log"),
      ],
      services: wanted,
    };
  } catch (err) {
    console.warn(`  ⚠ Couldn't dump traces from Jaeger: ${(err as Error).message}`);
    return { artifacts: [], services: [] };
  }
}

/**
 * Snapshot Jaeger's badger store — the trace equivalent of the Prometheus TSDB
 * snapshot, and what `fit external-services otel replay` restores into a fresh Jaeger.
 *
 * MUST be called with the Jaeger container stopped but not yet removed. Badger
 * buffers writes, so copying from a running Jaeger can catch a store mid-write and
 * yield one that a fresh Jaeger then refuses or reads short; stopping the container
 * flushes and releases it. `docker cp` still works on a stopped container, so this
 * sits between the `docker stop` and the `docker rm` in stopOtelStack.
 */
export async function dumpJaegerBadgerStore(execution: FitExecutionContext, otelDir: string): Promise<Artifact[]> {
  const localTarPath = join(otelDir, OTEL_BADGER_TAR_FILENAME);
  const targetTarPath = execution.targetFilePath(localTarPath);
  const targetStoreDir = execution.targetFilePath(join(otelDir, "jaeger-badger"));
  try {
    await execution.removeTree(targetStoreDir).catch(() => {});
    await execution.run(
      execution.dockerCommand,
      ["cp", `${OTEL_CONTAINER_NAMES.jaeger}:${OTEL_BADGER_DIR}`, targetStoreDir],
      undefined,
      { display: `docker cp ${OTEL_CONTAINER_NAMES.jaeger}:${OTEL_BADGER_DIR} jaeger-badger` },
    );
    await takeOwnershipOfCopiedTree(execution, targetStoreDir);
    // `-C <dir> .` so the archive holds the store's contents at its root, which is
    // what the replay side copies straight back into a container's badger dir.
    await execution.run("tar", ["czf", targetTarPath, "-C", targetStoreDir, "."]);
    const collectedPath = tightenPermissions(await execution.collectFile(targetTarPath, localTarPath));
    console.log(`  ✓ Captured Jaeger's badger store.`);
    return [artifactFromPath(collectedPath, "Jaeger's span store for this run — restore it with `" + runScriptPrefix("external-services otel replay" + "`"))];
  } catch (err) {
    console.warn(`  ⚠ Couldn't capture Jaeger's badger store: ${(err as Error).message}`);
    return [];
  } finally {
    await execution.removeTree(targetStoreDir).catch(() => {});
  }
}

/**
 * A real TSDB snapshot: the only dump that preserves full metric history in a
 * form a Prometheus can serve. Copied out of the container and tarred, because
 * a snapshot is a directory tree of chunk files.
 */
async function dumpPrometheusSnapshot(execution: FitExecutionContext, otelDir: string): Promise<Artifact[]> {
  const localTarPath = join(otelDir, "prometheus-snapshot.tar.gz");
  const targetTarPath = execution.targetFilePath(localTarPath);
  const targetSnapshotDir = execution.targetFilePath(join(otelDir, "prometheus-snapshot"));
  try {
    // Safe on stdout: the reply is just the snapshot's name.
    const response = await captureShortJson<{ status?: string; data?: { name?: string } }>(
      execution,
      `${prometheusBase}/api/v1/admin/tsdb/snapshot`,
      ["-X", "POST"],
    );
    const name = response.data?.name;
    if (!name) {
      throw new Error(`Prometheus did not return a snapshot name (status=${response.status ?? "?"}). Is --web.enable-admin-api set?`);
    }

    await execution.removeTree(targetSnapshotDir).catch(() => {});
    await execution.run(
      execution.dockerCommand,
      ["cp", `${OTEL_CONTAINER_NAMES.prometheus}:${PROMETHEUS_TSDB_PATH}/snapshots/${name}`, targetSnapshotDir],
      undefined,
      { display: `docker cp ${OTEL_CONTAINER_NAMES.prometheus}:snapshots/${name} prometheus-snapshot` },
    );
    // The snapshot's own files happen to be world-readable, but the directories they
    // arrive in are not writable by us, which is enough to fail the cleanup below.
    await takeOwnershipOfCopiedTree(execution, targetSnapshotDir);
    // tar on the execution target, not inside the container: the Prometheus image
    // is busybox-based and not guaranteed to carry a usable tar.
    await execution.run("tar", ["czf", targetTarPath, "-C", execution.targetFilePath(otelDir), "prometheus-snapshot"]);
    const collectedPath = tightenPermissions(await execution.collectFile(targetTarPath, localTarPath));
    console.log(`  ✓ Captured the Prometheus TSDB snapshot (${name}).`);
    return [
      artifactFromPath(
        collectedPath,
        "Full Prometheus TSDB snapshot for this run — replay it with `fit external-services otel replay`, or mount it into any prom/prometheus",
      ),
    ];
  } catch (err) {
    console.warn(`  ⚠ Couldn't snapshot the Prometheus TSDB: ${(err as Error).message}`);
    return [];
  } finally {
    await execution.removeTree(targetSnapshotDir).catch(() => {});
  }
}

/**
 * Every non-internal series over the run window, as JSON plus a rendered index.
 * Complements the snapshot: this one can be read (and grepped, and handed to an
 * LLM) without starting a Prometheus at all.
 */
async function dumpPrometheusRange(
  execution: FitExecutionContext,
  otelDir: string,
  scratchDir: string,
  window: OtelWindow,
): Promise<Artifact[]> {
  try {
    const names = await fetchJson<{ data?: string[] }>(
      execution,
      `${prometheusBase}/api/v1/label/__name__/values`,
      join(scratchDir, "metric-names.json"),
    );
    const wanted = metricNamesToDump(names.data ?? []);
    if (wanted.length === 0) {
      console.warn(`  ⚠ Prometheus holds no non-internal metric series — nothing to dump.`);
      return [];
    }

    const windowSeconds = Math.max(1, Math.ceil((Date.parse(window.end) - Date.parse(window.start)) / 1000));
    const step = Math.max(1, Math.ceil(windowSeconds / MAX_POINTS_PER_SERIES));
    const query = `{__name__=~"${wanted.join("|")}"}`;
    // POST, not GET: the query is one regex alternation over every metric name,
    // which outgrows what's safe to put in a URL.
    const response = await fetchJson<{ data?: { result?: PrometheusRangeSeries[] } }>(
      execution,
      `${prometheusBase}/api/v1/query_range`,
      join(scratchDir, "query-range.json"),
      [
        "-X",
        "POST",
        "--data-urlencode",
        `query=${query}`,
        "--data-urlencode",
        `start=${window.start}`,
        "--data-urlencode",
        `end=${window.end}`,
        "--data-urlencode",
        `step=${step}s`,
      ],
    );

    const series = response.data?.result ?? [];
    const jsonPath = join(otelDir, "metrics.json");
    const indexPath = join(otelDir, "metrics.txt");
    writeFileSync(jsonPath, `${JSON.stringify({ window, step: `${step}s`, metricNames: wanted, series }, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(indexPath, renderMetricIndex(series), { mode: 0o600 });

    console.log(`  ✓ Dumped ${series.length} metric series over the ${windowSeconds}s run window (step ${step}s).`);
    return [
      artifactFromPath(jsonPath, "Every non-internal metric series over the run window, from Prometheus query_range"),
      artifactFromPath(indexPath, "One line per metric sample, sorted by ISO-8601 UTC timestamp, for lining metrics up against the driver log"),
    ];
  } catch (err) {
    console.warn(`  ⚠ Couldn't dump metric history from Prometheus: ${(err as Error).message}`);
    return [];
  }
}

/**
 * The run window plus pre-built deep links. Without this a replayed stack opens
 * on its default "last hour", which for a dump replayed the next day is empty
 * and reads as "the data didn't survive".
 */
function writeWindowFile(otelDir: string, window: OtelWindow, services: string[]): Artifact {
  const path = join(otelDir, "window.json");
  const content = {
    "//": "The lifetime of this run's otel stack, and links that open a replayed stack on it. All times ISO-8601 UTC.",
    window,
    // Recorded because a Jaeger search deep link is invalid without a service
    // name, and by replay time there is no live Jaeger left to ask.
    services,
    replay: `fit external-services otel replay ${otelDir}`,
    deepLinks: {
      "//": "Valid once a stack is running on this box's usual ports — either a live run or `fit external-services otel replay`.",
      jaegerSearchByService: Object.fromEntries(services.map((service) => [service, jaegerSearchUrl(jaegerBase, window, service)])),
      prometheusAllFitMetrics: prometheusGraphUrl(prometheusBase, window, '{__name__=~"db_.+"}'),
    },
  };
  writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  return artifactFromPath(path, "This run's otel time window, the services seen, and deep links that open a replayed stack on it");
}

/**
 * @param otelDir The `<instanceDir>/otel` directory the stack's
 *   configs and logs already live in.
 */
export async function dumpOtelData(execution: FitExecutionContext, otelDir: string, windowStart?: string): Promise<RunOutput> {
  console.log(`\nDumping the otel stack's traces and metrics on ${execution.description}...`);
  mkdirSync(otelDir, { recursive: true, mode: 0o700 });

  const window = await resolveWindow(execution, windowStart);
  const scratchDir = join(otelDir, DUMP_SCRATCH_DIRNAME);
  const artifacts: Artifact[] = [];

  try {
    const traces = await dumpJaegerTraces(execution, otelDir, scratchDir, window);
    artifacts.push(...traces.artifacts);
    artifacts.push(...(await dumpPrometheusSnapshot(execution, otelDir)));
    artifacts.push(...(await dumpPrometheusRange(execution, otelDir, scratchDir, window)));
    artifacts.push(writeWindowFile(otelDir, window, traces.services));
  } finally {
    await removeScratchDir(execution, scratchDir);
  }

  const details: Detail[] = [
    { label: "Otel window", value: `${window.start} → ${window.end}` },
    { label: "Replay this run's traces/metrics", value: `fit external-services otel replay ${otelDir}` },
  ];

  return { artifacts, details };
}

const DUMP_OTEL_DATA_HELP = `Dump the traces and metrics held by fit-cli's ephemeral otel stack, as artifacts that outlive it.

Dumps only — it needs a stack already running, and never starts, stops or changes one.
Start one first with:
  bun src/fit/external-services/otel/start/start-otel-stack.ts

Covers everything that can be pulled from a live stack. The one piece it cannot take is
Jaeger's badger store, which has to be copied with Jaeger stopped — that runs at
teardown, so use stop-otel-stack.ts (which starts then stops a stack) to
exercise the whole dump including the trace store.

Usage:
  bun src/fit/external-services/otel/stop/dump-otel-data.ts [--dir <instance-dir>]

Options:
  --dir <path>   Where to write the dump: an instance artifact directory, under which an
                 otel/ subdirectory is created. Must be inside THIS invocation's
                 artifact directory (artifacts cannot live outside it), so this selects a
                 location rather than targeting a past run. Defaults to that dir.
  --help, -h     Show this help.

To view a dump afterwards, pass its otel/ directory to replay-otel-data.ts.`;

/**
 * Whether a stack is up, so the CLI can say so plainly instead of producing a dump
 * of nothing but warnings. Checks the collector because it's the container every
 * other piece of the dump depends on being reachable.
 */
async function otelStackIsRunning(execution: FitExecutionContext): Promise<boolean> {
  return await execution
    .capture(execution.dockerCommand, ["inspect", "--format", "{{.State.Running}}", OTEL_CONTAINER_NAMES.collector], undefined, { quiet: true })
    .then((out) => out.trim() === "true")
    .catch(() => false);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
      console.log(DUMP_OTEL_DATA_HELP);
      return;
    }
    const dirIndex = args.indexOf("--dir");
    const dir = dirIndex !== -1 ? args[dirIndex + 1] : undefined;
    const execution = createLocalFitExecutionContext();
    if (!(await otelStackIsRunning(execution))) {
      throwFatalToCluster(
        `No otel stack is running on ${execution.description} (looked for ${OTEL_CONTAINER_NAMES.collector}).\n` +
          `  This command only dumps — start a stack first:\n` +
          `    bun src/fit/external-services/otel/start/start-otel-stack.ts`,
      );
    }
    const instanceDir = dir ?? instanceRunDir({ instanceIndex: 0 });
    return await dumpOtelData(execution, join(instanceDir, "otel"));
  });
}
