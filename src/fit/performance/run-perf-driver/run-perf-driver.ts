/**
 * Workflow: measure one `performance` run with fit-cli's own perf engine.
 *
 * The counterpart of `shared/run-test-driver/run-test-driver.ts`, for `performance` runs
 * — the two sit in different trees because this one is perf all the way down, while that
 * one serves functional and situational alike. The shape is deliberately different
 * because the work is: instead of selecting JUnit tests
 * and reading surefire counts, fit-cli generates a `TestSuite`, measures the
 * workload itself (see run-perf-engine.ts) and collects the per-run result bundle
 * it writes. There are no assertions and so no pass/fail from the run — see
 * {@link assessPerfBundles} for what "this run worked" means instead.
 *
 * The engine runs wherever the performer is: in this process for a local run, and on
 * the instance itself for a remote one (fit-cli ships itself there — see
 * remote-fit-binary.ts). Driving a remote performer from here would put the WAN between
 * driver and performer and measure that instead.
 *
 * Run on its own:
 *   bun src/fit/performance/run-perf-driver/run-perf-driver.ts --help
 *   bun src/fit/performance/run-perf-driver/run-perf-driver.ts print-config
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import YAML from "yaml";
import { artifactFromPath, combineArtifacts, type Artifact, type Detail, type RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { runRunDir, type DefinitionRunPath } from "../../../util/non-fit/replay.js";
import { throwFatalToRun } from "../../shared/failure-classification.js";
import { performerImageLabelsArgs } from "../../performers/check-performer/check-performer.js";
import { performerImageName } from "../../performers/util/performer-image.js";
import type { SelectedCluster } from "../../../cluster/cluster-select/cluster-select.js";
import { managementHostPort } from "../../../cluster/cluster-diag/cluster-diag.js";
import { sdkByValue, type Sdk } from "../../../util/sdk/sdks.js";
import type { PerformanceSection } from "../../shared/definition/types.js";
import type { FitExecutionContext } from "../../shared/util/remote-fit-run.js";
import { fitCliRepoRoot, stageFitCliBinary } from "../../shared/util/remote-fit-binary.js";
import { resolvedGitSha } from "../../version/version.js";
import { captureValueSync } from "../../../util/non-fit/proc.js";
import { localDriverResultsDir } from "../../shared/run-test-driver/collect-results.js";
import { runPerfEngine } from "../run-perf-engine/run-perf-engine.js";
import { otelEndpoints } from "../../external-services/otel/util/otel-endpoints.js";

/**
 * The engine hardcodes these when connecting to the cluster (and when telling the
 * performer how to connect). They
 * aren't configurable in the TestSuite, so a cluster using anything else can't be
 * driven; fit-cli checks up front rather than letting it fail as an auth error
 * deep inside the run.
 */
export const PERF_DRIVER_CLUSTER_USERNAME = "Administrator";
export const PERF_DRIVER_CLUSTER_PASSWORD = "password";

/**
 * Cluster facts the driver *acts on* rather than merely records: it drops and
 * recreates the `default` bucket with this replica count and storage backend
 * before every run. The bucket's RAM quota is the cluster's whole data service
 * quota unless the definition states a `memory` — see withMeasuredClusterFacts.
 */
export const DEFAULT_PERF_REPLICAS = 0;
export const DEFAULT_PERF_STORAGE = "couchstore";

/** `horizontalScaling` is read unconditionally by the driver, so it always has to be present. */
export const DEFAULT_PERF_HORIZONTAL_SCALING = 1;

/** OCI/Couchbase image labels → the perf driver's `impl.image` block, which lands in `runs.params`. */
const IMAGE_LABEL_TO_PERF_FIELD = {
  "org.opencontainers.image.created": "created",
  "org.opencontainers.image.revision": "revision",
  "org.opencontainers.image.source": "source",
  "com.couchbase.pr": "pr",
  "com.couchbase.github.actions.run": "ciRun",
} as const;

const IMAGE_VERSION_LABEL = "org.opencontainers.image.version";

/** A settings block, which the TestSuite format allows both at the top level and per run. */
export interface PerfSettings {
  variables: Array<{ name: string; value: string | number | boolean; type?: "tunable" }>;
  driverVer?: number;
  performerVer?: number;
  grpc?: { flowControl?: boolean; batch?: number; compression?: boolean };
}

