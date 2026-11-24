/**
 * Workflow: run a FIT performance workload, in TypeScript.
 *
 * What it does, in order: wait for the cluster, read the facts a run records about it, recreate
 * its bucket, compact it, then for each
 * run connect to the performer, populate any document pool, stream the workload, and write
 * buckets.csv / metrics.csv / run.json5.
 *
 * Run on its own (the config is the file a definition-file run leaves behind as an artifact):
 *   bun src/fit/performance/run-perf-engine/run-perf-engine.ts perf-run-config.yaml
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { create } from "@bufbuild/protobuf";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import type { PerfTestSuite } from "../run-perf-driver/run-perf-driver.js";
import { Caps } from "../generated/performer.caps_pb.js";
import { ClusterConfigSchema } from "../generated/shared.cluster_pb.js";
import { TransactionsCleanupConfigSchema, TransactionsConfigSchema } from "../generated/shared.transaction_config_pb.js";
import { RawJsonTranscoderSchema, TranscoderSchema } from "../generated/shared.transcoders_pb.js";
import { AttributeSchema } from "../generated/observability.top_pb.js";
import { ConfigSchema as ObservabilityConfigSchema, TracingConfigSchema } from "../generated/observability.config_pb.js";
import { TransactionException } from "../generated/transactions.commands_pb.js";
import type { Result } from "../generated/run.top_level_pb.js";
import { connectPerformer, UNARY_CALL_OPTIONS, type PerformerClient } from "../../performers/util/performer-grpc.js";
import {
  buildPerfRequest,
  poolSizesIn,
  PERF_BUCKET,
  PERF_KEY_PREFACE,
  type PerfMergedSettings,
  type PerfOperation,
} from "./build-perf-request.js";
import { IGNORE_MOST_RECENT_SECS_OF_DATA, PerfBucketWriter, type PerfSample } from "./perf-buckets.js";
import {
  bucketItemCount,
  forceCompaction,
  measureClusterFacts,
  recreateBucket,
  waitForClusterReady,
  withMeasuredClusterFacts,
  type PerfClusterRest,
} from "./perf-cluster-rest.js";
import { buildPerfRunRecord, PerfMetricsWriter, shouldRecordRun, writePerfRunRecord, writePerfSkipMarker } from "./write-perf-bundle.js";

/**
 * Trace sampling, when the config names a collector (see {@link buildObservabilityConfig}).
 *
 * Hardcoded: it is a property of how every recorded datapoint was measured, so changing it would
 * make new numbers incomparable with the history for a reason that has nothing to do with the SDK
 * under test.
 */
const OBSERVABILITY_SAMPLING = 0.0001;

/** How often completed one-second buckets are flushed to disk during a run. */
const FLUSH_INTERVAL_MS = 1_000;

/** Concurrency used to populate a document pool, matching the Java `DocCreateThread`. */
const DOC_POOL_CONCURRENCY = 50;

/** How long to wait for the bucket's item count to catch up with a populated pool. */
const DOC_POOL_VERIFY_TIMEOUT_MS = 120_000;

export interface RunPerfEngineOptions {
  /** Root the TestSuite's relative `files.outputDirectory` resolves against. Defaults to cwd. */
  workingDir?: string;
  /** Skip the cluster setup (bucket recreate, compaction). Only for diagnosing the engine itself. */
  skipClusterSetup?: boolean;
}

export interface PerfEngineRunOutcome {
  runUuid: string;
  outputDir: string;
  bucketRows: number;
  resultsReceived: number;
  /** Operations the performer reported as failed, across the whole run. */
  failures: number;
  /** Why the run was skipped without measuring anything (see workloadSkipReason), if it was. */
  skipped?: string;
}

export interface PerfEngineOutcome {
  runs: PerfEngineRunOutcome[];
}

