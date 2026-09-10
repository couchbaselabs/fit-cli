/**
 * fit external-services — manage fit-cli's per-box ephemeral external services
 * (currently just otel: an OpenTelemetry collector + Jaeger + Prometheus).
 *
 *   fit external-services otel start
 *   fit external-services otel --help   (each service defines its own subcommands)
 *
 * A functional `fit run` already starts and stops these automatically, once per
 * box — use this only to poke at one on its own, independent of a run.
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import { runOtelMain } from "./otel/otel.js";

const SERVICE_CLIS: Record<string, () => void> = {
  otel: runOtelMain,
};

function helpText(): string {
  const p = runScriptPrefix("external-services");
  return `Manage fit-cli's per-box ephemeral external services.

Usage:
  ${p} <service> <subcommand> [...args]   (see "${p} <service> --help" for that service's own subcommands)
  ${p} --help

Registered services: ${Object.keys(SERVICE_CLIS).join(", ")}`;
}

export function runExternalServicesMain(): void {
  const service = process.argv[2];
  if (!service || service === "--help" || service === "-h") {
    runCli(() => {
      console.log(helpText());
      if (!service) process.exit(2);
      return Promise.resolve();
    });
    return;
  }
  const cli = SERVICE_CLIS[service];
  if (!cli) {
    console.error(`Unknown external service: ${service}\n`);
    console.error(helpText());
    process.exit(2);
  }
  process.argv.splice(2, 1); // argv[2] is that service's own subcommand — each service's CLI parses its own shape
  cli();
}

if (isMain(import.meta.url)) {
  runExternalServicesMain();
}
