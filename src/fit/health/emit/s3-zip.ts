#!/usr/bin/env node
/**
 * Read single members out of a zip on S3 with ranged GETs, without downloading the zip.
 *
 *   bun src/fit/health/emit/s3-zip.ts list s3://fit-cli/runs/20260928-001945-4510.zip [--grep surefire]
 *   bun src/fit/health/emit/s3-zip.ts get  s3://fit-cli/runs/20260928-001945-4510.zip <member> <out file>
 *
 * The run archives in s3://fit-cli/runs/ reach 1.5 GB, but what `fit health` needs from one
 * (surefire-reports.tar.gz) is a few MB. A zip keeps its index - the central directory - at
 * the end, so: read the tail, find the index, then fetch just the member's bytes. ZIP64 is
 * handled, since archiver writes it for large archives.
 */
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { s3Client } from "../../../cloud/util/aws/aws-clients.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** EOCD is 22 bytes plus an up-to-64 KiB comment; the ZIP64 locator sits 20 bytes before it. */
export const ZIP_TAIL_BYTES = 22 + 0xffff + 20;

/** Where the central directory is, from the archive's tail bytes. `tailStart` is the tail's offset in the file. */
export function findCentralDirectory(tail: Buffer, tailStart: number): { offset: number; size: number; entries: number } {
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: end-of-central-directory record not found");
  let entries = tail.readUInt16LE(eocd + 10);
  let size = tail.readUInt32LE(eocd + 12);
  let offset = tail.readUInt32LE(eocd + 16);
  if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== ZIP64_LOCATOR_SIG) throw new Error("ZIP64 archive without a ZIP64 locator");
    const recAt = Number(tail.readBigUInt64LE(loc + 8)) - tailStart;
    if (recAt < 0 || tail.readUInt32LE(recAt) !== ZIP64_EOCD_SIG) throw new Error("ZIP64 end-of-central-directory record is outside the tail read");
    entries = Number(tail.readBigUInt64LE(recAt + 32));
    size = Number(tail.readBigUInt64LE(recAt + 40));
    offset = Number(tail.readBigUInt64LE(recAt + 48));
  }
  return { offset, size, entries };
}

/** Parse central-directory entries, taking sizes and offsets from the ZIP64 extra field when needed. */
export function parseCentralDirectory(cd: Buffer): ZipEntry[] {
  const out: ZipEntry[] = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === CENTRAL_SIG) {
    const method = cd.readUInt16LE(p + 10);
    let compressedSize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localHeaderOffset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) {
          size = Number(cd.readBigUInt64LE(q));
          q += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = Number(cd.readBigUInt64LE(q));
          q += 8;
        }
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = Number(cd.readBigUInt64LE(q));
      }
      e += 4 + len;
    }
    out.push({ name, method, compressedSize, size, localHeaderOffset });
    p = extraEnd + commentLen;
  }
  return out;
}

/** A member's bytes, given its local header plus data. */
export function extractMember(entry: ZipEntry, localAndData: Buffer): Buffer {
  if (localAndData.readUInt32LE(0) !== LOCAL_SIG) throw new Error(`${entry.name}: bad local header`);
  const start = 30 + localAndData.readUInt16LE(26) + localAndData.readUInt16LE(28);
  const data = localAndData.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`${entry.name}: unsupported zip compression method ${entry.method}`);
}

export function parseS3Uri(uri: string): { bucket: string; key: string } {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) throw new Error(`Not an s3:// URI: ${uri}`);
  return { bucket: m[1], key: m[2] };
}

async function getRange(bucket: string, key: string, start: number, endInclusive: number): Promise<Buffer> {
  const res = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${start}-${endInclusive}` }));
  return Buffer.from(await res.Body!.transformToByteArray());
}

export class S3Zip {
  private constructor(
    readonly bucket: string,
    readonly key: string,
    readonly entries: ZipEntry[],
  ) {}

  static async open(uri: string): Promise<S3Zip> {
    const { bucket, key } = parseS3Uri(uri);
    const head = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const total = head.ContentLength ?? 0;
    const tailStart = Math.max(0, total - ZIP_TAIL_BYTES);
    const tail = await getRange(bucket, key, tailStart, total - 1);
    const cd = findCentralDirectory(tail, tailStart);
    const cdBytes = cd.offset >= tailStart
      ? tail.subarray(cd.offset - tailStart, cd.offset - tailStart + cd.size)
      : await getRange(bucket, key, cd.offset, cd.offset + cd.size - 1);
    return new S3Zip(bucket, key, parseCentralDirectory(cdBytes));
  }

  async read(entry: ZipEntry): Promise<Buffer> {
    // The local header's name and extra lengths aren't known yet; 64 KiB of slack covers them.
    const bytes = await getRange(this.bucket, this.key, entry.localHeaderOffset, entry.localHeaderOffset + 30 + 0xffff * 2 + entry.compressedSize);
    return extractMember(entry, bytes);
  }
}

if (isMain(import.meta.url)) {
  const [cmd, uri, member, out] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h" || !uri) {
    console.log(`Read members of a zip on S3 without downloading it.

Usage:
  bun src/fit/health/emit/s3-zip.ts list <s3://bucket/key.zip> [--grep <text>]
  bun src/fit/health/emit/s3-zip.ts get  <s3://bucket/key.zip> <member> <out file>`);
    process.exit(cmd ? 0 : 1);
  }
  runCli(async () => {
    const zip = await S3Zip.open(uri);
    if (cmd === "list") {
      const grep = process.argv.indexOf("--grep");
      const filter = grep >= 0 ? process.argv[grep + 1] : undefined;
      for (const e of zip.entries.filter((x) => !filter || x.name.includes(filter))) console.log(`${String(e.size).padStart(12)}  ${e.name}`);
      console.log(`${zip.entries.length} entries`);
    } else if (cmd === "get") {
      const entry = zip.entries.find((e) => e.name === member);
      if (!entry) throw new Error(`${member} is not in ${uri}`);
      writeFileSync(out, await zip.read(entry));
      console.log(`wrote ${out}`);
    }
  });
}
