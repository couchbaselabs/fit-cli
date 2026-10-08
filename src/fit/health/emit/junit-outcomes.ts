/**
 * Every test outcome in a run's surefire JUnit XML - passes and skips included, which is what
 * a run record needs and what junit-to-markdown.ts deliberately does not keep (it names only
 * failing cases, for the CI summary). Kept separate so the summary/Slack code is untouched.
 *
 * Test identity is `SimpleClass.name`, the same spelling fit-cli prints in its ❌/💥 lines,
 * cut at the first whitespace as the log parser does. That makes a record built from JUnit
 * and one scraped from the log directly comparable, and collapses a parameterised test's
 * repeats (`method(Param) [2]`) into one test exactly as the log does.
 */
import { classKey } from "./test-identity.js";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { ClassOutcomes, ResultCounts } from "../record/run-record.js";
import { getXmlAttr } from "../../../util/non-fit/xml.js";
export { decodeXmlEntities } from "../../../util/non-fit/xml.js";

export interface JunitOutcomes {
  tests: Record<string, ClassOutcomes>;
  /** Simple class name -> Java package. */
  packages: Record<string, string>;
  counts: ResultCounts;
  /** TEST-*.xml files read. */
  files: number;
}

/**
 * The canonical test id: the part of `Class.name` before any whitespace, where Class is the
 * simple class name - or, for a name the driver uses in several packages, a package-qualified
 * one (see test-identity.ts).
 */
export function canonicalTestName(classname: string, name: string): string {
  return `${classKey(classname)}.${name}`.split(/\s/)[0];
}

type Outcome = "p" | "f" | "e" | "s";
/** When a test runs several times (parameterised, several APIs), the worst outcome wins. */
const RANK: Record<Outcome, number> = { s: 0, p: 1, f: 2, e: 3 };

/** Outcomes from the XML of any number of TEST-*.xml files. */
export function junitOutcomes(xmls: Iterable<string>): JunitOutcomes {
  const worst = new Map<string, Outcome>();
  const packages: Record<string, string> = {};
  const counts: ResultCounts = { passed: 0, failed: 0, errored: 0, skipped: 0 };
  let files = 0;
  const caseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const xml of xmls) {
    files++;
    let m: RegExpExecArray | null;
    caseRe.lastIndex = 0;
    while ((m = caseRe.exec(xml)) !== null) {
      const inner = m[2] ?? "";
      const outcome: Outcome = /<error\b/.test(inner) ? "e" : /<failure\b/.test(inner) ? "f" : /<skipped\b/.test(inner) ? "s" : "p";
      counts[({ p: "passed", f: "failed", e: "errored", s: "skipped" } as const)[outcome]]++;
      const classname = getXmlAttr(m[1], "classname");
      const dot = classname.lastIndexOf(".");
      if (dot > 0) packages[classKey(classname)] = classname.slice(0, dot);
      const name = getXmlAttr(m[1], "name");
      // A class-level failure (setup/teardown) has no method; keep it as `Class.`. A nameless
      // entry that passed or was skipped (JUnit writes one for a skipped @Nested class) is no
      // outcome of any test, so it is counted but not kept.
      if (!name && (outcome === "p" || outcome === "s")) continue;
      const id = name ? canonicalTestName(classname, name) : `${classKey(classname)}.`;
      const prev = worst.get(id);
      if (!prev || RANK[outcome] > RANK[prev]) worst.set(id, outcome);
    }
  }
  const tests: Record<string, ClassOutcomes> = {};
  for (const [id, outcome] of [...worst.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dot = id.indexOf(".");
    const cls = id.slice(0, dot);
    const method = id.slice(dot + 1);
    const entry = (tests[cls] ??= {});
    if (!method) {
      entry.classError = true;
      continue;
    }
    (entry[outcome] ??= []).push(method);
  }
  return { tests, packages, counts, files };
}

/**
 * Drops <system-out>/<system-err> bodies from XML arriving in chunks. Those sections are
 * captured test output, can run to gigabytes (a single night's reports once expanded past
 * 4 GB), and say nothing about outcomes.
 */
export class StreamSectionStripper {
  private kept: string[] = [];
  private carry = "";
  private closeTag: string | undefined;

