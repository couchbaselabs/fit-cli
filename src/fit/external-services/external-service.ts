/**
 * external-service — the generic "start once per box, inject its endpoints into
 * FITConfiguration, stop with the box" contract that fit-cli's own infra (currently just
 * otel) implements. See registered-external-services.ts for what's actually registered.
 *
 * Run on its own (prints a worked example merging two fake services' config pieces):
 *   bun src/fit/external-services/external-service.ts
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import type { Artifact, Detail, RunOutput } from "../../util/non-fit/artifacts.js";
import type { PieceData, PieceValue } from "../../util/non-fit/config-pieces.js";
import type { FitExecutionContext } from "../shared/util/remote-fit-run.js";
import type { ExternalServicesDefaults } from "../util/environments.js";

/** A running external service's handle — its RunOutput plus which service produced it. */
export interface ExternalServiceHandle extends RunOutput {
  readonly service: string; // matches ExternalService.name
}

/** A service fit-cli starts once per box (before it's first needed) and stops with the box. */
export interface ExternalService {
  readonly name: string;
  /** @param externalServices the `externalServices` block of environments.json5; a service reads its own slice of it. */
  start(execution: FitExecutionContext, instancePath: string, externalServices: ExternalServicesDefaults): Promise<ExternalServiceHandle>;
  stop(execution: FitExecutionContext, handle: ExternalServiceHandle): Promise<RunOutput>;
  /** This service's own slice of the `externalServices` FITConfiguration block, or undefined if it contributes none. */
  configPiece(handle: ExternalServiceHandle): PieceData | undefined;
  /** Lines to print under this service when everything is left up for debugging. */
  describeLeaveUp(handle: ExternalServiceHandle): string[];
}

export function findExternalService(services: readonly ExternalService[], handle: ExternalServiceHandle): ExternalService {
  const service = services.find((s) => s.name === handle.service);
  if (!service) throw new Error(`No registered external service named "${handle.service}"`);
  return service;
}

/** The `externalServices` FITConfiguration piece: each active handle's own block, merged. */
export function externalServicesConfigPiece(services: readonly ExternalService[], handles: readonly ExternalServiceHandle[]): PieceData {
  const body: Record<string, PieceValue> = {};
  for (const handle of handles) {
    const piece = findExternalService(services, handle).configPiece(handle);
    if (piece) Object.assign(body, piece);
  }
  return Object.keys(body).length > 0
    ? { externalServices: { "//": "Endpoints for fit-cli's per-box ephemeral external services.", ...body } }
    : {};
}

/** Stop every active external service, collecting artifacts/details from all of them. */
export async function stopExternalServices(
  execution: FitExecutionContext | undefined,
  services: readonly ExternalService[],
  handles: readonly ExternalServiceHandle[],
  stopFn: ExternalService["stop"] = (execution, handle) => findExternalService(services, handle).stop(execution, handle),
): Promise<RunOutput> {
  const artifacts: Artifact[] = [];
  const details: Detail[] = [];
  if (execution) {
    for (const handle of handles) {
      const out = await stopFn(execution, handle);
      artifacts.push(...out.artifacts);
      details.push(...out.details);
    }
  }
  return { artifacts, details };
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const fakeService = (name: string): ExternalService => ({
      name,
      start: () => Promise.resolve({ service: name, artifacts: [], details: [] }),
      stop: () => Promise.resolve({ artifacts: [], details: [] }),
      configPiece: () => ({ [name]: { exampleEndpoint: `http://localhost:0/${name}` } }),
      describeLeaveUp: () => [`${name} UI: http://localhost:0/${name}`],
    });
    const services = [fakeService("openTelemetry"), fakeService("someFutureService")];
    const handles = services.map((s) => ({ service: s.name, artifacts: [], details: [] }));
    console.log(JSON.stringify(externalServicesConfigPiece(services, handles), null, 2));
    return Promise.resolve();
  });
}
