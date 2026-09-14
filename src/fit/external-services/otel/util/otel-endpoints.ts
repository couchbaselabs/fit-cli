/**
 * The endpoints fit-cli's ephemeral otel stack exposes,
 * shaped for injection into FITConfiguration.json's `externalServices.openTelemetry`
 * (see otel-external-service.ts's configPiece, which consumes this).
 *
 * Run on its own (prints the resolved endpoints):
 *   bun src/fit/external-services/otel/util/otel-endpoints.ts
 */
import { isMain, runCli } from "../../../../util/non-fit/cli.js";
import { OTEL_PORTS } from "./otel-topology.js";

/**
 * Matches transactions-fit-performer's `externalServices.openTelemetry` schema
 * exactly (FITConfigRaw.scala's OpenTelemetryRaw): every field is a required
 * string once this object is present at all — there's no optional subset.
 */
export interface OtelEndpoints {
  collector: { otlpGrpc: string; otlpHttp: string };
  jaeger: { queryGrpc: string };
  prometheus: { baseUrl: string };
}

/**
 * The stack's endpoints as fit-cli always emits them: the collector is
 * performer-relative (the performer is itself a container, so it dials the
 * collector via host.docker.internal), and Jaeger/Prometheus are
 * driver-relative (the test-driver is a host process on the same box, so
 * plain localhost is correct). `http://`, not `https://`, on the collector
 * URLs — that scheme is the only signal SDKs use to pick plaintext over TLS.
 * `jaeger.queryGrpc` deliberately carries no scheme — it's passed verbatim
 * into a gRPC ManagedChannelBuilder.forTarget().
 */
export function otelEndpoints(): OtelEndpoints {
  return {
    collector: {
      otlpGrpc: `http://host.docker.internal:${OTEL_PORTS.otlpGrpc}`,
      otlpHttp: `http://host.docker.internal:${OTEL_PORTS.otlpHttp}`,
    },
    jaeger: { queryGrpc: `localhost:${OTEL_PORTS.jaegerQueryGrpc}` },
    prometheus: { baseUrl: `http://localhost:${OTEL_PORTS.prometheus}` },
  };
}

if (isMain(import.meta.url)) {
  runCli(() => {
    console.log(JSON.stringify(otelEndpoints(), null, 2));
    return Promise.resolve();
  });
}
