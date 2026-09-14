/**
 * Unit tests for otel-dump-format.
 *
 * Run on their own:
 *   bun test
 *   node --import tsx --test src/fit/external-services/otel/util/tests/otel-dump-format.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatSeriesName,
  isInternalMetricName,
  isoFromEpochMicros,
  isoFromEpochSeconds,
  jaegerSearchUrl,
  metricNamesToDump,
  prometheusEndInput,
  prometheusGraphUrl,
  renderMetricIndex,
  renderTraceIndex,
  type JaegerTrace,
  type OtelWindow,
} from "../otel-dump-format.js";

const WINDOW: OtelWindow = { start: "2026-08-13T14:22:00.000Z", end: "2026-08-13T14:24:30.000Z" };

function traceFixture(): JaegerTrace {
  return {
    traceID: "aaaa",
    processes: { p1: { serviceName: "java-fit-performer" } },
    spans: [
      // Deliberately out of order, and within the same millisecond, to pin both
      // the sort and the microsecond retention.
      { traceID: "aaaa", spanID: "s2", operationName: "dispatch_to_server", startTime: 1786000927_123_600, duration: 6_000, processID: "p1" },
      { traceID: "aaaa", spanID: "s1", operationName: "cluster.query", startTime: 1786000927_123_400, duration: 12_400, processID: "p1" },
    ],
  };
}

test("isoFromEpochMicros keeps microsecond resolution rather than rounding to millis", () => {
  // Jaeger's startTime is microseconds and spans routinely start inside the same
  // millisecond. Truncating to millis would show ties where the data has an order,
  // which is the one thing the index exists to resolve.
  assert.equal(isoFromEpochMicros(1786000927_123_456), "2026-08-06T07:22:07.123456Z");
  assert.equal(isoFromEpochMicros(1786000927_000_000), "2026-08-06T07:22:07.000000Z");
});

test("isoFromEpochSeconds renders Prometheus' float seconds as ISO-8601 UTC", () => {
  assert.equal(isoFromEpochSeconds(1786000927), "2026-08-06T07:22:07.000Z");
  assert.equal(isoFromEpochSeconds(1786000927.25), "2026-08-06T07:22:07.250Z");
});

test("renderTraceIndex sorts by start time and resolves the service name per span", () => {
  const lines = renderTraceIndex([traceFixture()])
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));
  assert.equal(lines.length, 2);
  // s1 started 200us before s2 despite being listed second.
  assert.ok(lines[0].includes("cluster.query"), `expected cluster.query first, got: ${lines[0]}`);
  assert.ok(lines[1].includes("dispatch_to_server"));
  assert.ok(lines[0].startsWith("2026-08-06T07:22:07.123400Z"));
  assert.ok(lines[0].includes("java-fit-performer"));
  assert.ok(lines[0].includes("trace=aaaa"));
});

test("renderTraceIndex flags error spans, so a failing test's span can be found by grep", () => {
  const trace = traceFixture();
  trace.spans[0].tags = [{ key: "otel.status_code", value: "ERROR" }];
  const rendered = renderTraceIndex([trace]);
  assert.ok(rendered.includes("ERROR"));
});

test("renderTraceIndex says so explicitly when nothing was recorded", () => {
  // An empty file is indistinguishable from a dump that failed; this is the
  // difference between "no spans" and "the dump broke".
  const rendered = renderTraceIndex([]);
  assert.ok(rendered.includes("no spans were recorded"));
});

test("formatSeriesName sorts labels so the same series always renders identically", () => {
  assert.equal(
    formatSeriesName({ __name__: "db_ops", zeta: "1", alpha: "2" }),
    'db_ops{alpha="2",zeta="1"}',
  );
  assert.equal(formatSeriesName({ __name__: "db_ops" }), "db_ops");
});

test("renderMetricIndex interleaves samples from different series in timestamp order", () => {
  const rendered = renderMetricIndex([
    { metric: { __name__: "db_b" }, values: [[1786000920, "1"], [1786000940, "3"]] },
    { metric: { __name__: "db_a" }, values: [[1786000930, "2"]] },
  ]);
  const lines = rendered.split("\n").filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(
    lines.map((line) => line.split("  ")[1]),
    ["db_b", "db_a", "db_b"],
  );
});

test("metricNamesToDump drops self-monitoring noise but keeps everything a FIT test asserts on", () => {
  const kept = metricNamesToDump([
    "db_couchbase_operations_count",
    "db_client_operation_duration_seconds_bucket",
    "target_info",
    "up",
    "scrape_duration_seconds",
    "prometheus_tsdb_head_series",
    "go_goroutines",
    "otelcol_process_uptime",
  ]);
  assert.deepEqual(kept, ["db_client_operation_duration_seconds_bucket", "db_couchbase_operations_count", "target_info"]);
});

test("isInternalMetricName does not treat a db_ metric as internal just because it mentions a prefix", () => {
  assert.equal(isInternalMetricName("db_couchbase_process_count"), false);
  assert.equal(isInternalMetricName("process_cpu_seconds_total"), true);
});

test("jaegerSearchUrl uses microseconds, which is what Jaeger UI expects (not millis)", () => {
  const url = new URL(jaegerSearchUrl("http://localhost:16686", WINDOW, "java-fit-performer"));
  assert.equal(url.pathname, "/search");
  assert.equal(url.searchParams.get("start"), String(Date.parse(WINDOW.start) * 1000));
  assert.equal(url.searchParams.get("end"), String(Date.parse(WINDOW.end) * 1000));
});

test("jaegerSearchUrl always names a service — Jaeger rejects a search without one", () => {
  // Regression test. Jaeger UI runs a search straight from the URL params, and its
  // /api/traces call answers a serviceless query with
  // `400 parameter 'service' is required` — so the link fails outright even though
  // the time range is valid. Easy to miss by testing the API by hand (where you
  // naturally pass a service) instead of opening the link.
  const url = new URL(jaegerSearchUrl("http://localhost:16686", WINDOW, "java-fit-performer"));
  assert.equal(url.searchParams.get("service"), "java-fit-performer");
});

test("jaegerSearchUrl sets lookback=custom, or the UI ignores the window it was given", () => {
  // Without it the time selector falls back to a relative default and computes its
  // own range from now — so a dump opened the next day shows an empty search, which
  // reads as "the traces didn't survive".
  const url = new URL(jaegerSearchUrl("http://localhost:16686", WINDOW, "java-fit-performer"));
  assert.equal(url.searchParams.get("lookback"), "custom");
});

test("prometheusEndInput renders the space-separated form Prometheus' graph UI parses", () => {
  assert.equal(prometheusEndInput("2026-08-13T14:24:30.000Z"), "2026-08-13 14:24:30");
});

test("prometheusGraphUrl covers the whole run window so a replayed stack doesn't open on an empty hour", () => {
  const url = new URL(prometheusGraphUrl("http://localhost:19090", WINDOW, '{__name__=~"db_.+"}'));
  assert.equal(url.searchParams.get("g0.expr"), '{__name__=~"db_.+"}');
  assert.equal(url.searchParams.get("g0.range_input"), "150s");
  assert.equal(url.searchParams.get("g0.end_input"), "2026-08-13 14:24:30");
});

test("prometheusGraphUrl never emits a sub-minute range, which Prometheus renders unusably narrow", () => {
  const brief: OtelWindow = { start: "2026-08-13T14:22:00.000Z", end: "2026-08-13T14:22:03.000Z" };
  const url = new URL(prometheusGraphUrl("http://localhost:19090", brief, "up"));
  assert.equal(url.searchParams.get("g0.range_input"), "60s");
});