/** Flatten a TestSuite's variable list into the map the request builder works from. */
export function mergeSettings(testSuite: PerfTestSuite, runIndex: number): PerfMergedSettings {
  const variables: Record<string, string | number | boolean> = {};
  const tunableNames: string[] = [];
  // fit-cli emits one settings block, at the top level. The format also allows per-run
  // settings that override it, and configs in the wild use that shape, so both are handled.
  for (const block of [testSuite.settings, testSuite.runs[runIndex].settings]) {
    for (const variable of block?.variables ?? []) {
      variables[variable.name] = variable.value;
      if (variable.type === "tunable" && !tunableNames.includes(variable.name)) {
        tunableNames.push(variable.name);
      }
    }
  }
  const grpc = { ...testSuite.settings.grpc, ...testSuite.runs[runIndex].settings?.grpc };
  return { variables, tunableNames, ...(Object.keys(grpc).length > 0 ? { grpc } : {}) };
}

/**
 * Point the performer's OpenTelemetry traces at `otlpGrpc`: in a definition-file run, the box's
 * own otel stack, whose teardown dumps them into the instance's `otel/` artifacts. Traces carry
 * the run's uuid as a resource attribute, so a box that ran several workloads can tell them apart.
 *
 * Tracing only, as the Java perf driver configured it (`PerformanceDriver`). No metrics: with
 * metrics the Java SDK records a histogram on every operation, which cost a KV get workload
 * about 5% on top of tracing, and was never part of how the history was measured.
 */
export function buildObservabilityConfig(otlpGrpc: string, runUuid: string): ReturnType<typeof create<typeof ObservabilityConfigSchema>> {
  return create(ObservabilityConfigSchema, {
    tracing: create(TracingConfigSchema, {
      endpointHostname: otlpGrpc,
      samplingPercentage: OBSERVABILITY_SAMPLING,
      batching: true,
      exportEveryMillis: 100,
      resources: {
        "service.name": create(AttributeSchema, { value: { case: "valueString", value: "SdkPerformanceTesting" } }),
        runId: create(AttributeSchema, { value: { case: "valueString", value: runUuid } }),
      },
    }),
  });
}

/** The cluster config every connection to the performer is created with. */
function buildClusterConfig(testSuite: PerfTestSuite, runUuid: string): ReturnType<typeof create<typeof ClusterConfigSchema>> {
  const cluster = testSuite.connections.cluster;
  if (cluster.cert_path !== undefined) {
    throw new Error(
      "connections.cluster.cert_path is not supported: there is nowhere to read the certificate from. Use `insecure: true`. " +
        "No recorded perf run has ever set cert_path, so this is an unimplemented path rather than a regression — say so " +
        "if you need it.",
    );
  }

  const config = create(ClusterConfigSchema, {
    // Requested per-operation as well, as a backstop for performers that predate
    // CLUSTER_CONFIG_1 — but transactions workloads mandate it here.
    transcoder: create(TranscoderSchema, { transcoder: { case: "rawJson", value: create(RawJsonTranscoderSchema, {}) } }),
    ...(testSuite.connections.otel ? { observabilityConfig: buildObservabilityConfig(testSuite.connections.otel.otlpGrpc, runUuid) } : {}),
  });

  if (String(testSuite.impl.language).toLowerCase().startsWith("java")) {
    // The Java performer logs lost-attempt cleanup at trace level, which is verbose enough to
    // affect what's being measured. Java-only because performers without transactions report
    // UNSUPPORTED if asked to configure them at all.
    config.transactionsConfig = create(TransactionsConfigSchema, {
      cleanupConfig: create(TransactionsCleanupConfigSchema, { cleanupLostAttempts: false }),
    });
  }

  if (cluster.insecure === true) {
    config.useTls = true;
    config.insecure = true;
  }

  return config;
}

