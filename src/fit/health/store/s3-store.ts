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
 * It works within fit-cli-role's S3 permissions, which are GetObject and PutObject on
 * fit-cli/* - no ListBucket, no DeleteObject (terraform/aws/fit-cli-role.tf):
 *   - Keys are found through an index object per SDK, <sdk>/index.json, not by listing.
 *   - A push goes in stages: records and raw logs, then the manifests that vouch for them,
 *     then the index. A push that dies part-way therefore never leaves a manifest saying work
 *     is done when the data it describes didn't land; that run is simply redone next time.
 *   - Removing a key drops it from the index; its object stays behind, unreferenced.
 *   - Without ListBucket, S3 answers a missing object with the same AccessDenied as a real
 *     permission problem. So a missing index is an error unless the caller says it is
 *     creating the store - otherwise a glitch could replace a real index with an empty one.
 *
 * Nothing defaults to S3: a command reads or writes the shared store only when told to, with
 * --store s3://… or FIT_HEALTH_STORE.
 */
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { s3Client } from "../../../cloud/util/aws/aws-clients.js";
import { fitCliInfo } from "../../../util/non-fit/fit-cli-log.js";
import { parseS3Uri } from "../emit/s3-zip.js";
import { LocalHealthStore, defaultHealthStoreRoot } from "./health-store.js";

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
  flush: () => Promise<{ written: number; removed: number }>;
  /** Delete the local mirror (a no-op for a local store). Call it once the command is done. */
  close: () => void;
}

export interface OpenStoreOptions {
  /** Create the SDK's part of an S3 store if it has no index yet. */
  create?: boolean;
  /** Don't pull the raw CI logs: for commands that only read records, manifests and notes. */
  skipRawLogs?: boolean;
}

/** Run `worker` over `items`, at most `limit` at a time. */
async function inParallel<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await worker(items[next++]);
    }),
  );
}

/** The per-SDK index object: every key in that SDK's part of the store. */
export const INDEX_KEY = "index.json";

interface StoreIndex {
  schema: 1;
  keys: string[];
}

/**
 * The order changed keys are pushed in: everything else first, then the manifests, which
 * vouch for the records and logs of their run. (The index follows, after both.)
 */
export function pushStages(written: Iterable<string>): string[][] {
  const keys = [...written];
  const isManifest = (k: string) => /^[^/]+\/manifests\//.test(k);
  return [keys.filter((k) => !isManifest(k)), keys.filter(isManifest)].filter((stage) => stage.length);
}

/** The index after a command's changes: what was there, plus what was written, minus what was removed. */
export function nextIndex(before: readonly string[], written: Iterable<string>, removed: Iterable<string>): string[] {
  const keys = new Set(before);
  for (const k of written) keys.add(k);
  for (const k of removed) keys.delete(k);
  return [...keys].sort();
}

function isMissingOrDenied(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "AccessDenied" || e?.$metadata?.httpStatusCode === 404 || e?.$metadata?.httpStatusCode === 403;
}

/**
 * Open `spec` (a directory, an s3:// URI, or undefined for the default local store) for work
 * on `sdk`. For S3, the SDK's prefix is mirrored into a fresh cache directory.
 */
export async function openStore(spec: string | undefined, sdk: string, opts: OpenStoreOptions = {}): Promise<OpenedStore> {
  const where = spec ?? defaultHealthStoreRoot();
  if (!where.startsWith("s3://")) {
    return { store: new LocalHealthStore(where), location: where, flush: () => Promise.resolve({ written: 0, removed: 0 }), close: () => {} };
  }

  const { bucket, key } = parseS3Uri(where.endsWith("/") ? where : `${where}/`);
  const prefix = key.endsWith("/") ? key : `${key}/`;
  const mirror = mkdtempSync(join(tmpdir(), "fit-health-store-"));
  const store = new TrackingHealthStore(mirror);
  const indexKey = `${prefix}${sdk}/${INDEX_KEY}`;
  let keys: string[] = [];
  // Until the store is handed back, nothing else can close it: a failed pull removes its own mirror.
  try {
    try {
      const res = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: indexKey }));
      keys = (JSON.parse(await res.Body!.transformToString()) as StoreIndex).keys;
    } catch (err) {
      if (!isMissingOrDenied(err)) throw err;
      if (!opts.create) {
        throw new Error(
          `No fit health store for ${sdk} at s3://${bucket}/${prefix} (could not read ${INDEX_KEY}). ` +
            `If this is the first run for ${sdk}, pass --create-store; otherwise check the AWS credentials.`,
          { cause: err },
        );
      }
      fitCliInfo(`fit health: creating a new store for ${sdk} at s3://${bucket}/${prefix}`);
    }
    const pull = opts.skipRawLogs ? keys.filter((k) => !k.startsWith(`${sdk}/raw/`)) : keys;
    fitCliInfo(`fit health: pulling ${pull.length} objects for ${sdk} from s3://${bucket}/${prefix}${sdk}/`);
    await inParallel(pull, 16, async (k) => {
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
        await inParallel(stage, 16, async (k) => {
          await s3Client.send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}${k}`, Body: readFileSync(store.path(k)) }));
        });
      }
      if (!written.length && !removed.length) return { written: 0, removed: 0 };
      // The index goes last: until it lands, the previous index still describes the store.
      const index: StoreIndex = { schema: 1, keys: nextIndex(keys, written, removed) };
      await s3Client.send(new PutObjectCommand({ Bucket: bucket, Key: indexKey, Body: JSON.stringify(index), ContentType: "application/json" }));
      keys = index.keys;
      store.written.clear();
      store.removed.clear();
      fitCliInfo(`fit health: pushed ${written.length} changed objects${removed.length ? ` and dropped ${removed.length} from the index` : ""} to s3://${bucket}/${prefix}`);
      return { written: written.length, removed: removed.length };
    },
    close: () => rmSync(mirror, { recursive: true, force: true }),
  };
}