/**
 * What produced a perf run, recorded as `runs.params.runner` so fit-cli's datapoints can be told
 * apart from jenkins-sdk's (which have no `runner`). The perf UI matches runs by containment, so
 * the extra key leaves them on the same charts; ingest retention keys on `name` (see
 * perf-identity.ts), so the two producers' runs of a moving version don't prune each other.
 */
export interface PerfRunner {
  name: "fit-cli";
  /** The fit-cli commit the engine was built from, when known. */
  commit?: string;
  /** Present when the engine was built from a checkout with uncommitted changes, so `commit` isn't the whole story. */
  dirty?: true;
}

export interface PerfTestSuite {
  /** Absent in a hand-written config, which then records no `runner`. */
  runner?: PerfRunner;
  impl: {
    language: string;
    version: string;
    image?: Record<string, string>;
  };
  connections: {
    cluster: Record<string, string | number | boolean>;
    performer: { hostname: string; hostname_docker: string; port: number };
    /**
     * The OTLP gRPC collector the performer sends metrics and traces to, as the performer (a
     * container) dials it. Absent means the performer exports nothing.
     */
    otel?: { otlpGrpc: string };
  };
  runs: Array<{
    uuid: string;
    operations: unknown[];
    /**
     * Per-run settings, which override the top-level ones.
     *
     * fit-cli emits one run per suite and so has no use for these, but a hand-written or
     * externally-generated config may set them, so they are honoured.
     */
    settings?: PerfSettings;
  }>;
  settings: PerfSettings;
  files: { outputDirectory: string };
}

export interface BuildPerfTestSuiteInput {
  sdk: Sdk;
  /** Performer image tag, e.g. `main`. The fallback for `impl.version` when the image carries no version label. */
  performerVersion?: string;
  /** `docker image inspect` labels for the performer image, when they could be read. */
  imageLabels?: Record<string, string>;
  cluster: SelectedCluster;
  performerHost: string;
  performerPort: number;
  performance: PerformanceSection;
  runUuid: string;
  /** Where the driver writes its bundle, relative to the performer checkout. */
  outputDirectory: string;
  /** The box's otel collector, performer-relative — see {@link PerfTestSuite}'s `connections.otel`. */
  otelCollectorOtlpGrpc?: string;
  runner?: PerfRunner;
}

/**
 * This fit-cli, as the {@link PerfRunner} its perf runs record.
 *
 * Resolved where the run is orchestrated, never in the engine: a remote engine is a binary
 * cross-compiled from the working tree without a baked-in SHA (see remote-fit-binary.ts), so on
 * the instance there is no commit to read. In a checkout the commit is HEAD, flagged `dirty`
 * when the tree has uncommitted changes, which the shipped binary would include. A released
 * binary has its SHA baked in.
 */
export function fitCliRunner(): PerfRunner {
  const root = fitCliRepoRoot();
  if (root === undefined) {
    const sha = resolvedGitSha();
    return sha === "unknown" ? { name: "fit-cli" } : { name: "fit-cli", commit: sha };
  }
  const commit = captureValueSync("git", ["-C", root, "rev-parse", "HEAD"], { quiet: true, allowFailure: true }).trim();
  if (commit === "") {
    return { name: "fit-cli" };
  }
  const status = captureValueSync("git", ["-C", root, "status", "--porcelain"], { quiet: true, allowFailure: true }).trim();
  return status === "" ? { name: "fit-cli", commit } : { name: "fit-cli", commit, dirty: true };
}

/**
 * The cluster's management endpoint, e.g. `http://host:8091`.
 *
 * Host and port come from {@link managementHostPort}, which already handles the cases a raw
 * `defaultHostname` doesn't: a multi-host connection string, an explicit port, a bracketed IPv6
 * address, and CNG's 443. That matters more than it looks — readiness polling, bucket
 * recreation, compaction and the document-pool check all go through this one value.
 */
export function restHostname(cluster: SelectedCluster): string {
  const { host, port } = managementHostPort(cluster);
  return `${cluster.scheme === "couchbases" ? "https" : "http"}://${host}:${port}`;
}

