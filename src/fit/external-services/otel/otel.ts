#!/usr/bin/env node
/**
 * fit external-services otel — start or stop fit-cli's ephemeral local otel
 * stack (an OpenTelemetry collector + Jaeger + Prometheus) on this machine,
 * for manual testing.
 *
 *   fit external-services otel start
 *   fit external-services otel stop
 *
 * A functional `fit run` already starts and stops this stack automatically,
 * once per box — use this only to poke at it on its own, independent of a run.
 */
import { type RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../../util/non-fit/fit-cli-log.js";
import { instanceRunDir } from "../../../util/non-fit/replay.js";
import { createLocalFitExecutionContext } from "../../shared/util/remote-fit-run.js";
import { loadEnvironments } from "../../util/environments.js";
import { findRunningOtelStack, removeOtelStackRemnants, startOtelStack } from "./start/start-otel-stack.js";
import { stopOtelStack } from "./stop/stop-otel-stack.js";
import { replayOtelData, stopReplayStack } from "./replay/replay-otel-data.js";
import { OTEL_PORTS } from "./util/otel-topology.js";

function helpText(): string {
  const p = runScriptPrefix("external-services otel");
  return `Start or stop fit-cli's ephemeral local otel stack (collector + Jaeger + Prometheus),
or replay a finished run's traces and metrics into a fresh one.

Usage:
  ${p} start
  ${p} stop
  ${p} replay <dump-dir>
  ${p} replay --stop
  ${p} --help

A functional \`fit run\` already starts and stops this stack automatically, once
per box. Use start/stop only to poke at it on its own, independent of a run — e.g.
to point a hand-run performer or test-driver at it.

Because the stack is torn down with the run, every run dumps its traces and
metrics into <run>/instances/<n>/otel. \`replay\` starts a throwaway
stack over those dumps, on its own ports, so a failing otel test can
still be inspected in the Jaeger and Prometheus UIs afterwards:

  ${p} replay /tmp/fit-cli/<run>/instances/0/otel`;
}

async function cmdStart(): Promise<RunOutput> {
  const execution = createLocalFitExecutionContext();
  const instanceDir = instanceRunDir({ instanceIndex: 0 });
  const stack = await startOtelStack(execution, instanceDir, loadEnvironments().externalServices.otel);

  console.log(`\n✓ Otel stack is up:`);
  console.log(`  Collector OTLP gRPC: ${stack.endpoints.collector.otlpGrpc}`);
  console.log(`  Collector OTLP HTTP: ${stack.endpoints.collector.otlpHttp}`);
  console.log(`  Jaeger query gRPC:   ${stack.endpoints.jaeger.queryGrpc}`);
  console.log(`  Jaeger UI:           http://localhost:${OTEL_PORTS.jaegerUi}`);
  console.log(`  Prometheus:          ${stack.endpoints.prometheus.baseUrl}`);
  console.log(`\nIt keeps running after this command exits. Stop it with:\n  ${runScriptPrefix("external-services otel")} stop`);

  return { artifacts: stack.artifacts, details: stack.details };
}

async function cmdStop(): Promise<RunOutput> {
  const execution = createLocalFitExecutionContext();
  const instanceDir = instanceRunDir({ instanceIndex: 0 });
  const stack = await findRunningOtelStack(execution, instanceDir);

  if (!stack) {
    // findRunningOtelStack is all-or-nothing, so a partial set — one container removed
    // by hand, or crashed and pruned — lands here. Walking away would leave the rest of
    // the containers, the network and the volume on the box, which is the opposite of
    // what `stop` was asked to do. No dump: a partial stack has none worth taking.
    const remnants = await removeOtelStackRemnants(execution);
    if (remnants.length > 0) {
      console.log(`Cleaned up a partial otel stack (${remnants.join(", ")}). Too little of it was left to dump.`);
    } else {
      console.log("No otel stack is currently running (looked for fit-cli-otel-collector/-jaeger/-prometheus).");
    }
    return { artifacts: [], details: [] };
  }

  return await stopOtelStack(execution, stack);
}

async function cmdReplay(args: string[]): Promise<RunOutput> {
  const execution = createLocalFitExecutionContext();
  if (args.includes("--stop")) {
    return await stopReplayStack(execution);
  }
  const dumpDir = args.find((arg) => !arg.startsWith("-"));
  if (!dumpDir) {
    console.error(`A dump directory is required, e.g.\n  ${runScriptPrefix("external-services otel")} replay /tmp/fit-cli/<run>/instances/0/otel\n`);
    console.error(helpText());
    process.exit(2);
  }
  return await replayOtelData(execution, dumpDir, loadEnvironments().externalServices.otel);
}

export function runOtelMain(): void {
  const [subcommand] = process.argv.slice(2);

  runCli(async () => {
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      console.log(helpText());
      if (!subcommand) process.exit(2);
      return;
    }

    if (subcommand === "start") {
      return await cmdStart();
    }

    if (subcommand === "stop") {
      return await cmdStop();
    }

    if (subcommand === "replay") {
      return await cmdReplay(process.argv.slice(3));
    }

    console.error(`Unknown subcommand: ${subcommand}\n`);
    console.error(helpText());
    process.exit(2);
  });
}

if (isMain(import.meta.url)) {
  runOtelMain();
}
