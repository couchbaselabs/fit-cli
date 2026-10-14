/**
 * Every test outcome in a run's surefire JUnit XML - passes and skips included, which is what
 * a run record needs and what junit-to-markdown.ts deliberately does not keep (it names only
 * failing cases, for the CI summary). Kept separate so the summary/Slack code is untouched.
 *
 * Test identity is `SimpleClass.method`: the name fit-cli prints in its ❌/💥 lines without a
 * parameterised test's signature and repeat index (`durability(Durability)[2]` is the test
 * `durability`; see splitVariant). The log parser names tests the same way, so a record built
 * from JUnit and one scraped from the log are directly comparable. The variants that failed
 * are kept beside the test (`v`).
 */
import { classKey, splitVariant } from "./test-identity.js";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";
import tar from "tar-stream";
import { addOutcome, addVariant, type ClassOutcomes, type ResultCounts } from "../record/run-record.js";
import { getXmlAttr } from "../../../util/non-fit/xml.js";
export { decodeXmlEntities } from "../../../util/non-fit/xml.js";

export interface JunitOutcomes {
  tests: Record<string, ClassOutcomes>;
  /** Simple class name -> Java package. */
  packages: Record<string, string>;
  counts: ResultCounts;
  /** TEST-*.xml files read. */
  files: number;
  /**
   * Test id -> the situational run UUIDs its captured output names (see StreamSectionStripper).
   * How a situational scenario's score is tied to its test; empty for functional runs.
   */
  runUuids: Record<string, string[]>;
}

/**
 * The canonical test id: `Class.method`, where Class is the simple class name - or, for a name
 * the driver uses in several packages, a package-qualified one - and method is the name without
 * a parameterised test's variant (see test-identity.ts).
 */
export function canonicalTestName(classname: string, name: string): string {
  return `${classKey(classname)}.${splitVariant(name).method}`;
}

type Outcome = "p" | "f" | "e" | "s";
/** When a test runs several times (parameterised, several APIs), the worst outcome wins. */
const RANK: Record<Outcome, number> = { s: 0, p: 1, f: 2, e: 3 };

/** Outcomes from the XML of any number of TEST-*.xml files. */
export function junitOutcomes(xmls: Iterable<string>): JunitOutcomes {
  const worst = new Map<string, Outcome>();
  const failedAs = new Map<string, Set<string>>();
  const packages: Record<string, string> = {};
  const counts: ResultCounts = { passed: 0, failed: 0, errored: 0, skipped: 0 };
  const runUuids: Record<string, string[]> = {};
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
      const { variant } = splitVariant(name);
      if (variant && (outcome === "f" || outcome === "e")) (failedAs.get(id) ?? failedAs.set(id, new Set()).get(id)!).add(variant);
      for (const u of inner.matchAll(RUN_UUID)) {
        const list = (runUuids[id] ??= []);
        if (!list.includes(u[1])) list.push(u[1]);
      }
    }
  }
  const tests: Record<string, ClassOutcomes> = {};
  for (const [id, outcome] of [...worst.entries()].sort(([a], [b]) => a.localeCompare(b))) addOutcome(tests, id, outcome);
  for (const [id, variants] of failedAs) for (const v of [...variants].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) addVariant(tests, id, v);
  return { tests, packages, counts, files, runUuids };
}

/**
 * A situational run's UUID, as the driver logs it ("... for situationalRunUuid <uuid> and
 * runUuid=<uuid>") and as StreamSectionStripper keeps it (`<!--runUuid=<uuid>-->`).
 */
const RUN_UUID = /runUuid=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

/**
 * Drops <system-out>/<system-err> bodies from XML arriving in chunks. Those sections are
 * captured test output, can run to gigabytes (a single night's reports once expanded past
 * 4 GB), and say nothing about outcomes - except, for a situational test, which scenario run
 * it was. So a `runUuid=` the output names is kept, as a `<!--runUuid=…-->` comment where the
 * section was: the testcase it sits in is the test that run's score belongs to.
 */
export class StreamSectionStripper {
  private kept: string[] = [];
  private carry = "";
  private closeTag: string | undefined;
  /** The run UUIDs the open section has named so far, and its last few characters, so a match split across chunks is still seen. */
  private uuids = new Set<string>();
  private scanTail = "";

  private scan(dropped: string): void {
    const text = this.scanTail + dropped;
    for (const m of text.matchAll(RUN_UUID)) this.uuids.add(m[1]);
    this.scanTail = text.slice(-64);
  }

  push(chunk: string): void {
    let s = this.carry + chunk;
    this.carry = "";
    for (;;) {
      if (this.closeTag) {
        const end = s.indexOf(this.closeTag);
        if (end < 0) {
          // Keep enough of the tail to spot a close tag split across chunks.
          const cut = Math.max(0, s.length - this.closeTag.length);
          this.scan(s.slice(0, cut));
          this.carry = s.slice(cut);
          return;
        }
        this.scan(s.slice(0, end));
        for (const u of this.uuids) this.kept.push(`<!--runUuid=${u}-->`);
        this.uuids.clear();
        this.scanTail = "";
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
    this.uuids.clear();
    this.scanTail = "";
    return out;
  }
}

/**
 * The regular files in a tar archive (gzipped or not), streamed: each file whose name `want`
 * accepts is handed to `read` as it arrives, the rest are skipped, and the archive is never
 * held expanded. tar-stream resolves long names (GNU `L` entries, pax `path=`), which test
 * classes with long names need: ignoring them once silently dropped 11 of a night's 288 reports.
 */
export async function forEachTarFile(
  archive: Buffer,
  opts: { gzip: boolean },
  want: (name: string) => boolean,
  read: (name: string, data: AsyncIterable<Buffer>) => Promise<void>,
): Promise<void> {
  const extract = tar.extract();
  const source = Readable.from([archive]);
  (opts.gzip ? source.pipe(createGunzip()) : source).pipe(extract);
  for await (const entry of extract) {
    const { name, type } = entry.header;
    if (type === "file" && want(name)) await read(name, entry);
    else entry.resume();
  }
}

/**
 * The TEST-*.xml files inside a `.tar.gz`, as fit-cli writes surefire-reports.tar.gz, with
 * captured test output removed as it streams (see StreamSectionStripper).
 */
export async function junitXmlFromTarGz(archive: Buffer): Promise<string[]> {
  const out: string[] = [];
  const isReport = (name: string) => /^TEST-.*\.xml$/.test(name.slice(name.lastIndexOf("/") + 1));
  await forEachTarFile(archive, { gzip: true }, isReport, async (_name, data) => {
    const stripper = new StreamSectionStripper();
    const decoder = new StringDecoder("utf8");
    for await (const chunk of data) stripper.push(decoder.write(chunk));
    stripper.push(decoder.end());
    out.push(stripper.finish());
  });
  return out;
}
