/**
 * Read situational test result bundles, from `results/<runUuid>/` — one directory per run,
 * always written by the FIT test-driver (transactions-fit-performer; situational testing is
 * file-only, there's no hosted results database):
 *   run.json5        everything under `forDatabase` is written verbatim by the
 *                    test-driver — the exact payload that would be inserted into
 *                    a results database row. `forDatabase.debug.items[]` holds both
 *                    plain facts (cbDinoClusterId, capellaCloudClusterId,
 *                    capellaEnvironment — as `{label, description}` entries fit-cli
 *                    reads back by label, see {@link SituationalRunDebugInfo}) and,
 *                    once fit-cli resolves them afterward, real debug links (Capella
 *                    UI, Fleet Manager, DataDog) it appends into that same array —
 *                    there's no separate sidecar file for them.
 *   buckets.csv      one row per second: op/latency counts + a JSON errors blob
 *   events.csv       situation-starts/resolves/situation-sdk-error rows, each JSON-encoded
 *   scores.json5     {score?, reasons, errors: {sdk, server}} — written by the test-driver
 *                    itself, scored from buckets.csv/events.csv (see transactions-fit-performer's
 *                    Scorer.scala). fit-cli only ever reads this file and run.json5 — it never
 *                    parses buckets.csv/events.csv itself.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";

/** The `forDatabase.debug` block within run.json5 — facts fit-cli needs that aren't part of the rest of the bundle. */
export interface SituationalRunDebugInfo {
  /**
   * cbdinocluster's own tracking id — NOT the Capella cloud cluster UUID
   * DataDog/Fleet Manager links need. Absent if the run failed before a
   * cbdino cluster was created, or the cluster wasn't cbdino-managed.
   */
  cbDinoClusterId?: string;
  /**
   * The Capella cloud cluster's own UUID, resolved via `cbdinocluster cloud
   * get-cloud-id` — this is what buildDebugLinks needs. Absent if the cluster
   * isn't cloud-deployed, or resolution failed.
   */
  capellaCloudClusterId?: string;
  /** The Capella environment (a key under `capella` in environments.json5, e.g. "dev"/"prod") this cluster was created in. Absent if the run wasn't Capella-backed. */
  capellaEnvironment?: string;
}

/**
 * The `description` of the `forDatabase.debug.items[]` entry with this `label` — the
 * test-driver writes the cluster tracking id, Capella cluster id, and Capella environment as
 * plain `{label, description}` items with human-readable labels ("cbdinocluster id",
 * "Capella cluster id", "Capella environment" — see `RunnerUtils.debugFactItem`/
 * `RunnerUtils.clusterIdLabel` in transactions-fit-performer), rather than as separate
 * top-level fields, so this is how fit-cli reads them back. Keep the labels passed here in
 * sync with what the test-driver writes.
 */
function itemDescription(items: readonly unknown[], label: string): string | undefined {
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    if (candidate.label === label && typeof candidate.description === "string") {
      return candidate.description;
    }
  }
  return undefined;
}

/** Pull the `forDatabase.debug` facts out of a parsed run.json5's `items[]`, if present and shaped as expected. */
function runDebugInfoFrom(runParams: unknown): SituationalRunDebugInfo | undefined {
  if (typeof runParams !== "object" || runParams === null) return undefined;
  const forDatabase = (runParams as Record<string, unknown>).forDatabase;
  if (typeof forDatabase !== "object" || forDatabase === null) return undefined;
  const debug = (forDatabase as Record<string, unknown>).debug;
  if (typeof debug !== "object" || debug === null) return undefined;
  const items = Array.isArray((debug as Record<string, unknown>).items) ? ((debug as Record<string, unknown>).items as unknown[]) : [];
  return {
    cbDinoClusterId: itemDescription(items, "cbdinocluster id"),
    capellaCloudClusterId: itemDescription(items, "Capella cluster id"),
    capellaEnvironment: itemDescription(items, "Capella environment"),
  };
}

/**
 * scores.json5's shape, written by the test-driver's Scorer.scala. `score` is absent (not a
 * placeholder like -100) when no situation was executed during the run — see `reasons` for why.
 * `errors` tallies "situation-sdk-error" events by SDK-vs-server-classified
 * `CouchbaseExceptionType` (see `Scorer.classifyErrorType`/`Scorer.countErrorsByCategory`).
 */
export interface SituationalScores {
  score?: number;
  reasons: string[];
  errors: { sdk: number; server: number };
}

function readJson5File(path: string): unknown {
  if (!existsSync(path)) return undefined;
  return JSON5.parse(readFileSync(path, "utf8"));
}

/** Read and parse `scores.json5` from `dir`, if present and shaped as expected. */
function readScoresJson5(dir: string): SituationalScores | undefined {
  const parsed = readJson5File(join(dir, "scores.json5"));
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return parsed as SituationalScores;
}

/**
 * One run's full local bundle (results/<runUuid>/) — `run.json5` and `scores.json5` parsed;
 * `undefined` for either if missing (best-effort: an old test-driver, or a run that died
 * mid-way, may not have written one or both).
 */
export interface SituationalRunBundle {
  runUuid: string;
  dir: string;
  runParams?: unknown;
  scores?: SituationalScores;
  runDebug?: SituationalRunDebugInfo;
}