/** Classify one result the way the Java `BucketsWriteThread` does. Returns undefined if it isn't an operation. */
export function classifyResult(result: Result): PerfSample | undefined {
  if (result.initiated === undefined) {
    return undefined;
  }
  const bucketSec = Number(result.initiated.seconds);
  const elapsedNanos = Number(result.elapsedNanos);

  if (result.result.case === "sdk") {
    const sdk = result.result.value;
    if (sdk.result.case === "success" && sdk.result.value) {
      return { bucketSec, success: true, elapsedNanos };
    }
    if (sdk.result.case === "exception") {
      const exception = sdk.result.value;
      const name = exception.exception.case === "couchbase" ? exception.exception.value.name : exception.exception.value?.name;
      if (name === "IllegalArgumentException") {
        // The performer uses this to say the driver asked for something impossible. Continuing
        // would produce a bundle full of failures that looks like a cluster problem.
        throw new Error("Performer reported IllegalArgumentException — the workload it was sent is invalid");
      }
      return { bucketSec, success: false, elapsedNanos, ...(name !== undefined ? { errorName: name } : {}) };
    }
    // Anything else is a failure with no name, which is what Java's `getSuccess()` does with a
    // result that isn't an explicit `success: true` — `nullResult` included. Perf workloads set
    // `returnResult=false`, so a full GetResult never actually arrives here; the point is that
    // the two engines don't classify the same result in opposite directions if one ever does.
    return { bucketSec, success: false, elapsedNanos };
  }

  if (result.result.case === "transaction") {
    const exception = result.result.value.exception;
    if (exception === TransactionException.NO_EXCEPTION_THROWN) {
      return { bucketSec, success: true, elapsedNanos };
    }
    return { bucketSec, success: false, elapsedNanos, errorName: TransactionException[exception] };
  }

  return undefined;
}

/** Sink for one run's results: buckets, metrics, and the counters the summary reports. */
class ResultSink {
  received = 0;
  failures = 0;

  constructor(
    private readonly buckets: PerfBucketWriter,
    private readonly metrics: PerfMetricsWriter,
  ) {}

  /** Recurses into batched results, which is how the performer streams at speed. */
  handle(result: Result): void {
    this.received += 1;

    if (result.result.case === "batched") {
      for (const inner of result.result.value.result) {
        this.handle(inner);
      }
      return;
    }
    if (result.result.case === "metrics") {
      const metrics = result.result.value;
      if (metrics.initiated !== undefined) {
        this.metrics.add(Number(metrics.initiated.seconds) * 1_000_000 + Math.trunc(metrics.initiated.nanos / 1000), metrics.metrics);
      }
      return;
    }
    const sample = classifyResult(result);
    if (sample !== undefined) {
      if (!sample.success) this.failures += 1;
      this.buckets.add(sample);
    }
  }
}

/**
 * Create the documents a pooled workload reads.
 *
 * The performer creates them, over the connection it already has. That keeps a Couchbase SDK
 * out of fit-cli entirely, at the cost of trusting the performer's pool-counter semantics — so
 * the result is checked against the bucket's own item count rather than assumed.
 */
async function createDocPool(
  performer: PerformerClient,
  clusterConnectionId: string,
  rest: PerfClusterRest,
  idPreface: string,
  poolSize: number,
): Promise<void> {
  console.log(`Creating a document pool of ${poolSize} document(s) with preface "${idPreface}" via the performer...`);
  const operations: PerfOperation[] = [
    {
      op: "insert",
      bounds: { count: poolSize },
      docLocation: { method: "pool", idPreface, poolSize, poolSelectionStrategy: "counter" },
    },
  ];
  // A shared global counter picks each index exactly once, so the concurrency below is safe:
  // fifty thread-likes cooperate on one counter rather than each inserting the whole pool.
  const request = buildPerfRequest({
    operations,
    settings: { variables: { horizontalScaling: DOC_POOL_CONCURRENCY } },
    clusterConnectionId,
  });

  let inserted = 0;
  let failed = 0;
  const count = (result: Result): void => {
    if (result.result.case === "batched") {
      result.result.value.result.forEach(count);
      return;
    }
    if (result.result.case === "sdk") {
      if (result.result.value.result.case === "exception") failed += 1;
      else inserted += 1;
    }
  };
  for await (const result of performer.run(request)) {
    count(result);
  }
  console.log(`  Performer reported ${inserted} insert(s), ${failed} failure(s)`);

  await verifyDocPool(rest, poolSize);
}

