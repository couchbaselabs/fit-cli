import assert from "node:assert/strict";
import { test } from "node:test";
import { otelExternalService } from "../otel-external-service.js";
import type { OtelStackHandle } from "../start/start-otel-stack.js";

function fakeHandle(): OtelStackHandle {
  const container = (name: string) => ({ containerId: name, logFile: `/tmp/${name}.log`, logStream: { drain: async () => {} } as never });
  return {
    service: "otel",
    collector: container("collector"),
    jaeger: container("jaeger"),
    prometheus: container("prometheus"),
    endpoints: {
      collector: { otlpGrpc: "http://host.docker.internal:4317", otlpHttp: "http://host.docker.internal:4318" },
      jaeger: { queryGrpc: "localhost:16685" },
      prometheus: { baseUrl: "http://localhost:9090" },
    },
    artifacts: [],
    details: [],
  };
}

test("otelExternalService.configPiece emits the openTelemetry block, not otel", () => {
  const piece = otelExternalService.configPiece(fakeHandle()) as Record<string, unknown>;
  const openTelemetry = piece.openTelemetry as Record<string, unknown>;
  assert.deepEqual(openTelemetry.collector, { otlpGrpc: "http://host.docker.internal:4317", otlpHttp: "http://host.docker.internal:4318" });
  assert.deepEqual(openTelemetry.jaeger, { queryGrpc: "localhost:16685" });
  assert.deepEqual(openTelemetry.prometheus, { baseUrl: "http://localhost:9090" });
  assert.equal("otel" in piece, false);
});

test("otelExternalService.describeLeaveUp names the Jaeger and Prometheus UIs", () => {
  const lines = otelExternalService.describeLeaveUp(fakeHandle());
  assert.ok(lines.some((l) => l.includes("Jaeger UI")));
  assert.ok(lines.some((l) => l.includes("Prometheus UI") && l.includes("http://localhost:9090")));
});

test("otelExternalService.name matches the registry key", () => {
  assert.equal(otelExternalService.name, "otel");
});
