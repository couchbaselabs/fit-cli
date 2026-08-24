/** The S3 side of the queue. S3 has no rename, so a move is a copy then a delete. */
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from "@aws-sdk/client-s3";

export interface S3File {
  key: string;
  lastModified: Date;
}

/** One run directory under incoming/<sit>/<run>/. Segments are not yet validated as UUIDs. */
export interface IncomingRun {
  sitSegment: string;
  runSegment: string;
  files: S3File[];
}

export const INCOMING_PREFIX = "incoming/";
export const PROCESSED_PREFIX = "processed/";
export const FAILED_PREFIX = "failed/";

/** Keys not shaped like incoming/<sit>/<run>/<file> are returned as strays. */
export function groupIncomingKeys(files: S3File[]): { runs: IncomingRun[]; strayKeys: string[] } {
  const byDir = new Map<string, IncomingRun>();
  const strayKeys: string[] = [];
  for (const file of files) {
    const parts = file.key.split("/");
    // ["incoming", sit, run, ...file]
    if (parts.length < 4 || parts[3] === "") {
      strayKeys.push(file.key);
      continue;
    }
    const dirKey = `${parts[1]}/${parts[2]}`;
    let run = byDir.get(dirKey);
    if (run === undefined) {
      run = { sitSegment: parts[1], runSegment: parts[2], files: [] };
      byDir.set(dirKey, run);
    }
    run.files.push(file);
  }
  return { runs: [...byDir.values()], strayKeys };
}

export class S3Queue {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  private async listAll(prefix: string, maxKeys?: number): Promise<S3File[]> {
    const files: S3File[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of page.Contents ?? []) {
        if (obj.Key !== undefined) {
          files.push({ key: obj.Key, lastModified: obj.LastModified ?? new Date(0) });
        }
      }
      continuationToken = page.NextContinuationToken;
      if (maxKeys !== undefined && files.length >= maxKeys) break;
    } while (continuationToken !== undefined);
    return files;
  }

  async listIncoming(): Promise<{ runs: IncomingRun[]; strayKeys: string[] }> {
    return groupIncomingKeys(await this.listAll(INCOMING_PREFIX));
  }

  async listRunKeys(run: IncomingRun): Promise<string[]> {
    const files = await this.listAll(`${INCOMING_PREFIX}${run.sitSegment}/${run.runSegment}/`);
    return files.map((f) => f.key).sort();
  }

  async getText(key: string): Promise<string> {
    const result = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (result.Body === undefined) throw new Error(`Empty body for s3://${this.bucket}/${key}`);
    return await result.Body.transformToString();
  }

  /**
   * Moves every file of a run to <destPrefix><yyyy-mm-dd>/<sit>/<run>/.
   * A crash midway leaves files behind in incoming/. The next tick re-ingests
   * them, which the upserts make harmless.
   */
  async moveRun(run: IncomingRun, destPrefix: string, date: Date): Promise<string> {
    const day = date.toISOString().slice(0, 10);
    const destDir = `${destPrefix}${day}/${run.sitSegment}/${run.runSegment}/`;
    // Move run.json5 last. A crash mid-move then leaves a directory that still
    // has its manifest, so the next tick re-ingests and finishes the move.
    const ordered = [...run.files].sort(
      (a, b) =>
        Number(a.key.endsWith("/run.json5")) - Number(b.key.endsWith("/run.json5")) || a.key.localeCompare(b.key),
    );
    for (const file of ordered) {
      const basename = file.key.split("/").slice(3).join("/");
      await this.s3.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          CopySource: `${this.bucket}/${encodeURIComponent(file.key).replaceAll("%2F", "/")}`,
          Key: `${destDir}${basename}`,
        }),
      );
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: file.key }));
    }
    return destDir;
  }

  /** Capped, so a huge backlog reports the cap. That is alarming enough. */
  async countFailedBacklog(maxKeys = 10000): Promise<number> {
    const files = await this.listAll(FAILED_PREFIX, maxKeys);
    const dirs = new Set<string>();
    for (const file of files) {
      // failed/<yyyy-mm-dd>/<sit>/<run>/<file>
      dirs.add(file.key.split("/").slice(0, 4).join("/"));
    }
    return dirs.size;
  }
}
