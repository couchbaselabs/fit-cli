/**
 * Upgrade a run's log-scraped records to records built from its full JUnit results, read out
 * of the run's S3 archive.
 *
 * Why: fit-cli's console output names at most 3 failures per Java package ("... and N more
 * failure(s) in <package>"), so a record scraped from the log can miss failures - it did on 68
 * of 95 .NET nightlies. The archive (s3://fit-cli/runs/<stamp>.zip, kept 180 days, twice
 * GitHub's log retention) holds surefire-reports.tar.gz with every outcome.
 *
 * Which archive, and which tarball in it, belongs to which record:
 *   - Each job's log names the archive it uploaded ("✓ Uploaded run artifacts to s3://...").
 *     Since 2026-08-08 there is a job per preset, so an archive holds one preset.
 *   - Before that, one job ran every preset and uploaded one archive holding them all.
 *     Functional runs are still told apart by cluster (clusters/8.0-stable/ vs 8.0.2-5503/),
 *     but situational presets wrote the same path and overwrote each other - so where a
 *     record's tarball can't be identified unambiguously it is left as scraped, never guessed.
 */
import { RUN_RECORD_SCHEMA, type RunRecord } from "../record/run-record.js";
import { junitOutcomes, junitXmlFromTarGz, type JunitOutcomes } from "./junit-outcomes.js";
import { stripAnsi } from "../../../util/non-fit/proc.js";

const UPLOADED = /✓ Uploaded run artifacts to (s3:\/\/\S+\.zip)/;

/** Each job's uploaded run archive, from the whole-run log. */
export function uploadedArchivesByJob(logText: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of logText.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const m = UPLOADED.exec(stripAnsi(parts.slice(2).join("\t")));
    if (m) out[parts[0]] = m[1];
  }
  return out;
}

// "functional/", or a variant such as Columnar's "functional-analytics/".
const tarballKind = (path: string) => (/\/runs\/functional[^/]*\//.test(path) ? "functional" : /\/runs\/situational[^/]*\//.test(path) ? "situational" : undefined);

/**
 * The one surefire tarball in an archive that belongs to `record`, or why there isn't one.
 * `peers` are the other records whose runs went into the same archive.
 */
export function matchTarball(record: RunRecord, tarballs: string[], peers: RunRecord[]): { path: string } | { reason: string } {
  const sameKindPeers = peers.filter((p) => p.kind === record.kind);
  let candidates = tarballs.filter((t) => tarballKind(t) === record.kind);
  if (record.kind === "functional") {
    if (!record.cluster) return { reason: "no cluster to tell the functional runs apart" };
    const onCluster = candidates.filter((t) => t.includes(`/clusters/${record.cluster}/`));
    // The log's cluster label and the archive's folder name can differ (Columnar's "CA-cbdino1"
    // is archived under "Capella-cbdino1"). That matters only if there is a choice: the only
    // functional run in an archive owns its only functional tarball, whatever the label.
    candidates = onCluster.length === 0 && sameKindPeers.length === 0 && candidates.length === 1 ? candidates : onCluster;
    // `peers` excludes this record, so any other functional run on the same cluster is a clash.
    const sameCluster = sameKindPeers.filter((p) => p.cluster === record.cluster);
    if (sameCluster.length > 0) return { reason: `${sameCluster.length + 1} functional runs on ${record.cluster} share this archive` };
  } else if (sameKindPeers.length > 0) {
    // Situational presets in one archive write the same path; the last one overwrote the rest.
    return { reason: `${sameKindPeers.length + 1} situational presets share this archive and overwrite each other's reports` };
  }
  if (candidates.length === 1) return { path: candidates[0] };
  return { reason: `${candidates.length} matching surefire-reports.tar.gz in the archive` };
}

/**
 * The upgraded record: the scraped one's description, with every outcome from JUnit - or why
 * not. A tarball with no test results in it (no TEST-*.xml, or none with a test case) is
 * refused: zero counts would read as a clean night and replace the log's real results.
 */
/**
 * The record a scraped one becomes with its run's full JUnit results: the scraped record says
 * which run it was, the JUnit every outcome. Copied field by field, so the scraped record's
 * source, parserVersion and tests can't leak into it.
 */
export function recordFromJunit(junit: JunitOutcomes, scraped: RunRecord, archive: { uri: string; member: string }): RunRecord {
  const c = junit.counts;
  return {
    schema: RUN_RECORD_SCHEMA,
    source: "run-archive-junit",
    sdk: scraped.sdk,
    preset: scraped.preset,
    ...(scraped.performer ? { performer: scraped.performer } : {}),
    kind: scraped.kind,
    cluster: scraped.cluster,
    ...(scraped.variant ? { variant: scraped.variant } : {}),
    params: { ...scraped.params },
    date: scraped.date,
    ci: { ...scraped.ci },
    outcome: c.failed + c.errored > 0 ? "tests_failed" : "passed",
    counts: c,
    passesKnown: true,
    packages: junit.packages,
    archive,
    tests: junit.tests,
  };
}

export async function upgradeRecord(scraped: RunRecord, tarGz: Buffer, archive: string, tarball: string): Promise<RunRecord | { reason: string }> {
  const junit = junitOutcomes(await junitXmlFromTarGz(tarGz));
  const c = junit.counts;
  if (junit.files === 0 || c.passed + c.failed + c.errored + c.skipped === 0) {
    return { reason: `${tarball} holds no JUnit results (${junit.files} TEST-*.xml files)` };
  }
  return recordFromJunit(junit, scraped, { uri: archive, member: tarball });
}