/**
 * Confirm the pool really exists before measuring against it.
 *
 * Without this a partially-populated pool doesn't fail — the workload just spends its time
 * missing documents, and the bundle looks structurally fine while measuring the wrong thing.
 */
async function verifyDocPool(rest: PerfClusterRest, poolSize: number): Promise<void> {
  const deadline = Date.now() + DOC_POOL_VERIFY_TIMEOUT_MS;
  let observed: number | undefined;
  for (;;) {
    observed = await bucketItemCount(rest, PERF_BUCKET);
    if (observed !== undefined && observed >= poolSize) {
      console.log(`✓ Bucket holds ${observed} document(s)`);
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `The document pool was not fully created: bucket "${PERF_BUCKET}" holds ${observed ?? "an unknown number of"} document(s),` +
          ` expected at least ${poolSize}. Measuring against a partial pool would time misses rather than the operation.`,
      );
    }
    // itemCount comes from bucket stats, which lag writes by a few seconds.
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

/** Run every run in a TestSuite. */
export async function runPerfEngine(configured: PerfTestSuite, options: RunPerfEngineOptions = {}): Promise<PerfEngineOutcome> {
  const workingDir = options.workingDir ?? process.cwd();
  const rest: PerfClusterRest = {
    restHost: String(configured.connections.cluster.hostname_rest),
    // Both engines authenticate as the fixed administrator the perf driver has always used;
    // run-perf-driver.ts checks the cluster actually uses those credentials before we get here.
    username: "Administrator",
    password: "password",
  };

  if (!options.skipClusterSetup) {
    await waitForClusterReady(rest);
  }
  // Measured here, beside the cluster, rather than when the config was generated: that is
  // the only place a remote run can read them, and it keeps them true of the cluster
  // actually measured. They aren't in the config artifact, so they are logged instead.
  const cluster = withMeasuredClusterFacts(configured.connections.cluster, await measureClusterFacts(rest));
  console.log(
    `Cluster facts for the run record: version ${cluster.version}, ${cluster.nodeCount} node(s), ` +
      `${cluster.cpuCount} CPU(s), memory ${cluster.memory}MB`,
  );
  const testSuite: PerfTestSuite = { ...configured, connections: { ...configured.connections, cluster } };

  if (!options.skipClusterSetup) {
    await recreateBucket(rest, {
      name: PERF_BUCKET,
      ramQuotaMb: Number(cluster.memory),
      replicas: Number(cluster.replicas),
      storage: String(cluster.storage),
    });
    // CBD-5001: auto-compaction is off on perf clusters, so compact after recreating.
    await forceCompaction(rest, PERF_BUCKET);
  }

  const outcomes: PerfEngineRunOutcome[] = [];
  for (let runIndex = 0; runIndex < testSuite.runs.length; runIndex++) {
    outcomes.push(await runOne(testSuite, runIndex, rest, workingDir));
  }
  return { runs: outcomes };
}

async function runOne(testSuite: PerfTestSuite, runIndex: number, rest: PerfClusterRest, workingDir: string): Promise<PerfEngineRunOutcome> {
  const run = testSuite.runs[runIndex];
  const operations = run.operations as PerfOperation[];
  const settings = mergeSettings(testSuite, runIndex);
  // `resolve`, not `join`: fit-cli hands the engine an absolute output directory (it writes
  // straight into the run's artifacts), but the format also allows a relative one.
  const outputDir = join(resolve(workingDir, testSuite.files.outputDirectory), run.uuid.slice(0, 8));
  mkdirSync(outputDir, { recursive: true });
  console.log(`\nRunning workload ${run.uuid}, writing results to ${outputDir}`);

  const connection = connectPerformer(testSuite.connections.performer.hostname, testSuite.connections.performer.port);
  const performer = connection.client;
  const clusterConnectionId = randomUUID();
  // Only a connection that was made needs closing: a skipped run never makes one.
  let clusterConnectionCreated = false;

  try {
    const caps = await performer.performerCapsFetch({}, UNARY_CALL_OPTIONS);
    // Before anything is set up on the performer, so a skipped run costs nothing. Only this
    // run is skipped: the session's other workloads still run.
    const skipReason = workloadSkipReason(operations, caps.performerCaps);
    if (skipReason) {
      console.log(`Skipping workload ${run.uuid}: ${skipReason}`);
      writePerfSkipMarker(outputDir, skipReason);
      return { runUuid: run.uuid, outputDir, bucketRows: 0, resultsReceived: 0, failures: 0, skipped: skipReason };
    }
    const clusterConfig = buildClusterConfig(testSuite, run.uuid);
    if (clusterConfig.observabilityConfig && !caps.performerCaps.includes(Caps.OBSERVABILITY_1)) {
      console.log("Performer does not support observability, so disabling");
      delete clusterConfig.observabilityConfig;
    } else if (clusterConfig.observabilityConfig) {
      console.log(`Performer will send sampled OpenTelemetry traces (no metrics) to ${testSuite.connections.otel?.otlpGrpc}`);
    } else {
      console.log("No OpenTelemetry collector configured (connections.otel), so the performer won't export traces");
    }
    console.log(`Connected to performer: ${caps.performerUserAgent || "unknown"} ${caps.libraryVersion}`.trim());

    const created = await performer.clusterConnectionCreate(
      {
      clusterConnectionId,
      clusterHostname: String(testSuite.connections.cluster.connection_string_performer),
      clusterUsername: rest.username,
      clusterPassword: rest.password,
      clusterConfig,
      tunables: tunablesOf(settings),
      },
      UNARY_CALL_OPTIONS,
    );
    clusterConnectionCreated = true;
    console.log(`Performer now has ${created.clusterConnectionCount} cluster connection(s)`);

    // Pools share one document namespace per preface, so only the largest needs creating.
    for (const [idPreface, poolSize] of largestPoolPerPreface(settings, operations)) {
      await createDocPool(performer, clusterConnectionId, rest, idPreface, poolSize);
    }

    const buckets = new PerfBucketWriter(join(outputDir, "buckets.csv"));
    const metrics = new PerfMetricsWriter(join(outputDir, "metrics.csv"));
    const sink = new ResultSink(buckets, metrics);
    const request = buildPerfRequest({ operations, settings, clusterConnectionId });

    const startMs = Date.now();
    // Flushing on a timer rather than per result keeps the receive path to a map lookup.
    const flush = setInterval(() => buckets.flushCompleted(IGNORE_MOST_RECENT_SECS_OF_DATA), FLUSH_INTERVAL_MS);
    const progress = setInterval(() => {
      const secs = Math.max(1, Math.round((Date.now() - startMs) / 1000));
      console.log(`  ${sink.received} results received, ${Math.round(sink.received / secs)}/sec overall, ${buckets.rows} bucket(s) written`);
    }, 10_000);

    try {
      // Not time-limited: a run lasts as long as its workload says.
      for await (const result of performer.run(request)) {
        sink.handle(result);
      }
    } finally {
      clearInterval(flush);
      clearInterval(progress);
    }

    const bucketRows = buckets.close();
    const metricRows = metrics.close();
    console.log(
      `Performer finished after ${sink.received} result(s) in ${Math.round((Date.now() - startMs) / 1000)}s` +
        ` — ${bucketRows} bucket row(s), ${metricRows} metrics row(s), ${sink.failures} failure(s)`,
    );

    if (shouldRecordRun(operations)) {
      const record = buildPerfRunRecord(testSuite, runIndex);
      writePerfRunRecord(join(outputDir, "run.json5"), record);
      console.log(`Wrote ${join(outputDir, "run.json5")}`);
    } else {
      console.log("Not recording this run (ping workloads are stdout-only)");
    }

    return { runUuid: run.uuid, outputDir, bucketRows, resultsReceived: sink.received, failures: sink.failures };
  } finally {
    if (clusterConnectionCreated) {
      try {
        await performer.clusterConnectionClose({ clusterConnectionId }, UNARY_CALL_OPTIONS);
      } catch (err) {
        console.error(`  Could not close the performer's cluster connection: ${(err as Error).message}`);
      }
    }
    connection.close();
  }
}

/** Tunable variables, as the string map `clusterConnectionCreate` carries them in. */
function tunablesOf(settings: PerfMergedSettings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of settings.tunableNames ?? []) {
    const value = settings.variables[name];
    if (value !== undefined) out[name] = String(value);
  }
  return out;
}