/** The perf driver's `impl` block, built from what the performer image declares about itself. */
export function perfImplBlock(input: Pick<BuildPerfTestSuiteInput, "sdk" | "performerVersion" | "imageLabels">): PerfTestSuite["impl"] {
  const labels = input.imageLabels ?? {};
  const image: Record<string, string> = {};
  for (const [label, field] of Object.entries(IMAGE_LABEL_TO_PERF_FIELD)) {
    const value = labels[label];
    if (value) {
      image[field] = value;
    }
  }
  return {
    // sdks.ts's display names are already the values perf records — "Java", "C++".
    language: input.sdk.name,
    // For a floating tag the image's own version label just echoes the tag ("main"),
    // so `image.revision` above is what actually distinguishes two builds of that tag.
    version: labels[IMAGE_VERSION_LABEL] ?? input.performerVersion ?? "unknown",
    ...(Object.keys(image).length > 0 ? { image } : {}),
  };
}

/**
 * Build the perf driver's TestSuite. Pure, so the mapping can be tested without a
 * cluster: everything that needs the outside world is resolved by the caller.
 */
export function buildPerfTestSuite(input: BuildPerfTestSuiteInput): PerfTestSuite {
  const { performance, cluster } = input;
  const meta = performance.cluster ?? {};
  const connectionString = `${cluster.scheme}://${cluster.defaultHostname}`;
  // A CNG cluster keeps the classic connection string for the driver's own admin
  // work (bucket recreate) and hands the performer the couchbase2:// gateway.
  const performerConnectionString = cluster.cng?.performerConnectionString ?? connectionString;

  const clusterBlock: Record<string, string | number | boolean> = {
    connection_string_driver: connectionString,
    connection_string_performer: performerConnectionString,
    hostname_rest: restHostname(cluster),
    type: meta.type ?? "unmanaged",
    storage: meta.storage ?? DEFAULT_PERF_STORAGE,
    replicas: meta.replicas ?? DEFAULT_PERF_REPLICAS,
  };
  // version, nodeCount, cpuCount and memory are read from the cluster by the engine, which
  // runs beside it (see withMeasuredClusterFacts); a value stated here is checked against
  // that, or for memory, sizes the bucket. The rest is pure metadata, recorded but never
  // acted on, and omitted rather than guessed: a wrong value here silently compares a run
  // against history it isn't comparable with.
  for (const key of ["version", "nodeCount", "cpuCount", "memory", "instance", "compaction", "topology", "region"] as const) {
    const value = meta[key];
    if (value !== undefined) {
      clusterBlock[key] = value;
    }
  }
  if (cluster.tls && "insecure" in cluster.tls) {
    clusterBlock.insecure = true;
  }

  const variables = {
    horizontalScaling: DEFAULT_PERF_HORIZONTAL_SCALING,
    ...(performance.variables ?? {}),
  };

  return {
    ...(input.runner ? { runner: input.runner } : {}),
    impl: perfImplBlock(input),
    connections: {
      cluster: clusterBlock,
      performer: {
        hostname: input.performerHost,
        // The driver picks this when it detects it's inside a container. fit-cli
        // runs it on the host, so both are the same host either way.
        hostname_docker: input.performerHost,
        port: input.performerPort,
      },
      ...(input.otelCollectorOtlpGrpc ? { otel: { otlpGrpc: input.otelCollectorOtlpGrpc } } : {}),
    },
    runs: [
      {
        uuid: input.runUuid,
        operations: performance.workload.operations,
      },
    ],
    settings: {
      variables: Object.entries(variables).map(([name, value]) => ({ name, value })),
      ...(performance.driverVer !== undefined ? { driverVer: performance.driverVer } : {}),
      ...(performance.performerVer !== undefined ? { performerVer: performance.performerVer } : {}),
      ...(performance.grpc !== undefined ? { grpc: performance.grpc } : {}),
    },
    files: { outputDirectory: input.outputDirectory },
  };
}

/** A one-line summary of what a workload does, for the run header. */
export function describePerfWorkload(performance: PerformanceSection): string {
  const parts = performance.workload.operations.map((operation) => {
    type Bounds = { forSeconds?: string; count?: string };
    const op = operation as { op?: string; bounds?: Bounds; transaction?: { ops?: unknown[]; bounds?: Bounds } };
    const what = op.transaction ? `transaction of ${op.transaction.ops?.length ?? 0} op(s)` : (op.op ?? "?");
    // A transaction carries its own bounds, since the bound applies to the whole
    // transaction rather than to any one operation inside it.
    const bounds = op.transaction?.bounds ?? op.bounds;
    const boundsLabel = bounds?.forSeconds
      ? ` for ${resolveVariable(bounds.forSeconds, performance)}s`
      : bounds?.count
        ? ` x${resolveVariable(bounds.count, performance)}`
        : "";
    return `${what}${boundsLabel}`;
  });
  return parts.join(" + ");
}

