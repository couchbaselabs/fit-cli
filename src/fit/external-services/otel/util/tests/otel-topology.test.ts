/**
 * Unit tests for otel-topology.
 *
 * Run on their own:
 *   bun test
 *   node --import tsx --test src/fit/external-services/otel/util/tests/otel-topology.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OTEL_NETWORK,
  OTEL_BADGER_DIR,
  OTEL_BADGER_VOLUME,
  PROMETHEUS_TSDB_PATH,
  collectorCreateArgs,
  jaegerCreateArgs,
  otelImages,
  prometheusCreateArgs,
} from "../otel-topology.js";

test("otelImages builds the 3 pinned image refs", () => {
  const images = otelImages({
    collectorVersion: "0.135.0",
    jaegerVersion: "1.62.0",
    prometheusVersion: "v2.55.0",
  });
  assert.deepEqual(images, {
    collector: "otel/opentelemetry-collector-contrib:0.135.0",
    jaeger: "jaegertracing/all-in-one:1.62.0",
    prometheus: "prom/prometheus:v2.55.0",
  });
});

test("collectorCreateArgs publishes every port, joins the shared network, and never uses --rm", () => {
  const args = collectorCreateArgs("otel/opentelemetry-collector-contrib:0.135.0");
  assert.deepEqual(args, [
    "create",
    "--name",
    "fit-cli-otel-collector",
    "--network",
    OTEL_NETWORK,
    "--publish",
    "4317:4317",
    "--publish",
    "4318:4318",
    "--publish",
    "13133:13133",
    "--publish",
    "8889:8889",
    "otel/opentelemetry-collector-contrib:0.135.0",
    "--config=/etc/otelcol-contrib/config.yaml",
  ]);
  assert.equal(args.includes("--rm"), false);
});

test("collectorCreateArgs mounts nothing — the collector writes no files of its own", () => {
  // The collector deliberately has no file exporter (see the collector config
  // tests), so it needs no writable mount. Anything appearing here would mean one
  // came back, along with its ability to fail the collector's startup.
  const args = collectorCreateArgs("otel/opentelemetry-collector-contrib:0.135.0");
  assert.equal(args.includes("--volume"), false);
  assert.equal(args.includes("--tmpfs"), false);
});

test("jaegerCreateArgs publishes the query gRPC and UI ports, not the internal OTLP ports", () => {
  const args = jaegerCreateArgs("jaegertracing/all-in-one:1.62.0");
  assert.deepEqual(args, [
    "create",
    "--name",
    "fit-cli-otel-jaeger",
    "--network",
    OTEL_NETWORK,
    "--publish",
    "16685:16685",
    "--publish",
    "16686:16686",
    "--env",
    "COLLECTOR_OTLP_ENABLED=true",
    "--env",
    "SPAN_STORAGE_TYPE=badger",
    "--env",
    "BADGER_EPHEMERAL=false",
    "--env",
    `BADGER_DIRECTORY_KEY=${OTEL_BADGER_DIR}/key`,
    "--env",
    `BADGER_DIRECTORY_VALUE=${OTEL_BADGER_DIR}/data`,
    "--volume",
    `${OTEL_BADGER_VOLUME}:${OTEL_BADGER_DIR}`,
    "jaegertracing/all-in-one:1.62.0",
  ]);
  assert.equal(args.some((arg) => arg.includes("4317")), false);
});

test("jaegerCreateArgs persists its span store, which is what makes traces dumpable at all", () => {
  const args = jaegerCreateArgs("jaegertracing/all-in-one:1.62.0");
  assert.ok(args.includes("SPAN_STORAGE_TYPE=badger"));
  assert.ok(args.includes("BADGER_EPHEMERAL=false"));
  assert.ok(args.includes(`${OTEL_BADGER_VOLUME}:${OTEL_BADGER_DIR}`));
  // A bind mount here would silently mount an empty dir when Docker Desktop's
  // file-sharing list omits /tmp — see OTEL_BADGER_VOLUME.
  assert.equal(
    args.some((arg) => arg.startsWith("/") && arg.includes(`:${OTEL_BADGER_DIR}`)),
    false,
  );
});

test("prometheusCreateArgs publishes 9090 and points at the staged config file", () => {
  const args = prometheusCreateArgs("prom/prometheus:v2.55.0");
  assert.deepEqual(args, [
    "create",
    "--name",
    "fit-cli-otel-prometheus",
    "--network",
    OTEL_NETWORK,
    "--publish",
    "9090:9090",
    "prom/prometheus:v2.55.0",
    "--config.file=/etc/prometheus/prometheus.yml",
    `--storage.tsdb.path=${PROMETHEUS_TSDB_PATH}`,
    "--web.enable-admin-api",
  ]);
});

test("prometheusCreateArgs enables the admin API and pins the TSDB path", () => {
  const args = prometheusCreateArgs("prom/prometheus:v2.55.0");
  assert.ok(args.includes("--web.enable-admin-api"));
  assert.ok(args.includes(`--storage.tsdb.path=${PROMETHEUS_TSDB_PATH}`));
});