/**
 * The pools to create, one per document-id preface.
 *
 * Pool documents are `<preface><n>`, so a pool of 10,000 already contains the pool of 1,000
 * that another operation in the same workload might use — so only the largest is created,
 * reaching the same end state without re-writing the overlap.
 */
export function largestPoolPerPreface(settings: PerfMergedSettings, operations: readonly PerfOperation[]): Map<string, number> {
  const largest = new Map<string, number>();
  const visit = (op: PerfOperation): void => {
    if (op.docLocation?.method === "pool") {
      const preface = op.docLocation.idPreface ?? PERF_KEY_PREFACE;
      const sizes = poolSizesIn(settings, [op]);
      for (const size of sizes) {
        largest.set(preface, Math.max(largest.get(preface) ?? 0, size));
      }
    }
    op.transaction?.ops.forEach(visit);
  };
  operations.forEach(visit);
  return largest;
}

/**
 * Why the performer can't run this workload, or undefined if it can.
 *
 * Transaction workloads need TRANSACTIONS_WORKLOAD_1. TRANSACTIONS_SUPPORT_1 isn't enough:
 * it covers the transactions RPCs, not transactions.Workload. Performers without it cancel
 * the run stream as soon as the workload arrives (Scala, .NET and Python all did), leaving a
 * bundle with no timings. jenkins-sdk only ever scheduled write transactions for SDKs that
 * support it.
 */
