/**
 * Replace a run's log-scraped records with ones built from the full JUnit in its S3 archive,
 * wherever the archive exists and the right report can be identified (see archive-junit.ts).
 * The outcome is recorded on the manifest, so each run is tried once - a read error is
 * retried a few times; an expired or ambiguous archive is final.
 */
import { gunzipSync } from "node:zlib";
import { matchTarball, upgradeRecord, uploadedArchivesByJob } from "../emit/archive-junit.js";
import { S3Zip } from "../emit/s3-zip.js";
import { rawLogKey, type ArchiveUpgrade, type RunManifest, JUNIT_READER_VERSION } from "../record/run-manifest.js";
import type { RunRecord } from "../record/run-record.js";
import type { LocalHealthStore } from "../store/health-store.js";

/** Errors that mean our credentials are bad, not the archive: stop, don't mark every run. */
export function isCredentialError(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return /Credential|ExpiredToken|InvalidAccessKeyId|UnrecognizedClient|SignatureDoesNotMatch|sso/i.test(`${e?.name ?? ""} ${e?.message ?? ""}`);
}

/**
 * An archive that no longer exists (S3 expires runs/ after 180 days). fit-cli-role has no
 * s3:ListBucket, and without it S3 answers a request for a missing key with 403, not 404 -
 * but the role can read everything under fit-cli/*, so a 403 here means "not there".
 */
export function isMissingObject(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return ["NotFound", "NoSuchKey", "AccessDenied", "Forbidden"].includes(e?.name ?? "") || [403, 404].includes(e?.$metadata?.httpStatusCode ?? 0);
}

/**
 * A re-read never undoes an earlier one: a record upgraded before that this read couldn't
 * upgrade (its archive has expired) keeps its JUnit version, and stays listed as upgraded.
 */
export function keepEarlierUpgrades<T extends Omit<ArchiveUpgrade, "attempts">>(earlier: ArchiveUpgrade | undefined, now: T, exists: (key: string) => boolean): T {
  const kept = (earlier?.upgraded ?? []).filter((k) => !now.upgraded.includes(k) && exists(k));
  if (!kept.length) return now;
  return {
    ...now,
    upgraded: [...now.upgraded, ...kept],
    skipped: now.skipped.filter((s) => !kept.some((k) => s.startsWith(`${k}:`))),
    status: now.status === "error" ? "error" : now.status === "none" || now.skipped.length ? "partial" : now.status,
    reason: [now.reason, `${kept.length} record(s) kept from an earlier read (${earlier?.reader ?? "junit-1"})`].filter(Boolean).join("; "),
  };
}

export async function upgradeFromArchive(store: LocalHealthStore, manifest: RunManifest): Promise<ArchiveUpgrade> {
  const attempts = (manifest.archive?.attempts ?? 0) + 1;
  const raw = store.read(rawLogKey(manifest.sdk, manifest.runId, manifest.runAttempt));
  const done = (a: Omit<ArchiveUpgrade, "attempts">): ArchiveUpgrade => {
    const archive = { ...keepEarlierUpgrades(manifest.archive, a, (k) => !!store.read(k)), attempts, reader: JUNIT_READER_VERSION };
    store.writeManifest({ ...manifest, archive });
    return archive;
  };
  if (!raw) return done({ status: "none", upgraded: [], skipped: [], reason: "no stored log to find the archive from" });

  const archives = uploadedArchivesByJob(gunzipSync(raw).toString("utf8"));
  const records = manifest.records
    .map((k) => ({ key: k, rec: JSON.parse(store.read(k)?.toString("utf8") ?? "null") as RunRecord | null }))
    .filter((x): x is { key: string; rec: RunRecord } => !!x.rec && !!x.rec.counts);
  if (!Object.keys(archives).length) return done({ status: "none", upgraded: [], skipped: [], reason: "the log names no uploaded run archive" });

  const upgraded: string[] = [];
  const skipped: string[] = [];
  const byArchive = new Map<string, { key: string; rec: RunRecord }[]>();
  for (const x of records) {
    const uri = x.rec.ci.job ? archives[x.rec.ci.job] : undefined;
    if (!uri) {
      skipped.push(`${x.key}: its job uploaded no archive`);
      continue;
    }
    (byArchive.get(uri) ?? byArchive.set(uri, []).get(uri)!).push(x);
  }

  let missing = 0;
  const errors: string[] = [];
  for (const [uri, group] of byArchive) {
    // Each archive is handled on its own: one that can't be read (a timed-out range GET, a
    // corrupt tarball) is recorded and the rest are still tried. Only bad credentials stop
    // the whole backfill, since every other archive would fail the same way.
    try {
      let zip: S3Zip;
      try {
        zip = await S3Zip.open(uri);
      } catch (err) {
        if (isCredentialError(err)) throw err;
        if (!isMissingObject(err)) throw err;
        missing++;
        skipped.push(...group.map((x) => `${x.key}: ${uri} no longer exists (S3 keeps runs/ for 180 days)`));
        continue;
      }
      const tarballs = zip.entries.map((e) => e.name).filter((n) => n.endsWith("surefire-reports.tar.gz"));
      for (const x of group) {
        const m = matchTarball(x.rec, tarballs, group.map((g) => g.rec).filter((r) => r !== x.rec));
        if ("reason" in m) {
          skipped.push(`${x.key}: ${m.reason}`);
          continue;
        }
        const entry = zip.entries.find((e) => e.name === m.path)!;
        const rec = await upgradeRecord(x.rec, await zip.read(entry), uri, m.path);
        if ("reason" in rec) {
          skipped.push(`${x.key}: ${rec.reason}`);
          continue;
        }
        store.write(x.key, JSON.stringify(rec) + "\n");
        upgraded.push(x.key);
      }
    } catch (err) {
      if (isCredentialError(err)) throw err;
      errors.push(`${uri}: ${String(err instanceof Error ? err.message : err)}`.slice(0, 300));
    }
  }
  // A read error is worth retrying (see needsArchiveUpgrade); everything upgraded so far is kept.
  if (errors.length) return done({ status: "error", upgraded, skipped, reason: errors.join("; ") });
  const status = upgraded.length === 0 ? "none" : skipped.length ? "partial" : "ok";
  return done({ status, upgraded, skipped, ...(missing ? { reason: `${missing} archive(s) expired` } : {}) });
}
