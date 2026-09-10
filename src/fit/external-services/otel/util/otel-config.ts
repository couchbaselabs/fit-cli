/**
 * The collector and Prometheus config YAML for fit-cli's ephemeral
 * local otel stack.
 *
 * Run on its own (prints both configs):
 *   bun src/fit/external-services/otel/util/otel-config.ts
 */
import { isMain, runCli } from "../../../../util/non-fit/cli.js";
import { OTEL_CONTAINER_NAMES } from "./otel-topology.js";

export function collectorConfigYaml(): string {
  return `receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    # Balance keeping the tests fast, with having the ones involving larger number of spans work
    timeout: 50ms

exporters:
  # The collector pushes traces to Jaeger
  otlp/jaeger:
    endpoint: ${OTEL_CONTAINER_NAMES.jaeger}:4317
    tls:
      insecure: true
  
  # This is an endpoint exposed by the collector, for Prometheus to scrape
  prometheus:
    endpoint: 0.0.0.0:8889

extensions:
  health_check:
    endpoint: 0.0.0.0:13133

service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/jaeger]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [prometheus]
`;
}

export function prometheusConfigYaml(): string {
  return `scrape_configs:
  - job_name: 'otel-collector'

    scrape_interval: 1s

    static_configs:
      - targets: ["${OTEL_CONTAINER_NAMES.collector}:8889"]
`;
}

if (isMain(import.meta.url)) {
  runCli(() => {
    console.log("# otel-collector-config.yaml\n" + collectorConfigYaml());
    console.log("\n# prometheus.yml\n" + prometheusConfigYaml());
    return Promise.resolve();
  });
}