export function workloadSkipReason(operations: readonly PerfOperation[], performerCaps: readonly Caps[]): string | undefined {
  if (operations.some((op) => op.transaction !== undefined) &&!performerCaps.includes(Caps.TRANSACTIONS_WORKLOAD_1)) {
    return "the performer doesn't support transaction workloads (no TRANSACTIONS_WORKLOAD_1 cap)";
  }
  return undefined;
}

/**
 * `fit perf-engine <config.yaml>` — measure one workload and write its bundle.
 *
 * Registered as a (hidden) top-level command because a remote run invokes it on the
 * instance: fit-cli ships itself to the box and runs this, so that the driver sits beside
 * the performer instead of on the far side of the WAN. Also the way to repeat a run by
 * hand from the config file it left behind.
 */
export function runPerfEngineMain(): void {
  runCli(async () => {
    const configPath = process.argv[2];
    if (!configPath || configPath === "--help" || configPath === "-h") {
      console.log(
        [
          "Run a FIT performance workload from a perf TestSuite config.",
          "",
          "  fit perf-engine <config.yaml>",
          "  bun src/fit/performance/run-perf-engine/run-perf-engine.ts <config.yaml>",
          "",
          "The config is written as a run artifact by every definition-file perf run, so a run can",
          "be reproduced from the file it left behind. It is also what a remote run executes on the",
          "instance itself.",
        ].join("\n"),
      );
      return { artifacts: [], details: [] };
    }

    const testSuite = YAML.parse(readFileSync(resolve(configPath), "utf8")) as PerfTestSuite;
    const outcome = await runPerfEngine(testSuite);
    for (const run of outcome.runs) {
      console.log(run.skipped ? `\n${run.runUuid}: skipped, as ${run.skipped}` : `\n${run.runUuid}: ${run.bucketRows} bucket row(s) in ${run.outputDir}`);
    }
    return { artifacts: [], details: [] };
  });
}

if (isMain(import.meta.url)) {
  runPerfEngineMain();
}
