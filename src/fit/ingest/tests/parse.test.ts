/**
 * Unit tests for the run directory file parsers.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/ingest/tests/parse.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseBucketsCsv,
  parseEventsCsv,
  parseMetricsCsv,
  parseRunJson5,
  parseScoresJson5,
} from "../parse.js";

const RUN_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// The exact JSON the driver's SituationalRunner.writeRun produces.
const SITUATIONAL_RUN_JSON = JSON.stringify({
  forDatabase: {
    runUuid: RUN_UUID,
    cluster: "7.6-stable",
    privateEndpointsEnabled: false,
    impl: { language: "java", version: "3.7.0" },
    workload: { situational: "CbDinoTest" },
    vars: {},
    debug: { items: [] },
  },
});

test("parses a situational run", () => {
  const run = parseRunJson5(SITUATIONAL_RUN_JSON);
  assert.equal(run.runUuid, RUN_UUID);
  assert.equal(run.kind, "situational");
  assert.equal(run.params.runUuid, undefined);
  assert.equal((run.params.impl as { language: string }).language, "java");
});

test("detects a performance run by its workload shape", () => {
  const run = parseRunJson5(
    JSON.stringify({
      forDatabase: {
        runUuid: RUN_UUID,
        workload: { operations: [], name: "kvGets" },
      },
    }),
  );
  assert.equal(run.kind, "performance");
});

test("lowercases an uppercase uuid", () => {
  const run = parseRunJson5(JSON.stringify({ forDatabase: { runUuid: RUN_UUID.toUpperCase() } }));
  assert.equal(run.runUuid, RUN_UUID);
});

test("rejects missing forDatabase, a bad uuid, and bad json", () => {
  assert.throws(() => parseRunJson5("{}"), /forDatabase/);
  assert.throws(() => parseRunJson5(JSON.stringify({ forDatabase: { runUuid: 123 } })), /runUuid/);
  assert.throws(() => parseRunJson5("{not json"), /unparseable/);
});

test("parses a scored run", () => {
  assert.deepEqual(parseScoresJson5('{"score":90,"reasons":["100 for start","-10 for x"]}'), {
    score: 90,
    reasons: ["100 for start", "-10 for x"],
  });
});

test("turns a missing scores file into an empty object", () => {
  assert.deepEqual(parseScoresJson5(undefined), {});
});

test("throws on garbage scores", () => {
  assert.throws(() => parseScoresJson5("[1,2]"));
  assert.throws(() => parseScoresJson5("{nope"));
});

const BUCKETS_HEADER =
  "timestamp,timeOffsetSecs,total,success,failed,durationMinMicros,durationMaxMicros," +
  "durationAverageMicros,durationP50Micros,durationP95Micros,durationP99Micros,errors";

test("turns an empty errors field into null", () => {
  const rows = parseBucketsCsv(`${BUCKETS_HEADER}\n2026-08-14T12:00:00Z,0,10,10,0,100,900,400,350,800,890,\n`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].errors, null);
  assert.equal(rows[0].total, 10);
  assert.equal(rows[0].timeOffsetSecs, 0);
});

test("parses a quoted errors JSON field", () => {
  const rows = parseBucketsCsv(
    `${BUCKETS_HEADER}\n2026-08-14T12:00:01Z,1,5,4,1,100,900,400,350,800,890,"{""TimeoutException"":1}"\n`,
  );
  assert.equal(rows[0].errors, '{"TimeoutException":1}');
});

test("throws on a non-integer count", () => {
  assert.throws(
    () => parseBucketsCsv(`${BUCKETS_HEADER}\n2026-08-14T12:00:00Z,0,ten,10,0,100,900,400,350,800,890,\n`),
    /not an integer/,
  );
});

test("throws on a bad buckets header", () => {
  assert.throws(() => parseBucketsCsv("a,b\n"), /Unexpected CSV header/);
});

test("keeps the metrics JSON verbatim", () => {
  const rows = parseMetricsCsv(
    'timestamp,timeSinceStartSecs,metrics\n2026-08-14T12:00:00Z,5,"{""threadCount"":12}"\n',
  );
  assert.equal(rows[0].metrics, '{"threadCount":12}');
  assert.equal(rows[0].timeOffsetSecs, 5);
});

test("throws on invalid metrics JSON", () => {
  assert.throws(
    () => parseMetricsCsv("timestamp,timeSinceStartSecs,metrics\n2026-08-14T12:00:00Z,5,{bad\n"),
    /not valid JSON/,
  );
});

test("parses an event with an offset datetime", () => {
  const rows = parseEventsCsv(
    'datetime,json\n2026-08-14T13:00:00+01:00,"{""type"":""situation-starts"",""displayOnGraph"":true}"\n',
  );
  assert.equal(rows[0].datetime, "2026-08-14T13:00:00+01:00");
  assert.equal((JSON.parse(rows[0].params) as { type: string }).type, "situation-starts");
});

test("throws on an invalid event datetime", () => {
  assert.throws(() => parseEventsCsv('datetime,json\nyesterday,"{}"\n'), /invalid timestamp/);
});
