/**
 * All Postgres access. One run is one transaction and every statement is an
 * upsert. Runs are immutable and self-contained, so re-ingesting after a crash
 * converges on the same rows. The one deletion is a perf run on a moving version
 * retiring that datapoint's stale runs (see perf-identity.ts).
 *
 * Every JSON column is sent as text and cast with ::text::jsonb, so Postgres
 * parses it. Passing an object instead lets the driver encode it, which turns
 * an already-encoded string into a JSON string and loses big integers.
 */
import type postgres from "postgres";
import { isUuid, type BucketRow, type EventRow, type MetricRow, type ParsedRun } from "./parse.js";
import { isMovingVersion, movingRunsToDelete, PERF_IDENTITY_SQL, perfIdentity } from "./perf-identity.js";

export interface RunData {
  sitUuid: string;
  run: ParsedRun;
  /** Upload time of run.json5, standing in for the old end-of-run NOW(). */
  datetime: Date;
  scores: Record<string, unknown>;
  buckets: BucketRow[];
  metrics: MetricRow[];
  events: EventRow[];
}

export type ReportStatus = "success" | "partial" | "failed" | "nothing_to_do";

export interface ReportCounts {
  ingested: number;
  failed: number;
  deferred: number;
  failedBacklog: number | null;
}

const INSERT_CHUNK_ROWS = 500;

type InsertValue = string | number | Date | null;

/**
 * A column to insert into. `rawJson` marks one whose value arrives as JSON text
 * that Postgres must parse itself. Handing the driver a JavaScript object instead
 * would round-trip the numbers through JSON.parse and lose anything past 2^53.
 */
type Column = string | { name: string; rawJson: true };

const rawJson = (name: string): Column => ({ name, rawJson: true });

export class Db {
  constructor(private readonly sql: postgres.Sql) {}

  async startReport(): Promise<string> {
    const rows = await this.sql<{ id: string | number }[]>`
      INSERT INTO ingester_runs (started, status) VALUES (now(), 'running') RETURNING id`;
    return String(rows[0].id);
  }

  async finishReport(id: string, status: ReportStatus, counts: ReportCounts, details: unknown): Promise<void> {
    await this.sql`
      UPDATE ingester_runs
      SET finished = now(), status = ${status}, runs_ingested = ${counts.ingested},
          runs_failed = ${counts.failed}, runs_deferred = ${counts.deferred},
          failed_backlog = ${counts.failedBacklog}, details = ${JSON.stringify(details)}::text::jsonb
      WHERE id = ${id}`;
  }

