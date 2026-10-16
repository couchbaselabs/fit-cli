/** Tar archives built by hand for tests, so long-name and odd entries can be shaped exactly. */
import { gzipSync } from "node:zlib";

/** A tar archive: `entries` are [header name, type flag, data]. */
export function tar(entries: [string, string, string][]): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, type, data] of entries) {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0, "utf8");
    h.write("0000644\0", 100, "utf8");
    h.write(Buffer.byteLength(data).toString(8).padStart(11, "0") + "\0", 124, "utf8");
    h.write("00000000000\0", 136, "utf8");
    h.write(type, 156, "utf8");
    h.write("ustar\x0000", 257, "latin1");
    // The checksum is the byte sum of the header, counting its own field as spaces.
    h.fill(" ", 148, 156);
    h.write(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
    const body = Buffer.alloc(Math.ceil(Buffer.byteLength(data) / 512) * 512);
    body.write(data, 0, "utf8");
    blocks.push(h, body);
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export const tarGz = (entries: [string, string, string][]): Buffer => gzipSync(tar(entries));
