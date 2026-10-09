/**
 * Unit tests for reading every test outcome out of surefire JUnit XML, the .tar.gz fit-cli
 * packs it in, and the zip archive that .tar.gz sits in on S3.
 *
 * Fixtures: run.zip and run-zip64.zip (the same content; the second made with `zip -fz`, which
 * forces ZIP64) each hold surefire-reports.tar.gz - two real test-driver reports, trimmed, plus
 * a hand-written LockTest.xml covering failure, error, skip, parameterised repeats and a
 * class-level error - and a session.info.log.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/emit/tests/junit-and-zip.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { StreamSectionStripper, canonicalTestName, decodeXmlEntities, junitOutcomes, junitXmlFromTarGz } from "../junit-outcomes.js";
import { extractMember, findCentralDirectory, parseCentralDirectory } from "../s3-zip.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

/** Read a member the way S3Zip does, but from a local buffer. */
function readZipMember(zip: Buffer, name: string): Buffer {
  const cd = findCentralDirectory(zip, 0);
  const entries = parseCentralDirectory(zip.subarray(cd.offset, cd.offset + cd.size));
  assert.equal(entries.length, cd.entries);
  const entry = entries.find((e) => e.name === name);
  assert.ok(entry, `${name} is in the zip`);
  return extractMember(entry, zip.subarray(entry.localHeaderOffset));
}

test("test ids match fit-cli's ❌ lines: simple class name, cut at the first whitespace", () => {
  assert.equal(canonicalTestName("com.couchbase.client.core.LockTest", "getAndLock"), "LockTest.getAndLock");
  assert.equal(canonicalTestName("com.couchbase.client.core.LockTest", "upsertLocked(API) [2] ASYNC"), "LockTest.upsertLocked(API)");
});

for (const fixture of ["run.zip", "run-zip64.zip"]) {
  test(`${fixture}: surefire-reports.tar.gz is read out of the zip and every outcome kept`, async () => {
    const zip = readFileSync(join(FIXTURES, fixture));
    assert.equal(readZipMember(zip, "session.info.log").toString("utf8"), "hello\n");

    const xmls = await junitXmlFromTarGz(readZipMember(zip, "surefire-reports.tar.gz"));
    assert.equal(xmls.length, 3);
    const { tests, counts, files } = junitOutcomes(xmls);
    assert.equal(files, 3);
    // 6 + 12 cases from the real reports, all passing; 6 from LockTest.
    assert.deepEqual(counts, { passed: 20, failed: 1, errored: 2, skipped: 1 });

    assert.deepEqual(tests.LockTest, {
      f: ["getAndLockTimeoutHasRetryReasonLocked"],
      // A parameterised test that passed once and errored once is, like in the log, errored.
      e: ["upsertLocked(API)"],
      s: ["needsServer8"],
      p: ["plain"],
    });
    assert.deepEqual(tests.DisconnectTest, { classError: true });
    assert.equal(tests.ExtBinarySupportBasicTest.p?.length, 6, "passes are named, not just counted");
  });
}

/** A tar archive built by hand: `entries` are [header name, type, data]. */
function tarGz(entries: [string, string, string][]): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, type, data] of entries) {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0, "utf8");
    h.write(Buffer.byteLength(data).toString(8).padStart(11, "0") + "\0", 124, "utf8");
    h.write(type, 156, "utf8");
    const body = Buffer.alloc(Math.ceil(Buffer.byteLength(data) / 512) * 512);
    body.write(data, 0, "utf8");
    blocks.push(h, body);
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

test("tar entries with names over 100 bytes are read, in both GNU and pax form", async () => {
  const long = `./TEST-com.couchbase.client.kv.zone_aware_replica.${"VeryLong".repeat(10)}Test.xml`;
  const suite = (n: string) => `<testsuite><testcase name="${n}" classname="c.X"/></testsuite>`;
  const pax = (path: string) => {
    const rec = ` path=${path}\n`;
    let len = rec.length + 2;
    len = rec.length + String(len).length;
    return `${len}${rec}`;
  };
  const xmls = await junitXmlFromTarGz(tarGz([
    ["./././@LongLink", "L", `${long}\0`],
    [long.slice(0, 100), "0", suite("gnu")],
    ["./PaxHeaders/x", "x", pax(long.replace("Test.xml", "Pax.xml").replace("TEST-", "TEST-p"))],
    [long.slice(0, 100), "0", suite("pax")],
    ["./TEST-short.xml", "0", suite("short")],
    ["./notes.txt", "0", "not a report"],
  ]));
  assert.deepEqual(xmls.map((x) => /name="(\w+)"/.exec(x)![1]), ["gnu", "pax", "short"]);
});