/** Resolve a `$name` reference against the run's variables, for display only. */
function resolveVariable(value: string, performance: PerformanceSection): string {
  if (!value.startsWith("$")) {
    return value;
  }
  const resolved = performance.variables?.[value.slice(1)];
  return resolved === undefined ? value : String(resolved);
}

/**
 * A bundle's directory name: the first 8 characters of the run uuid, matching the
 * test-driver's own `results/<uuid[0..8]>/` layout.
 */
export function bundleDirName(runUuid: string): string {
  return runUuid.slice(0, 8);
}

export interface PerfBundleAssessment {
  ok: boolean;
  /** Why it isn't ok — empty when it is. */
  reasons: string[];
  /** Bundle directories found under the collected results tree. */
  bundles: string[];
  /** Total data rows (excluding the header) across every bundle's buckets.csv. */
  bucketRows: number;
}

/**
 * Decide whether a perf run actually produced results.
 *
 * A perf run has no assertions, so "the driver exited 0" is not enough: the
 * driver can complete a workload of hundreds of thousands of operations and still
 * write a buckets.csv containing only its header. That was a real bug (fixed in
 * the driver), and it is exactly the failure a green exit code would hide, so it
 * is checked here as well as fixed there.
 */
export function assessPerfBundles(resultsDir: string | undefined, runUuid?: string): PerfBundleAssessment {
  if (!resultsDir || !existsSync(resultsDir)) {
    return { ok: false, reasons: ["the perf driver wrote no results directory"], bundles: [], bucketRows: 0 };
  }
  const bundles = readdirSync(resultsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    // Several runs in one session share a results directory, each with its own bundle named
    // after its uuid. Without this a run would be judged on its siblings' output too — passing
    // or failing for something another run did.
    .filter((entry) => runUuid === undefined || entry.name === bundleDirName(runUuid))
    .map((entry) => join(resultsDir, entry.name));
  if (bundles.length === 0) {
    return { ok: false, reasons: ["the perf driver wrote no result bundle"], bundles: [], bucketRows: 0 };
  }

  const reasons: string[] = [];
  let bucketRows = 0;
  for (const bundle of bundles) {
    const name = basename(bundle);
    const bucketsCsv = join(bundle, "buckets.csv");
    if (!existsSync(bucketsCsv)) {
      reasons.push(`${name}: no buckets.csv`);
      continue;
    }
    const rows = countCsvDataRows(readFileSync(bucketsCsv, "utf8"));
    bucketRows += rows;
    if (rows === 0) {
      reasons.push(`${name}: buckets.csv has a header but no data — the run recorded no timings`);
    }
    // A `ping` workload is stdout-only by design and writes no run.json5, so its
    // absence is only worth reporting when there were timings to go with it.
    if (rows > 0 && !existsSync(join(bundle, "run.json5"))) {
      reasons.push(`${name}: no run.json5 — the run's parameters weren't recorded`);
    }
  }
  return { ok: reasons.length === 0, reasons, bundles, bucketRows };
}

/** Data rows in a CSV, i.e. non-blank lines after the header. */
export function countCsvDataRows(csv: string): number {
  return csv.split(/\r?\n/).slice(1).filter((line) => line.trim() !== "").length;
}

export interface PerfRunResult extends RunOutput {
  ok: boolean;
  logFile: string;
  /** Local path to the collected `results/` tree, when the driver produced one. */
  perfResultsDir?: string;
  assessment: PerfBundleAssessment;
}

/** Read the performer image's labels, so the run records which build produced its numbers. */
async function readPerformerImageLabels(
  execution: FitExecutionContext,
  sdk: Sdk,
  performerVersion?: string,
): Promise<Record<string, string> | undefined> {
  try {
    const raw = await execution.capture(execution.dockerCommand, performerImageLabelsArgs(performerImageName(sdk, performerVersion)));
    const labels = JSON.parse(raw.trim()) as Record<string, string> | null;
    return labels ?? undefined;
  } catch {
    // Older images carry no labels, and the run is still perfectly valid without
    // them — it just can't say which commit it measured.
    return undefined;
  }
}

export interface RunPerfDriverOptions {
  sdk: Sdk;
  performerVersion?: string;
  cluster: SelectedCluster;
  performerHost: string;
  performerPort: number;
  performance: PerformanceSection;
  /** Defaults to a fresh uuid; the bundle directory is its first 8 characters. */
  runUuid?: string;
  /** The box's otel collector, performer-relative. The stack's own teardown collects what it received. */
  otelCollectorOtlpGrpc?: string;
}

/** Write the generated TestSuite where the user can see it, and re-run it by hand. */
function writePerfConfig(path: DefinitionRunPath, testSuite: PerfTestSuite): string {
  const localConfigPath = join(runRunDir(path), "perf-run-config.yaml");
  mkdirSync(runRunDir(path), { recursive: true });
  writeFileSync(localConfigPath, YAML.stringify(testSuite), { mode: 0o600 });
  console.log(`\nPerf driver config written to:\n  ${localConfigPath}\n`);
  console.log(YAML.stringify(testSuite));
  return localConfigPath;
}

/**
 * Measure the workload in this process.
 *
 * Only correct for a local execution context, where the performer is on this machine.
 * See {@link runEngineRemotely} for the other half.
 */
async function runEngineLocally(testSuite: PerfTestSuite): Promise<boolean> {
  try {
    await runPerfEngine(testSuite);
    console.log("\n✓ Perf engine finished");
    return true;
  } catch (err) {
    console.error(`\n✗ Perf engine failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Measure the workload on the execution target, by shipping fit-cli there and running its
 * own `perf-engine` command.
 *
 * The driver has to sit beside the performer or it measures the WAN, so on a remote
 * instance the *whole engine* moves rather than the cluster or performer moving to us. The
 * generated config needs no rewriting: its cluster addresses come from a cbdinocluster
 * that already ran on the box, and `performerHost` is `localhost`, which is true there.
 *
 * L3 (StreamToArtifact) because a perf run's log is long and dull while it works — but the
 * small-log rule means an engine that dies early prints its whole log here rather than
 * stranding it in a file on a box that is about to be terminated.
 */
async function runEngineRemotely(
  execution: FitExecutionContext,
  path: DefinitionRunPath,
  testSuite: PerfTestSuite,
  localConfigPath: string,
): Promise<{ ok: boolean; logFile: string }> {
  const binary = await stageFitCliBinary(execution);
  const remoteConfig = await execution.stageFile(localConfigPath, join(execution.runArtifactsDir(path), "perf-run-config.yaml"));
  const remoteLog = join(execution.runArtifactsDir(path), "perf-engine.log");
  const localLog = join(runRunDir(path), "perf-engine.log");

  let ok: boolean;
  try {
    await execution.streamToArtifactFile(binary, ["perf-engine", remoteConfig], remoteLog);
    console.log("\n✓ Perf engine finished");
    ok = true;
  } catch (err) {
    console.error(`\n✗ Perf engine failed: ${(err as Error).message}`);
    ok = false;
  }

  // Collect the log either way — on failure it is the only account of what happened, and
  // the instance may be torn down moments from now.
  let collectedLog = "";
  try {
    collectedLog = await execution.collectFile(remoteLog, localLog);
  } catch (err) {
    console.error(`  ✗ Could not collect the perf engine log: ${(err as Error).message}`);
  }
  await execution.collectResultsDir(join(execution.runArtifactsDir(path), "results"), path);
  return { ok, logFile: collectedLog };
}

/** Run one perf workload and collect its result bundle. */
export async function runPerfDriver(
  execution: FitExecutionContext,
  path: DefinitionRunPath,
  options: RunPerfDriverOptions,
): Promise<PerfRunResult> {
  assertPerfDriverCredentials(options.cluster);
  const runUuid = options.runUuid ?? randomUUID();
  const imageLabels = await readPerformerImageLabels(execution, options.sdk, options.performerVersion);

  // Where the engine writes, which is a path on whichever machine the engine runs on. A
  // remote run's bundle is collected back to the local `results/` afterwards, so from here
  // down both paths look at the same local directory.
  const localResultsDir = localDriverResultsDir(path);
  const engineResultsDir = execution.kind === "remote" ? join(execution.runArtifactsDir(path), "results") : localResultsDir;
  const testSuite = buildPerfTestSuite({ ...options, runUuid, imageLabels, outputDirectory: engineResultsDir, runner: fitCliRunner() });
  const localConfigPath = writePerfConfig(path, testSuite);
  console.log(
    `Measuring with the perf engine on ${execution.description}. To repeat this exact run by hand:\n` +
      `  bun src/fit/performance/run-perf-engine/run-perf-engine.ts ${localConfigPath}\n`,
  );

  const startMs = Date.now();
  const outcome =
    execution.kind === "remote"
      ? await runEngineRemotely(execution, path, testSuite, localConfigPath)
      : // The engine logs to this process's own stdout, which the session log already captures.
        { ok: await runEngineLocally(testSuite), logFile: "" };
  const durationMs = Date.now() - startMs;

  const assessment = assessPerfBundles(localResultsDir, runUuid);
  const artifacts: Artifact[] = [
    artifactFromPath(localConfigPath, "Generated perf TestSuite config for this run"),
    ...(outcome.logFile ? [artifactFromPath(outcome.logFile, "Perf engine log from the instance")] : []),
    ...(existsSync(localResultsDir)
      ? [artifactFromPath(localResultsDir, "Performance per-run result files (run.json5, buckets.csv, metrics.csv — one subdirectory per run)")]
      : []),
  ];
  for (const reason of assessment.reasons) {
    console.error(`  ✗ ${reason}`);
  }

  return {
    ok: outcome.ok && assessment.ok,
    logFile: outcome.logFile,
    perfResultsDir: existsSync(localResultsDir) ? localResultsDir : undefined,
    assessment,
    artifacts: combineArtifacts(artifacts),
    details: perfRunDetails(assessment, path, durationMs),
  };
}

/**
 * Perf always authenticates as a fixed user (see {@link PERF_DRIVER_CLUSTER_USERNAME}).
 * Catch a mismatch here rather than 2 minutes into a run.
 */
export function assertPerfDriverCredentials(cluster: SelectedCluster): void {
  const { username, password } = cluster.credentials;
  if (username === PERF_DRIVER_CLUSTER_USERNAME && password === PERF_DRIVER_CLUSTER_PASSWORD) {
    return;
  }
  throwFatalToRun(
    `Perf runs always authenticate as "${PERF_DRIVER_CLUSTER_USERNAME}" with a fixed password, but this cluster` +
      ` uses "${username}". Perf runs need a cluster with the default credentials — the ones cbdinocluster creates.`,
  );
}

function perfRunDetails(assessment: PerfBundleAssessment, path: DefinitionRunPath, durationMs: number): Detail[] {
  const label = (name: string): string => `Run ${path.runIndex ?? 0} ${name}`;
  return [
    { label: label("Result"), value: assessment.ok ? "PASS" : "FAIL" },
    { label: label("Result bundles"), value: String(assessment.bundles.length) },
    { label: label("Bucket rows"), value: String(assessment.bucketRows) },
    { label: label("Duration"), value: `${Math.round(durationMs / 1000)}s` },
  ];
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
      console.log(
        [
          "Run or inspect the FIT perf-driver.",
          "",
          "  print-config   Print the TestSuite YAML fit-cli would generate for a sample workload,",
          "                 without needing a cluster or performer. Use this to eyeball the mapping.",
          "",
          "A real perf run goes through a definition file:",
          "  bun run run preset op-onprem-perf-sanity --performer java-fit-performer:main",
        ].join("\n"),
      );
      return Promise.resolve({ artifacts: [], details: [] });
    }

    const sdk = sdkByValue("java");
    if (!sdk) {
      throw new Error("Expected the java SDK to exist.");
    }
    // Only the offline mapping is runnable standalone: an actual run needs a
    // cluster and a running performer, which the definition-file flow sets up.
    const suite = buildPerfTestSuite({
      sdk,
      performerVersion: "main",
      cluster: {
        scheme: "couchbase",
        defaultHostname: "127.0.0.1",
        flavour: "self-managed",
        credentials: { username: PERF_DRIVER_CLUSTER_USERNAME, password: PERF_DRIVER_CLUSTER_PASSWORD },
        tls: null,
      },
      performerHost: "localhost",
      performerPort: 8060,
      performance: {
        workload: {
          operations: [
            { op: "get", bounds: { forSeconds: "$forSeconds" }, docLocation: { method: "pool", poolSize: "$poolSize", poolSelectionStrategy: "randomUniform" } },
          ],
        },
        variables: { forSeconds: 10, poolSize: 1000 },
      },
      runUuid: "00000000-0000-0000-0000-000000000000",
      outputDirectory: "results",
      otelCollectorOtlpGrpc: otelEndpoints().collector.otlpGrpc,
    });
    console.log(YAML.stringify(suite));
    return Promise.resolve({ artifacts: [], details: [] });
  });
}
