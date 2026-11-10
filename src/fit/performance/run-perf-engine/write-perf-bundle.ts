/**
 * The two files a perf run writes besides buckets.csv: metrics.csv and run.json5.
 *
 * `run.json5` matters most: its `forDatabase` object is exactly what goes into `runs.params`,
 * which is both what the perf UI reads and the key the results pipeline dedups on. Its shape
 * is a contract with data already recorded, so it is assembled key for key: the four keys
 * jenkins-sdk wrote (cluster, impl, workload, vars), plus `runner`, which only fit-cli writes
 * and which marks the datapoint as one of its own (see {@link PerfRunner}).
 */
import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { escapeCsv, isoSecond } from "./perf-buckets.js";
import type { PerfRunner, PerfTestSuite } from "../run-perf-driver/run-perf-driver.js";

export const METRICS_CSV_HEADER = "timestamp,timeSinceStartSecs,metrics";

/** Appends performer-reported metrics blobs to metrics.csv as they arrive. */
export class PerfMetricsWriter {
  private readonly fd: number;
  private readonly startMs = Date.now();
  private rowsWritten = 0;

  constructor(readonly path: string) {
    this.fd = openSync(path, "w");
    writeSync(this.fd, `${METRICS_CSV_HEADER}\n`);
  }

  /** `initiatedMicros` is the performer's own wallclock for the sample. */
  add(initiatedMicros: number, metrics: string): void {
    const timeSinceStartSecs = Math.trunc((Date.now() - this.startMs) / 1000);
    writeSync(this.fd, `${[isoSecond(Math.trunc(initiatedMicros / 1_000_000)), timeSinceStartSecs, escapeCsv(metrics)].join(",")}\n`);
    this.rowsWritten += 1;
  }

  close(): number {
    closeSync(this.fd);
    return this.rowsWritten;
  }
}

/**
 * Cluster connection details, which describe how this driver reached the cluster rather than
 * what the cluster is. They vary between machines, so they are stripped before the block
 * becomes part of a datapoint's identity.
 */
const CLUSTER_KEYS_NOT_IN_PARAMS = [
  "hostname",
  "hostname_docker",
  "connection_string_driver",
  "connection_string_driver_docker",
  "connection_string_performer",
  "connection_string_performer_docker",
] as const;

export interface PerfRunRecord {
  runUuid: string;
  forDatabase: {
    runner?: PerfRunner;
    cluster: Record<string, unknown>;
    impl: unknown;
    workload: Record<string, unknown>;
    vars: Record<string, unknown>;
  };
}

/**
 * Build the `run.json5` record for one run.
 *
 * Pure, so the shape that lands in `runs.params` can be tested without a cluster — which is
 * worth doing, because a wrong key here doesn't fail, it just quietly makes a datapoint
 * incomparable with its own history.
 */
export function buildPerfRunRecord(testSuite: PerfTestSuite, runIndex: number): PerfRunRecord {
  const run = testSuite.runs[runIndex];

  const cluster: Record<string, unknown> = { ...testSuite.connections.cluster };
  for (const key of CLUSTER_KEYS_NOT_IN_PARAMS) {
    delete cluster[key];
  }
  // The performer's connection string is the one recorded: it is how the thing being measured
  // actually reached the cluster, which is what a datapoint is about.
  cluster.connectionString = testSuite.connections.cluster.connection_string_performer;

  const vars: Record<string, unknown> = {};
  for (const variable of testSuite.settings.variables) {
    vars[variable.name] = variable.value;
  }
  if (testSuite.settings.driverVer !== undefined) vars.driverVer = testSuite.settings.driverVer;
  if (testSuite.settings.performerVer !== undefined) vars.performerVer = testSuite.settings.performerVer;

  // The workload is the run entry minus its identity and its settings: the uuid is the row's
  // primary key, and the variables are split out into `vars` (see CBD-5272, CBD-4979).
  const { uuid: _uuid, ...workload } = run;

  return {
    runUuid: run.uuid,
    forDatabase: { ...(testSuite.runner ? { runner: testSuite.runner } : {}), cluster, impl: testSuite.impl, workload, vars },
  };
}

/** Write `run.json5`. Named .json5 by the FIT/SIT convention; the content is plain JSON. */
export function writePerfRunRecord(path: string, record: PerfRunRecord): void {
  writeFileSync(path, JSON.stringify(record));
}

/**
 * Whether this run should be recorded at all.
 *
 * A `ping` workload measures gRPC itself and is only interesting on stdout, so it produces no
 * run.json5 — matching `TestSuite.Run.shouldWrite()`.
 */
export function shouldRecordRun(operations: readonly { op?: string }[]): boolean {
  return !operations.some((op) => op.op === "ping");
}
