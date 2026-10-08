/**
 * Open the store a command works on: a local directory (the default, and what a laptop uses),
 * or the shared S3 store (`s3://fit-cli/health/`, what the scheduled health workflow uses).
 *
 * An S3 store is worked on through a local mirror, so every command stays the same whichever
 * store it is given: the SDK's part of the store is pulled into a cache directory first, the
 * command runs on that, and afterwards only the keys it wrote or removed are pushed back.
 * Each SDK's data lives under its own prefix (<sdk>/...), so jobs for different SDKs never
 * touch each other's keys.
 *
 * A push goes in stages: records and raw logs, then the manifests that vouch for them, then
 * the deletions. A push that dies part-way therefore never leaves a manifest saying work is
 * done when the data it describes didn't land; that run is simply redone next time. A
 * deletion that doesn't land leaves a record no manifest lists, which readRecords ignores. The keys
 * are found by listing the SDK's prefix, so two commands for one SDK at once (a CI run and
 * `fit health settings` from a laptop) each write only their own objects and can't drop each
 * other's. A new SDK's prefix is simply empty.
 *
 * Nothing defaults to S3: a command reads or writes the shared store only when told to, with
 * --store s3://… or FIT_HEALTH_STORE.
 */
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { s3Client } from "../../../cloud/util/aws/aws-clients.js";
import { fitCliInfo } from "../../../util/non-fit/fit-cli-log.js";
import { parseS3Uri } from "../../../cloud/util/aws/s3-uri.js";
import { LocalHealthStore, defaultHealthStoreRoot } from "./health-store.js";
import { mapWithConcurrency } from "../../../util/non-fit/concurrency.js";

/** A local store that remembers which keys were written or removed, so they can be pushed. */
export class TrackingHealthStore extends LocalHealthStore {
  readonly written = new Set<string>();
  readonly removed = new Set<string>();

  override write(key: string, data: string | Buffer): string {
    this.removed.delete(key);
    this.written.add(key);
    return super.write(key, data);
  }

  override remove(key: string): void {
    this.written.delete(key);
    this.removed.add(key);
    super.remove(key);
  }
}

export interface OpenedStore {
  store: LocalHealthStore;
  /** Where the store really is, for messages: a directory, or s3://bucket/prefix. */
  location: string;
  /** Push the command's changes back (a no-op for a local store). */
  flush: () => Promise<void>;
  /** Delete the local mirror (a no-op for a local store). Call it once the command is done. */
  close: () => void;
}

export interface OpenStoreOptions {
  /** Don't pull the raw CI logs: for commands that only read records, manifests and notes. */
  skipRawLogs?: boolean;
}

/**
 * The per-SDK index object the store kept before fit-cli-role could list the bucket. A
 * listing that still finds one ignores it, and the next push deletes it.
 */
export const LEGACY_INDEX = "index.json";

/** The order changed keys are pushed in: everything else first, then the manifests, which vouch for the records and logs of their run. */
export function pushStages(written: Iterable<string>): string[][] {
  const keys = [...written];
  const isManifest = (k: string) => /^[^/]+\/manifests\//.test(k);
  return [keys.filter((k) => !isManifest(k)), keys.filter(isManifest)].filter((stage) => stage.length);
}

/** The store keys to pull from a listing of `<prefix><sdk>/`: relative to the store, without the legacy index, raw logs only if wanted. */
export function keysToPull(objectKeys: readonly string[], prefix: string, sdk: string, opts: OpenStoreOptions = {}): string[] {
  return objectKeys
    .map((k) => k.slice(prefix.length))
    .filter((k) => k !== `${sdk}/${LEGACY_INDEX}`)
    .filter((k) => !(opts.skipRawLogs && k.startsWith(`${sdk}/raw/`)))
    .sort();
}

/** Every object key under `prefix` in `bucket`. */
async function listKeys(bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3Client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/**
 * Open `spec` (a directory, an s3:// URI, or undefined for the default local store) for work
 * on `sdk`. For S3, the SDK's prefix is mirrored into a fresh cache directory.
 */
export async function openStore(spec: string | undefined, sdk: string, opts: OpenStoreOptions = {}): Promise<OpenedStore> {
  const where = spec ?? defaultHealthStoreRoot();
  if (!where.startsWith("s3://")) {
    return { store: new LocalHealthStore(where), location: where, flush: () => Promise.resolve(), close: () => {} };
  }

  const { bucket, key } = parseS3Uri(where);
  // The store's prefix, "" for a whole bucket, and otherwise always ending in "/".
  const prefix = key && !key.endsWith("/") ? `${key}/` : key;
  const mirror = mkdtempSync(join(tmpdir(), "fit-health-store-"));
  const store = new TrackingHealthStore(mirror);
  const sdkPrefix = `${prefix}${sdk}/`;
  let legacyIndex = false;
  // Until the store is handed back, nothing else can close it: a failed pull removes its own mirror.
  try {
    let listed: string[];
    try {
      listed = await listKeys(bucket, sdkPrefix);
    } catch (err) {
      throw new Error(`Could not list the fit health store for ${sdk} at s3://${bucket}/${sdkPrefix}: check the AWS credentials.`, { cause: err });
    }
    legacyIndex = listed.includes(`${sdkPrefix}${LEGACY_INDEX}`);
    const pull = keysToPull(listed, prefix, sdk, opts);
    if (!listed.length) fitCliInfo(`fit health: no data for ${sdk} at s3://${bucket}/${sdkPrefix} yet; starting a new store`);
    fitCliInfo(`fit health: pulling ${pull.length} objects for ${sdk} from s3://${bucket}/${sdkPrefix}`);
    await mapWithConcurrency(pull, 16, async (k) => {
      const res = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}${k}` }));
      // Written straight to the cache, bypassing the tracking: pulled keys aren't changes.
      LocalHealthStore.prototype.write.call(store, k, Buffer.from(await res.Body!.transformToByteArray()));
    });
  } catch (err) {
    rmSync(mirror, { recursive: true, force: true });
    throw err;
  }

  return {
    store,
    location: `s3://${bucket}/${prefix}`,
    flush: async () => {
      const written = [...store.written];
      const removed = [...store.removed];
      for (const stage of pushStages(written)) {
        await mapWithConcurrency(stage, 16, async (k) => {
          await s3Client.send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}${k}`, Body: readFileSync(store.path(k)) }));
        });
      }
      // Deletions last: a removed record's replacement and its manifest have landed by now.
      await mapWithConcurrency(removed, 16, async (k) => {
        await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: `${prefix}${k}` }));
      });
      if (legacyIndex) {
        await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: `${sdkPrefix}${LEGACY_INDEX}` }));
        legacyIndex = false;
      }
      store.written.clear();
      store.removed.clear();
      if (written.length || removed.length) {
        fitCliInfo(`fit health: pushed ${written.length} changed objects${removed.length ? ` and deleted ${removed.length}` : ""} to s3://${bucket}/${prefix}`);
      }
    },
    close: () => rmSync(mirror, { recursive: true, force: true }),
  };
}
