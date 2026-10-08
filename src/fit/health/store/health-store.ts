/**
 * Where run records, manifests and raw logs live. Keys are relative paths
 * (`dotnet/records/2026/...json`) so a local directory and, later, an S3 prefix
 * (s3://fit-cli/health/) are interchangeable. Only the local backend exists so far.
 *
 * Default root: ~/.fit-cli/health. Override with --store <dir> or FIT_HEALTH_STORE.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { FIT_CLI_CONFIG_DIRNAME } from "../../util/config.js";
import { MANIFEST_SCHEMA, manifestKey, type RunManifest } from "../record/run-manifest.js";
import { recordKey, type RunRecord } from "../record/run-record.js";

export const HEALTH_STORE_ENV_VAR = "FIT_HEALTH_STORE";

export function defaultHealthStoreRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env[HEALTH_STORE_ENV_VAR]?.trim() || join(home, FIT_CLI_CONFIG_DIRNAME, "health");
}

export class LocalHealthStore {
  constructor(readonly root: string) {}

  /**
   * The file for `key`. Keys come from the shared S3 index and from command arguments, so one
   * that would land outside the store (`../`, an absolute path) is refused, never followed.
   */
  path(key: string): string {
    const root = resolve(this.root);
    const p = resolve(root, ...key.split("/"));
    if (p !== root && !p.startsWith(root + sep)) throw new Error(`Refusing store key outside the store: ${JSON.stringify(key)}`);
    return p;
  }

  read(key: string): Buffer | undefined {
    const p = this.path(key);
    return existsSync(p) ? readFileSync(p) : undefined;
  }

  write(key: string, data: string | Buffer): string {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
    return p;
  }

  remove(key: string): void {
    rmSync(this.path(key), { force: true });
  }

  /** Keys under a prefix, recursively, sorted. */
  list(prefix: string): string[] {
    const base = this.path(prefix);
    if (!existsSync(base)) return [];
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push(relative(this.root, full).split(sep).join("/"));
      }
    };
    walk(base);
    return out.sort();
  }

  readManifest(sdk: string, runId: number, runAttempt: number): RunManifest | undefined {
    const raw = this.read(manifestKey(sdk, runId, runAttempt));
    if (!raw) return undefined;
    const m = JSON.parse(raw.toString("utf8")) as RunManifest;
    return m.schema === MANIFEST_SCHEMA ? m : undefined;
  }

  /** Every manifest of the SDK's runs, in key order. One written under another schema is left out, as readManifest leaves it out. */
  listManifests(sdk: string): RunManifest[] {
    return this.list(`${sdk}/manifests`)
      .map((k) => JSON.parse(this.read(k)!.toString("utf8")) as RunManifest)
      .filter((m) => m.schema === MANIFEST_SCHEMA);
  }

  writeManifest(manifest: RunManifest): void {
    this.write(manifestKey(manifest.sdk, manifest.runId, manifest.runAttempt), JSON.stringify(manifest, null, 1) + "\n");
  }

  writeRecord(record: RunRecord): string {
    const key = recordKey(record);
    this.write(key, JSON.stringify(record) + "\n");
    return key;
  }

  /**
   * The SDK's records that a manifest vouches for. A record file no manifest lists is not read:
   * it is one a reparse replaced whose deletion didn't land (an S3 push that died after the
   * manifests went up), or one whose manifest hasn't landed yet. Either way it isn't data.
   */
  readRecords(sdk: string): RunRecord[] {
    const vouched = new Set<string>();
    for (const m of this.listManifests(sdk)) {
      for (const r of [...m.records, ...(m.archive?.upgraded ?? [])]) vouched.add(r);
    }
    return this.list(`${sdk}/records`)
      .filter((k) => k.endsWith(".json") && vouched.has(k))
      .map((k) => JSON.parse(this.read(k)!.toString("utf8")) as RunRecord);
  }
}
