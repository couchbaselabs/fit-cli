/**
 * Unit tests for `fit health check`, on a real stored night.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/backfill/tests/checks.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { MANIFEST_SCHEMA, rawLogKey } from "../../record/run-manifest.js";
import { recordKey } from "../../record/run-record.js";
import { buildRecords, parseRunLog } from "../../log-parse/parse-run-log.js";
import { LocalHealthStore } from "../../store/health-store.js";
import { checkStore } from "../checks.js";

const LOG = join(import.meta.dirname, "../../log-parse/tests/fixtures/dotnet-2026-09-27.txt");

test("a JUnit record the log parser no longer finds fails the check instead of being skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "fit-health-test-"));
  try {
    const store = new LocalHealthStore(root);
    const text = readFileSync(LOG, "utf8");
    const ci = { repo: "r", runId: 1, runAttempt: 1 };
    const [scraped] = buildRecords(parseRunLog(text), { sdk: "dotnet", date: "2026-09-27", ci }).records;
    // A JUnit record for a preset the log doesn't contain - as if the parser had lost it.
    const lost = { ...scraped, source: "run-archive-junit" as const, preset: "op-lost-func-lite" };
    store.write(rawLogKey("dotnet", 1, 1), gzipSync(text));
    const key = store.writeRecord(lost);
    store.writeManifest({
      schema: MANIFEST_SCHEMA, sdk: "dotnet", runId: 1, runAttempt: 1, date: "2026-09-27", ci, status: "ok",
      records: [recordKey(scraped)], archive: { status: "ok", upgraded: [key], skipped: [], attempts: 1 },
    });
    const c = checkStore(store, "dotnet");
    assert.equal(c.agreement.length, 0);
    assert.deepEqual(c.unmatched, [`2026-09-27 op-lost-func-lite functional @${scraped.cluster}`]);
    assert.equal(c.pass, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