/** Read and parse one run's bundle from `dir` (results/<runUuid>). */
export function readSituationalRunBundle(runUuid: string, dir: string): SituationalRunBundle {
  const runParams = readJson5File(join(dir, "run.json5"));
  return {
    runUuid,
    dir,
    runParams,
    scores: readScoresJson5(dir),
    runDebug: runDebugInfoFrom(runParams),
  };
}

/** List and read every run bundle under a collected `results/` directory (one subdirectory per runUuid). */
export function listSituationalRunBundles(resultsDir: string): SituationalRunBundle[] {
  if (!existsSync(resultsDir)) return [];
  return readdirSync(resultsDir)
    .filter((entry) => statSync(join(resultsDir, entry)).isDirectory())
    .map((runUuid) => readSituationalRunBundle(runUuid, join(resultsDir, runUuid)));
}

/**
 * Render a plain-text table of the files in a run bundle's directory (name + size in bytes) —
 * printed right after a run so it's visible what the test-driver wrote, without having to wait
 * on (or dig through) the test-driver's own 30s proof-of-life log lines.
 */
export function renderBundleFilesTable(bundle: SituationalRunBundle): string {
  const files = readdirSync(bundle.dir)
    .filter((entry) => statSync(join(bundle.dir, entry)).isFile())
    .sort();
  if (files.length === 0) {
    return `No files found in ${bundle.dir}\n`;
  }
  const sizes = files.map((f) => statSync(join(bundle.dir, f)).size);
  const nameWidth = Math.max("File".length, ...files.map((f) => f.length));
  const sizeWidth = Math.max("Size".length, ...sizes.map((s) => String(s).length));
  const lines = [
    `Files written to ${bundle.dir}:`,
    `${"File".padEnd(nameWidth)} | Size`,
    `${"-".repeat(nameWidth)}-+-${"-".repeat(sizeWidth)}`,
    ...files.map((f, i) => `${f.padEnd(nameWidth)} | ${String(sizes[i]).padStart(sizeWidth)} bytes`),
  ];
  return lines.join("\n") + "\n";
}

/**
 * One row of the per-test-driver-invocation scores table: one row per `results/<runUuid>/`
 * bundle, since a single invocation commonly runs many situational `@Test` methods (e.g. the
 * `op-capella-sit-lite`/`-release` presets), each writing its own bundle/score.
 */
export interface SituationalScoreRow {
  label: string;
  scores: SituationalScores;
}

/** The situational test's display name (`forDatabase.workload.situational`), or the bundle's runUuid if unavailable. */
function situationalTestLabel(bundle: SituationalRunBundle): string {
  const forDatabase = (bundle.runParams as Record<string, unknown> | undefined)?.forDatabase as Record<string, unknown> | undefined;
  const workload = forDatabase?.workload as Record<string, unknown> | undefined;
  const label = workload?.situational;
  return typeof label === "string" && label.trim() !== "" ? label : bundle.runUuid;
}

/** Build the scores table rows for a set of bundles — bundles with no `scores.json5` are omitted. */
export function situationalScoreRows(bundles: readonly SituationalRunBundle[]): SituationalScoreRow[] {
  return bundles
    .filter((b): b is SituationalRunBundle & { scores: SituationalScores } => b.scores !== undefined)
    .map((b) => ({ label: situationalTestLabel(b), scores: b.scores }));
}

/** Render a plain-text table: one row per situational test, with its score and SDK/server error counts. */
export function renderScoresTable(rows: readonly SituationalScoreRow[]): string {
  if (rows.length === 0) return "";
  const labelHeader = "Test Case";
  const scoreHeader = "Score";
  const sdkHeader = "SDK Errors";
  const serverHeader = "Server Errors";

  const scoreText = (r: SituationalScoreRow): string => String(r.scores.score ?? "N/A");
  const labelWidth = Math.max(labelHeader.length, ...rows.map((r) => r.label.length));
  const scoreWidth = Math.max(scoreHeader.length, ...rows.map((r) => scoreText(r).length));
  const sdkWidth = Math.max(sdkHeader.length, ...rows.map((r) => String(r.scores.errors.sdk).length));
  const serverWidth = Math.max(serverHeader.length, ...rows.map((r) => String(r.scores.errors.server).length));

  const lines = [
    `${labelHeader.padEnd(labelWidth)} | ${scoreHeader.padEnd(scoreWidth)} | ${sdkHeader.padEnd(sdkWidth)} | ${serverHeader}`,
    `${"-".repeat(labelWidth)}-+-${"-".repeat(scoreWidth)}-+-${"-".repeat(sdkWidth)}-+-${"-".repeat(serverWidth)}`,
    ...rows.map(
      (r) =>
        `${r.label.padEnd(labelWidth)} | ${scoreText(r).padEnd(scoreWidth)} | ${String(r.scores.errors.sdk).padEnd(sdkWidth)} | ${String(r.scores.errors.server).padEnd(serverWidth)}`,
    ),
  ];
  return lines.join("\n") + "\n";
}

/** Render the same table as {@link renderScoresTable}, as a GFM markdown table (for $GITHUB_STEP_SUMMARY). */
export function renderScoresMarkdownTable(rows: readonly SituationalScoreRow[]): string {
  if (rows.length === 0) return "";
  const lines = [
    "| Test Case | Score | SDK Errors | Server Errors |",
    "| --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.label} | ${r.scores.score ?? "N/A"} | ${r.scores.errors.sdk} | ${r.scores.errors.server} |`),
  ];
  return lines.join("\n") + "\n";
}
