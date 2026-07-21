/**
 * Unit tests for otel-config.
 *
 * Run on their own:
 *   bun test
 *   node --import tsx --test src/fit/external-services/otel/util/tests/otel-config.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import YAML from "yaml";
import { collectorConfigYaml, prometheusConfigYaml } from "../otel-config.js";

test("collector config declares both grpc and http OTLP receivers", () => {
  const config = YAML.parse(collectorConfigYaml()) as Record<string, unknown>;
  const receivers = config.receivers as Record<string, unknown>;
  const otlp = receivers.otlp as Record<string, unknown>;
  const protocols = otlp.protocols as Record<string, unknown>;
  assert.ok(protocols.grpc, "grpc receiver must be present (most SDKs use this)");
  assert.ok(protocols.http, "http receiver must be present (some languages have no support for the otlp/grpc exporter, e.g. Ruby, so we include the http receiver as a secondary option)");
});

test("collector config's otlp/jaeger exporter is plaintext and points at the jaeger container", () => {
  const config = YAML.parse(collectorConfigYaml()) as Record<string, unknown>;
  const exporters = config.exporters as Record<string, unknown>;
  const jaegerExporter = exporters["otlp/jaeger"] as Record<string, unknown>;
  assert.equal(jaegerExporter.endpoint, "fit-cli-otel-jaeger:4317");
  assert.deepEqual(jaegerExporter.tls, { insecure: true });
});

test("collector config's prometheus exporter has no namespace or metric-suffix rewriting", () => {
  const config = YAML.parse(collectorConfigYaml()) as Record<string, unknown>;
  const exporters = config.exporters as Record<string, unknown>;
  const prometheusExporter = exporters.prometheus as Record<string, unknown>;
  assert.equal(prometheusExporter.namespace, undefined);
  assert.equal(prometheusExporter.add_metric_suffixes, undefined);
});

test("collector config lists health_check under service.extensions", () => {
  const config = YAML.parse(collectorConfigYaml()) as Record<string, unknown>;
  const extensions = config.extensions as Record<string, unknown>;
  assert.ok(extensions.health_check, "health_check extension must be defined");
  const service = config.service as Record<string, unknown>;
  assert.ok(
    (service.extensions as string[]).includes("health_check"),
    "defining health_check is not enough — it must also be listed under service.extensions or the health gate hangs",
  );
});

test("collector config has no file exporter on either pipeline", () => {
  // Asserted explicitly, with this comment, because "test asserts a thing is
  // absent" otherwise looks like a stale assertion someone could reasonably
  // delete. Both absences are deliberate, for different reasons:
  //
  // file/metrics is a hard no. The driver exports metrics every 20ms
  // (OtelUtil.setExportEveryMillis), which wrote ~20MB/min — enough disk
  // I/O on Docker Desktop's virtualized filesystem to starve every other container
  // sharing the VM, surfacing as an unrelated-looking socket timeout in the driver
  // polling Prometheus.
  //
  // file/traces would be low volume enough, but it needs a writable mount into a
  // distroless image and fails the collector's *startup* if it can't open its file
  // — turning a dump feature into a way for any functional run to die.
  //
  // Neither is needed: both signals are dumped by snapshotting the backing stores
  // at teardown instead (Jaeger's badger store, Prometheus' TSDB).
  const config = YAML.parse(collectorConfigYaml()) as Record<string, unknown>;
  const service = config.service as Record<string, unknown>;
  const pipelines = service.pipelines as Record<string, { exporters: string[] }>;
  const exporters = config.exporters as Record<string, unknown>;

  assert.ok(pipelines.traces.exporters.includes("otlp/jaeger"));
  assert.ok(pipelines.metrics.exporters.includes("prometheus"));
  for (const name of Object.keys(exporters)) {
    assert.equal(name.startsWith("file"), false, `${name} is a file exporter — see this test's comment`);
  }
  for (const pipeline of Object.values(pipelines)) {
    assert.equal(
      pipeline.exporters.some((exporter) => exporter.startsWith("file")),
      false,
    );
  }
});

test("prometheus config never sets honor_labels true", () => {
  // honor_labels=false (the default, so either
  // absent or explicitly false is fine) is what renames the collector's colliding
  // `instance` label to `exported_instance`, the label every FIT metrics test
  // query filters on. Setting it true silently breaks all of them.
  const config = YAML.parse(prometheusConfigYaml()) as Record<string, unknown>;
  const scrapeConfigs = config.scrape_configs as Array<Record<string, unknown>>;
  assert.notEqual(scrapeConfigs[0].honor_labels, true);
});

test("prometheus config scrapes exactly the collector's prometheus exporter, on a fixed interval", () => {
  const config = YAML.parse(prometheusConfigYaml()) as Record<string, unknown>;
  const scrapeConfigs = config.scrape_configs as Array<Record<string, unknown>>;
  assert.equal(scrapeConfigs.length, 1, "a second scrape target would pollute the metrics dump");
  const staticConfigs = scrapeConfigs[0].static_configs as Array<Record<string, unknown>>;
  assert.deepEqual(staticConfigs[0].targets, ["fit-cli-otel-collector:8889"]);
  // Per-job rather than under `global:` — either satisfies Prometheus, but one of
  // the two has to be set or the scrape interval defaults to a minute, which is
  // far too coarse for tests that assert on a metric within seconds.
  assert.ok(
    scrapeConfigs[0].scrape_interval ?? (config.global as Record<string, unknown> | undefined)?.scrape_interval,
    "a scrape_interval must be configured, per-job or globally",
  );
});