  push(chunk: string): void {
    let s = this.carry + chunk;
    this.carry = "";
    for (;;) {
      if (this.closeTag) {
        const end = s.indexOf(this.closeTag);
        if (end < 0) {
          // Keep enough of the tail to spot a close tag split across chunks.
          this.carry = s.slice(-this.closeTag.length);
          return;
        }
        s = s.slice(end + this.closeTag.length);
        this.closeTag = undefined;
        continue;
      }
      const m = /<system-(out|err)\b[^>]*?(\/?)>/.exec(s);
      if (!m) {
        // A tag may start in this chunk and end in the next.
        const lt = s.lastIndexOf("<");
        const cut = lt >= 0 && s.length - lt < 64 ? lt : s.length;
        this.kept.push(s.slice(0, cut));
        this.carry = s.slice(cut);
        return;
      }
      this.kept.push(s.slice(0, m.index));
      s = s.slice(m.index + m[0].length);
      if (!m[2]) this.closeTag = `</system-${m[1]}>`;
    }
  }

  finish(): string {
    const out = this.kept.join("") + (this.closeTag ? "" : this.carry);
    this.kept = [];
    this.carry = "";
    this.closeTag = undefined;
    return out;
  }
}

/**
 * The TEST-*.xml files inside a `.tar.gz`, as fit-cli writes surefire-reports.tar.gz, with
 * captured test output removed. Streams: the archive is decompressed a chunk at a time and
 * never held whole.
 *
 * A minimal tar reader for regular files, plus the two ways tar records a name longer than
 * the header's 100 bytes: GNU tar (which makes fit-cli's archives) writes an `L` entry whose
 * data is the next entry's name, and POSIX/bsdtar writes a pax `x` header with `path=`.
 * Test classes with long names are common enough that ignoring these silently dropped 11 of
 * one night's 288 reports.
 */
export async function junitXmlFromTarGz(archive: Buffer): Promise<string[]> {
  const out: string[] = [];
  let buf: Buffer = Buffer.alloc(0);
  // State for the entry being read.
  let remaining = 0;
  let padding = 0;
  let entry: { kind: "xml"; stripper: StreamSectionStripper } | { kind: "meta"; type: string; parts: Buffer[] } | { kind: "skip" } | undefined;
  let longName: string | undefined;
  let ended = false;

  const finishEntry = () => {
    if (!entry) return;
    if (entry.kind === "xml") out.push(entry.stripper.finish());
    else if (entry.kind === "meta") {
      const text = Buffer.concat(entry.parts).toString("utf8");
      longName = entry.type === "L" ? text.replace(/\0.*$/s, "") : (/(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)?.[1] ?? longName);
    }
    entry = undefined;
  };

  const consume = () => {
    for (;;) {
      if (entry) {
        const n = Math.min(remaining, buf.length);
        const piece = buf.subarray(0, n);
        if (entry.kind === "xml") entry.stripper.push(piece.toString("utf8"));
        else if (entry.kind === "meta") entry.parts.push(Buffer.from(piece));
        buf = buf.subarray(n);
        remaining -= n;
        if (remaining > 0) return;
        finishEntry();
        continue;
      }
      if (padding) {
        const n = Math.min(padding, buf.length);
        buf = buf.subarray(n);
        padding -= n;
        if (padding) return;
      }
      if (ended || buf.length < 512) return;
      const header = buf.subarray(0, 512);
      buf = buf.subarray(512);
      if (header.every((b) => b === 0)) {
        ended = true;
        return;
      }
      const field = (start: number, len: number) => header.subarray(start, start + len).toString("utf8").replace(/\0.*$/s, "");
      const size = parseInt(field(124, 12).trim() || "0", 8);
      const type = field(156, 1);
      remaining = size;
      padding = (512 - (size % 512)) % 512;
      if (type === "L" || type === "x") {
        entry = { kind: "meta", type, parts: [] };
      } else {
        const name = longName ?? (field(345, 155) ? `${field(345, 155)}/` : "") + field(0, 100);
        longName = undefined;
        const base = name.slice(name.lastIndexOf("/") + 1);
        entry = (type === "0" || type === "") && /^TEST-.*\.xml$/.test(base) ? { kind: "xml", stripper: new StreamSectionStripper() } : { kind: "skip" };
      }
      if (remaining === 0) finishEntry();
    }
  };

  for await (const chunk of Readable.from([archive]).pipe(createGunzip())) {
    buf = buf.length ? Buffer.concat([buf, chunk as Buffer]) : (chunk as Buffer);
    consume();
    if (ended) break;
  }
  consume();
  return out;
}