test("captured test output is dropped as it streams, even when a section spans chunks", () => {
  const xml = `<testsuite><testcase name="a" classname="c.X"><system-out>${"x".repeat(5000)}<failure/> not real</system-out></testcase><testcase name="b" classname="c.X"><system-err/><error/></testcase></testsuite>`;
  for (const size of [1, 7, 64, 100_000]) {
    const s = new StreamSectionStripper();
    for (let i = 0; i < xml.length; i += size) s.push(xml.slice(i, i + size));
    const out = s.finish();
    assert.equal(out, `<testsuite><testcase name="a" classname="c.X"></testcase><testcase name="b" classname="c.X"><error/></testcase></testsuite>`, `chunk size ${size}`);
    // The <failure/> that was only text inside captured output must not count.
    assert.deepEqual(junitOutcomes([out]).tests.X, { p: ["a"], e: ["b"] });
  }
});

test("XML entities are decoded exactly once, never twice", () => {
  assert.equal(decodeXmlEntities("a &amp; b &lt;T&gt; &quot;x&quot; &apos;y&apos;"), `a & b <T> "x" 'y'`);
  assert.equal(decodeXmlEntities("&#65;&#x42;"), "AB");
  // An escaped entity stays an entity: these must not become "<".
  assert.equal(decodeXmlEntities("&amp;lt;"), "&lt;");
  assert.equal(decodeXmlEntities("&#38;lt;"), "&lt;");
  assert.equal(decodeXmlEntities("&bogus; & plain"), "&bogus; & plain");
});

test("a tarball with no JUnit results is refused, never turned into a clean record", async () => {
  const { upgradeRecord } = await import("../archive-junit.js");
  const { RUN_RECORD_SCHEMA } = await import("../../record/run-record.js");
  const scraped = {
    schema: RUN_RECORD_SCHEMA, source: "run-log-scrape" as const, sdk: "dotnet", preset: "op-onprem-func-lite", kind: "functional" as const,
    cluster: "8.5-stable", params: {}, date: "2026-09-30", ci: { repo: "r", runId: 1, runAttempt: 1 }, outcome: "tests_failed" as const,
    counts: { passed: 10, failed: 1, errored: 0, skipped: 0 }, passesKnown: false, tests: { A: { f: ["x"] } },
  };
  for (const entries of [[["./notes.txt", "0", "not a report"]], [["./TEST-empty.xml", "0", "<testsuite></testsuite>"]]] as [string, string, string][][]) {
    const r = await upgradeRecord(scraped, tarGz(entries), "s3://fit-cli/runs/x.zip", "a/surefire-reports.tar.gz");
    assert.ok("reason" in r && /holds no JUnit results/.test(r.reason), JSON.stringify(r));
  }
  const ok = await upgradeRecord(scraped, tarGz([["./TEST-a.xml", "0", `<testsuite><testcase name="x" classname="c.A"><failure/></testcase></testsuite>`]]), "s3://fit-cli/runs/x.zip", "a/surefire-reports.tar.gz");
  assert.ok(!("reason" in ok) && ok.source === "run-archive-junit");
});

test("a nameless test case is a class-level error only when it failed or errored", () => {
  const xml = `<testsuite>
    <testcase name="" classname="com.x.StandardQueryNegativeTest$DCLTests"><skipped/></testcase>
    <testcase name="" classname="com.x.SetupBrokeTest"><error message="beforeAll"/></testcase>
    <testcase name="ok" classname="com.x.StandardQueryNegativeTest"/>
  </testsuite>`;
  const o = junitOutcomes([xml]);
  assert.equal(o.tests["StandardQueryNegativeTest$DCLTests"], undefined, "a skipped nested class isn't an error");
  assert.deepEqual(o.tests.SetupBrokeTest, { classError: true });
  assert.deepEqual(o.counts, { passed: 1, failed: 0, errored: 1, skipped: 1 }, "still counted, as the results table counts it");
});
