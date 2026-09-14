/**
 * The registration glue between fit-cli's generic ExternalService contract and the
 * otel stack's own start/stop functions. The only file that knows both "otel" and
 * "ExternalService" — everything else in this directory is otel-only, and
 * run-from-definition.ts only ever deals in the generic types.
 *
 * `configPiece` still emits the FITConfiguration key `openTelemetry`, not `otel` —
 * that's the driver's actual contract (transactions-fit-performer's FITConfigRaw),
 * unrelated to fit-cli's own internal naming.
 */
import type { ExternalService } from "../external-service.js";
import type { PieceData } from "../../../util/non-fit/config-pieces.js";
import { startOtelStack, type OtelStackHandle } from "./start/start-otel-stack.js";
import { stopOtelStack } from "./stop/stop-otel-stack.js";
import { OTEL_PORTS } from "./util/otel-topology.js";

function configPiece(handle: OtelStackHandle): PieceData {
  const { endpoints } = handle;
  return {
    openTelemetry: {
      collector: { otlpGrpc: endpoints.collector.otlpGrpc, otlpHttp: endpoints.collector.otlpHttp },
      jaeger: { queryGrpc: endpoints.jaeger.queryGrpc },
      prometheus: { baseUrl: endpoints.prometheus.baseUrl },
    },
  };
}

function describeLeaveUp(handle: OtelStackHandle): string[] {
  return [`Jaeger UI:      http://localhost:${OTEL_PORTS.jaegerUi}`, `Prometheus UI:  ${handle.endpoints.prometheus.baseUrl}`];
}

export const otelExternalService: ExternalService = {
  name: "otel",
  start: (execution, instancePath, externalServices) => startOtelStack(execution, instancePath, externalServices.otel),
  stop: (execution, handle) => stopOtelStack(execution, handle as OtelStackHandle),
  configPiece: (handle) => configPiece(handle as OtelStackHandle),
  describeLeaveUp: (handle) => describeLeaveUp(handle as OtelStackHandle),
};
