import assert from "node:assert/strict";
import { test } from "node:test";
import { externalServicesConfigPiece, findExternalService, type ExternalService, type ExternalServiceHandle } from "../external-service.js";

function fakeService(name: string, configPiece: ExternalService["configPiece"] = () => ({ [name]: { exampleEndpoint: `http://localhost:0/${name}` } })): ExternalService {
  return {
    name,
    start: () => Promise.resolve({ service: name, artifacts: [], details: [] }),
    stop: () => Promise.resolve({ artifacts: [], details: [] }),
    configPiece,
    describeLeaveUp: () => [`${name} UI: http://localhost:0/${name}`],
  };
}

function handleFor(service: ExternalService): ExternalServiceHandle {
  return { service: service.name, artifacts: [], details: [] };
}

test("externalServicesConfigPiece emits every field, with the note on externalServices not the inner block", () => {
  const otel = fakeService("openTelemetry");
  const piece = externalServicesConfigPiece([otel], [handleFor(otel)]);

  const externalServices = piece.externalServices as Record<string, unknown>;
  assert.equal(externalServices["//"], "Endpoints for fit-cli's per-box ephemeral external services.");
  const openTelemetry = externalServices.openTelemetry as Record<string, unknown>;
  assert.equal("//" in openTelemetry, false);
  assert.deepEqual(openTelemetry.exampleEndpoint, "http://localhost:0/openTelemetry");
});

test("externalServicesConfigPiece merges two services' blocks without colliding", () => {
  const otel = fakeService("openTelemetry");
  const other = fakeService("someFutureService");
  const piece = externalServicesConfigPiece([otel, other], [handleFor(otel), handleFor(other)]);

  const externalServices = piece.externalServices as Record<string, unknown>;
  assert.ok(externalServices.openTelemetry);
  assert.ok(externalServices.someFutureService);
});

test("externalServicesConfigPiece returns {} when nothing is active", () => {
  assert.deepEqual(externalServicesConfigPiece([], []), {});
});

test("externalServicesConfigPiece skips a service that contributes no piece", () => {
  const silent = fakeService("silent", () => undefined);
  assert.deepEqual(externalServicesConfigPiece([silent], [handleFor(silent)]), {});
});

test("findExternalService throws on an unregistered service name", () => {
  const otel = fakeService("openTelemetry");
  assert.throws(() => findExternalService([otel], { service: "unknown", artifacts: [], details: [] }), /No registered external service named "unknown"/);
});