  /** Returns the ids of any older runs this one replaced (see replaceOlderMovingRuns). */
  async ingestRun(data: RunData): Promise<{ replaced: string[] }> {
    const runId = data.run.runUuid;
    let replaced: string[] = [];
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO runs (id, datetime, params)
        VALUES (${runId}, ${data.datetime}, ${JSON.stringify(data.run.params)}::text::jsonb)
        ON CONFLICT (id) DO UPDATE SET datetime = EXCLUDED.datetime, params = EXCLUDED.params`;

      await tx`DELETE FROM buckets WHERE run_id = ${runId}`;
      await insertChunked(
        tx,
        "buckets",
        [
          "time",
          "run_id",
          "operations_total",
          "operations_success",
          "operations_failed",
          "duration_min_us",
          "duration_max_us",
          "duration_average_us",
          "duration_p50_us",
          "duration_p95_us",
          "duration_p99_us",
          rawJson("errors"),
          "time_offset_secs",
        ],
        data.buckets.map((b) => [
          b.time,
          runId,
          b.total,
          b.success,
          b.failed,
          b.durationMinUs,
          b.durationMaxUs,
          b.durationAverageUs,
          b.durationP50Us,
          b.durationP95Us,
          b.durationP99Us,
          b.errors,
          b.timeOffsetSecs,
        ]),
      );

      await tx`DELETE FROM metrics WHERE run_id = ${runId}`;
      await insertChunked(
        tx,
        "metrics",
        ["initiated", "run_id", rawJson("metrics"), "time_offset_secs"],
        data.metrics.map((m) => [m.initiated, runId, m.metrics, m.timeOffsetSecs]),
      );

      await tx`DELETE FROM run_events WHERE run_id = ${runId}`;
      await insertChunked(
        tx,
        "run_events",
        ["run_id", "datetime", rawJson("params")],
        data.events.map((e) => [runId, e.datetime, e.params]),
      );

      if (data.run.kind === "situational") {
        await upsertSituational(tx, data, runId);
      }

      if (data.run.kind === "performance") {
        replaced = await replaceOlderMovingRuns(tx, data.run.params);
      }
    });
    return { replaced };
  }
}

/**
 * For a moving version (`main`, `3.11.x`), keep a few runs of each of this datapoint's last
 * few commits and delete the rest — see perf-identity.ts for why, which runs, and what
 * "the same datapoint" means. Returns the deleted run ids.
 */
async function replaceOlderMovingRuns(tx: postgres.TransactionSql, params: Record<string, unknown>): Promise<string[]> {
  const identity = perfIdentity(params);
  if (!identity || !isMovingVersion(identity.version)) return [];

  // Language and version are matched on their own as well, so the projection only has to be
  // computed for that one implementation's runs.
  const rows = await tx.unsafe<{ id: string; datetime: Date; revision: string | null; created: string | null }[]>(
    `SELECT id, datetime,
            params->'impl'->'image'->>'revision' AS revision,
            params->'impl'->'image'->>'created' AS created
     FROM runs
     WHERE params->'impl'->>'language' = $1 AND params->'impl'->>'version' = $2
       AND ${PERF_IDENTITY_SQL} = $3::text::jsonb`,
    [identity.language, identity.version, JSON.stringify(identity.key)],
  );
  const stale = movingRunsToDelete(
    rows.map((row) => {
      const created = row.created ? new Date(row.created) : undefined;
      return {
        id: String(row.id),
        datetime: new Date(row.datetime),
        ...(row.revision ? { revision: row.revision } : {}),
        // An unparseable build time is no build time: fall back to the ingest time.
        ...(created && !Number.isNaN(created.getTime()) ? { created } : {}),
      };
    }),
  );
  if (stale.length === 0) return [];

  // grahamp: Yes, a full delete.  The perf database should be seen as more of a cache anyway, as we should be able to
  // rebuild perf data at will.  Plus we want to keep operating costs down.
  await tx`DELETE FROM buckets WHERE run_id IN ${tx(stale)}`;
  await tx`DELETE FROM metrics WHERE run_id IN ${tx(stale)}`;
  await tx`DELETE FROM run_events WHERE run_id IN ${tx(stale)}`;
  await tx`DELETE FROM runs WHERE id IN ${tx(stale)}`;
  return stale;
}

async function upsertSituational(tx: postgres.TransactionSql, data: RunData, runId: string): Promise<void> {
  // The table has no primary key, so the insert is guarded by hand. The old
  // driver inserted one duplicate row per child run.
  await tx`
    INSERT INTO situational_runs (id, datetime)
    SELECT ${data.sitUuid}, ${data.datetime}
    WHERE NOT EXISTS (SELECT 1 FROM situational_runs WHERE id = ${data.sitUuid})`;
  // Its datetime is the earliest child run's.
  await tx`UPDATE situational_runs SET datetime = LEAST(datetime, ${data.datetime}) WHERE id = ${data.sitUuid}`;

  await tx`
    DELETE FROM situational_run_join WHERE situational_run_id = ${data.sitUuid} AND run_id = ${runId}`;
  await tx`
    INSERT INTO situational_run_join (situational_run_id, run_id, params)
    VALUES (${data.sitUuid}, ${runId}, ${JSON.stringify(data.scores)}::text::jsonb)`;

  const faas = data.run.params.faas as { jobId?: unknown } | undefined;
  const jobId = typeof faas?.jobId === "string" && isUuid(faas.jobId.toLowerCase()) ? faas.jobId.toLowerCase() : null;
  if (jobId !== null) {
    await tx`DELETE FROM faas_situational_job_run_join WHERE run_id = ${runId}`;
    await tx`
      INSERT INTO faas_situational_job_run_join (job_id, situational_run_id, run_id)
      VALUES (${jobId}, ${data.sitUuid}, ${runId})`;
  }
}

/**
 * Bulk insert in chunks, so one run's million-row buckets file is not one giant
 * statement. Table and column names are constants from this file, never input,
 * so building the statement text from them is safe. Values stay parameters.
 */
async function insertChunked(
  tx: postgres.TransactionSql,
  table: string,
  columns: Column[],
  rows: InsertValue[][],
): Promise<void> {
  const names = columns.map((c) => (typeof c === "string" ? c : c.name)).join(", ");
  const prefix = `INSERT INTO ${table} (${names}) VALUES `;
  for (let start = 0; start < rows.length; start += INSERT_CHUNK_ROWS) {
    const chunk = rows.slice(start, start + INSERT_CHUNK_ROWS);
    const placeholders = chunk
      .map((_, r) => {
        const values = columns.map(
          (c, i) => `$${r * columns.length + i + 1}${typeof c === "string" ? "" : "::text::jsonb"}`,
        );
        return `(${values.join(",")})`;
      })
      .join(",");
    await tx.unsafe(prefix + placeholders, chunk.flat());
  }
}
