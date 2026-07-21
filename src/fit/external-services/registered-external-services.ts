/**
 * The list of external services fit-cli starts/stops per box. The one seam a
 * future second service gets added through — run-from-definition.ts never names a
 * concrete service, only this array.
 */
import type { ExternalService } from "./external-service.js";
import { otelExternalService } from "./otel/otel-external-service.js";

export const EXTERNAL_SERVICES: readonly ExternalService[] = [otelExternalService];
