/**
 * Store one CI run's log: keep the raw log, parse it into run records, and write the
 * manifest that says what happened. Shared by `fit health backfill` (logs fetched from
 * GitHub) and `fit health import-logs` (logs already on disk).
 *
 * The raw log is kept for every run because GitHub deletes Actions logs after 90 days: a
 * parser bug found later can then be fixed by reparsing, instead of being permanent.
 */
import { gzipSync } from "node:zlib";
import { MANIFEST_SCHEMA, MAX_FETCH_ATTEMPTS, rawLogKey, type ArchiveUpgrade, type RunManifest } from "../record/run-manifest.js";
import { recordKey, type CiContext } from "../record/run-record.js";
import { LOG_PARSER_VERSION, buildRecords, parseRunLog } from "../log-parse/parse-run-log.js";
import type { LocalHealthStore } from "../store/health-store.js";

export interface RunMeta {
  sdk: string;
  date: string;
  ci: CiContext;
}

/**
 * After a reparse: which of the run's JUnit-upgraded records still stand, and whether the
 * archive upgrade has to be redone. A record keeps its JUnit version only while the new parse
 * still produces its key. If a parser change moved a record to a new key, the old JUnit
 * record is stale - it would sit beside the new scraped one for the same run - so it goes,
 * and the run is upgraded again under the new key.
 */
export function reconcileUpgraded(
  previousArchive: ArchiveUpgrade | undefined,
  newKeys: readonly string[],
): { keep: Set<string>; drop: string[]; archive: ArchiveUpgrade | undefined } {
  const upgraded = previousArchive?.upgraded ?? [];
  const keep = new Set(upgraded.filter((k) => newKeys.includes(k)));
  const drop = upgraded.filter((k) => !keep.has(k));
  // Anything dropped means this run's archive upgrade is incomplete: clear it so backfill redoes it.
  return { keep, drop, archive: drop.length ? undefined : previousArchive };
}

/** Parse and store a run log. Returns the manifest written. */
export function ingestLog(store: LocalHealthStore, meta: RunMeta, text: string, opts: { keepRaw?: boolean } = {}): RunManifest {
  if (opts.keepRaw ?? true) store.write(rawLogKey(meta.sdk, meta.ci.runId, meta.ci.runAttempt), gzipSync(text));

  const previous = store.readManifest(meta.sdk, meta.ci.runId, meta.ci.runAttempt);
  const parsed = parseRunLog(text);
  const result = buildRecords(parsed, meta);
  // A record already upgraded from the run's JUnit archive is better than anything the log
  // can say, so a reparse keeps it rather than overwriting it with the scraped version -
  // as long as the new parse still produces its key.
  const newKeys = result.parseError ? [] : result.records.map(recordKey);
  const { keep, archive } = reconcileUpgraded(previous?.archive, newKeys);
  const keys = result.parseError ? [] : result.records.map((r) => (keep.has(recordKey(r)) ? recordKey(r) : store.writeRecord(r)));
  // A reparse must not leave behind a record the new parse no longer produces, JUnit or not.
  for (const stale of new Set([...(previous?.records ?? []), ...(previous?.archive?.upgraded ?? [])])) {
    if (!keys.includes(stale)) store.remove(stale);
  }

  const manifest: RunManifest = {
    schema: MANIFEST_SCHEMA,
    sdk: meta.sdk,
    runId: meta.ci.runId,
    runAttempt: meta.ci.runAttempt,
    date: meta.date,
    ci: meta.ci,
    status: result.parseError ? "parse_error" : "ok",
    parserVersion: LOG_PARSER_VERSION,
    ...(result.parseError ? { reason: result.parseError } : {}),
    records: keys,
    ...(result.warnings.length ? { warnings: result.warnings } : {}),
    ...(archive ? { archive } : {}),
    ...(Object.keys(parsed.driver).length ? { driver: parsed.driver } : {}),
    ...(Object.keys(parsed.performerRevision).length ? { performerRevision: parsed.performerRevision } : {}),
  };
  store.writeManifest(manifest);
  return manifest;
}

/** Record a run whose log could not be fetched, so the next backfill knows how to treat it. */
export function recordFetchFailure(store: LocalHealthStore, meta: RunMeta, expired: boolean, reason: string): RunManifest {
  const previous = store.readManifest(meta.sdk, meta.ci.runId, meta.ci.runAttempt);
  const attempts = (previous?.fetchAttempts ?? 0) + 1;
  const manifest: RunManifest = {
    schema: MANIFEST_SCHEMA,
    sdk: meta.sdk,
    runId: meta.ci.runId,
    runAttempt: meta.ci.runAttempt,
    date: meta.date,
    ci: meta.ci,
    // After the last attempt the run is given up on, and says so: fetch_pending would read
    // as "still coming" for ever.
    status: expired ? "expired" : attempts >= MAX_FETCH_ATTEMPTS ? "fetch_failed" : "fetch_pending",
    reason: reason.slice(0, 500),
    fetchAttempts: attempts,
    records: [],
  };
  store.writeManifest(manifest);
  return manifest;
}
