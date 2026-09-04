/**
 * Parsers for the files a run directory holds, as written by
 * transactions-fit-performer (Gerrit 250130) and uploaded by fit-cli.
 * The .json5 files hold plain JSON today, but are parsed as JSON5 to match
 * their names.
 */
import JSON5 from "json5";
import { parseCsvWithHeader } from "./csv.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export type RunKind = "situational" | "performance";

export interface ParsedRun {
  runUuid: string;
  kind: RunKind;
  /** forDatabase without runUuid. Goes verbatim into runs.params. */
  params: Record<string, unknown>;
}

export function parseRunJson5(text: string): ParsedRun {
  let parsed: { forDatabase?: Record<string, unknown> };
  try {
    parsed = JSON5.parse(text);
  } catch (err) {
    throw new Error(`run.json5 is unparseable: ${(err as Error).message}`, { cause: err });
  }
  const forDatabase = parsed.forDatabase;
  if (forDatabase === undefined || typeof forDatabase !== "object") {
    throw new Error("run.json5 has no forDatabase object");
  }
  const runUuid = forDatabase.runUuid;
  if (typeof runUuid !== "string" || !isUuid(runUuid.toLowerCase())) {
    throw new Error("run.json5 has no valid forDatabase.runUuid");
  }
  const { runUuid: _runUuid, ...params } = forDatabase;

  const workload = params.workload;
  const kind: RunKind =
    workload !== null && typeof workload === "object" && "situational" in workload ? "situational" : "performance";

  return { runUuid: runUuid.toLowerCase(), kind, params };
}

/** scores.json5 holds {score, reasons}. The score key is absent when nothing was scored. */
export function parseScoresJson5(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  try {
    const parsed: unknown = JSON5.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`scores.json5 is unparseable: ${(err as Error).message}`, { cause: err });
  }
}

export interface BucketRow {
  time: string;
  timeOffsetSecs: number;
  total: number;
  success: number;
  failed: number;
  durationMinUs: number;
  durationMaxUs: number;
  durationAverageUs: number;
  durationP50Us: number;
  durationP95Us: number;
  durationP99Us: number;
  /** JSON object string, or null when the run had no errors that second. */
  errors: string | null;
}

const BUCKETS_HEADER = [
  "timestamp",
  "timeOffsetSecs",
  "total",
  "success",
  "failed",
  "durationMinMicros",
  "durationMaxMicros",
  "durationAverageMicros",
  "durationP50Micros",
  "durationP95Micros",
  "durationP99Micros",
  "errors",
];

export function parseBucketsCsv(text: string): BucketRow[] {
  return parseCsvWithHeader(text, BUCKETS_HEADER).map((row, i) => ({
    time: parseTimestamp(row[0], `buckets.csv row ${i + 1}`),
    timeOffsetSecs: parseInteger(row[1], `buckets.csv row ${i + 1} timeOffsetSecs`),
    total: parseInteger(row[2], `buckets.csv row ${i + 1} total`),
    success: parseInteger(row[3], `buckets.csv row ${i + 1} success`),
    failed: parseInteger(row[4], `buckets.csv row ${i + 1} failed`),
    durationMinUs: parseInteger(row[5], `buckets.csv row ${i + 1} durationMinMicros`),
    durationMaxUs: parseInteger(row[6], `buckets.csv row ${i + 1} durationMaxMicros`),
    durationAverageUs: parseInteger(row[7], `buckets.csv row ${i + 1} durationAverageMicros`),
    durationP50Us: parseInteger(row[8], `buckets.csv row ${i + 1} durationP50Micros`),
    durationP95Us: parseInteger(row[9], `buckets.csv row ${i + 1} durationP95Micros`),
    durationP99Us: parseInteger(row[10], `buckets.csv row ${i + 1} durationP99Micros`),
    errors: row[11] === "" ? null : parseJsonField(row[11], `buckets.csv row ${i + 1} errors`),
  }));
}

export interface MetricRow {
  initiated: string;
  timeOffsetSecs: number;
  /** JSON string, stored verbatim in metrics.metrics. */
  metrics: string;
}

const METRICS_HEADER = ["timestamp", "timeSinceStartSecs", "metrics"];

export function parseMetricsCsv(text: string): MetricRow[] {
  return parseCsvWithHeader(text, METRICS_HEADER).map((row, i) => ({
    initiated: parseTimestamp(row[0], `metrics.csv row ${i + 1}`),
    timeOffsetSecs: parseInteger(row[1], `metrics.csv row ${i + 1} timeSinceStartSecs`),
    metrics: parseJsonField(row[2], `metrics.csv row ${i + 1} metrics`),
  }));
}

export interface EventRow {
  datetime: string;
  /** JSON string, stored verbatim in run_events.params. */
  params: string;
}

const EVENTS_HEADER = ["datetime", "json"];

export function parseEventsCsv(text: string): EventRow[] {
  return parseCsvWithHeader(text, EVENTS_HEADER).map((row, i) => ({
    datetime: parseTimestamp(row[0], `events.csv row ${i + 1}`),
    params: parseJsonField(row[1], `events.csv row ${i + 1} json`),
  }));
}

function parseTimestamp(s: string, where: string): string {
  if (Number.isNaN(Date.parse(s))) throw new Error(`${where} has invalid timestamp "${s}"`);
  return s;
}

function parseInteger(s: string, where: string): number {
  const n = Number(s);
  if (!Number.isInteger(n)) throw new Error(`${where} is not an integer: "${s}"`);
  return n;
}

function parseJsonField(s: string, where: string): string {
  try {
    JSON.parse(s);
  } catch {
    throw new Error(`${where} is not valid JSON: "${s}"`);
  }
  return s;
}
