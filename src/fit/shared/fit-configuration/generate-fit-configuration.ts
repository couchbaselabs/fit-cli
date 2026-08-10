/**
 * Step: turn a selected cluster into a FITConfiguration.json — build the config
 * and write it to a fresh file for passing to test-driver via `-Dfit.config`.
 *
 * Cluster selection itself lives in the reusable src/workflows/cluster-select
 * workflow; this step only deals with FIT configuration.
 *
 * Run on its own (this picks a cluster via the cluster-select workflow, then
 * generates its config):
 *   bun src/fit/shared/fit-configuration/generate-fit-configuration.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { type RunOutput } from "../../../util/non-fit/artifacts.js";
import { resolveFitPerformerDir } from "../../util/config.js";
import { selectOrCreateCluster } from "../../../cluster/cluster-select-or-create/cluster-select-or-create.js";
import { type SelectedCluster } from "../../../cluster/cluster-select/cluster-select.js";
import { DEFAULT_PERFORMER_PORT } from "../../performers/util/performer-port.js";
import { buildFitConfiguration } from "../../functional/util/build-fit-configuration.js";
import type { DefinitionRunPath } from "../../../util/non-fit/replay.js";
import type { ResolvedFitConfig } from "../../shared/definition/types.js";
import {
  fitConfigDocPath,
  writeFitConfiguration,
} from "./write-fit-configuration.js";

/**
 * Build and write a FITConfiguration.json for an already-selected cluster.
 * `performerPort` is the host port the performer listens on (goes into
 * `performerPorts`); it defaults to {@link DEFAULT_PERFORMER_PORT}. When
 * `fitConfig` is provided, its `config` piece is merged in before fit-cli
 * overlays the runtime-generated fields, and its `patch` piece is merged in
 * last (highest priority) but NOT logged to the console.
 */
export function generateFitConfiguration(
  cluster: SelectedCluster,
  fitPerformerDir: string,
  path: DefinitionRunPath,
  performerPort: number = DEFAULT_PERFORMER_PORT,
  fitConfig?: ResolvedFitConfig,
  analytics = false,
  isLocal = false,
): RunOutput & {
  path: string;
} {
  // Build without patch first so only the non-sensitive parts are logged.
  const configForLog = buildFitConfiguration(cluster, performerPort, fitConfig?.config, fitConfig?.connection, undefined, analytics, isLocal);
  const config = fitConfig?.patch
    ? buildFitConfiguration(cluster, performerPort, fitConfig.config, fitConfig.connection, fitConfig.patch, analytics, isLocal)
    : configForLog;

  console.log(
    `\nGenerating a FITConfiguration.json for you. You can also produce this by hand by ` +
      `following ${fitConfigDocPath(fitPerformerDir)}.`,
  );
  const result = writeFitConfiguration(config, path);

  console.log(`\nWriting ${result.path}:\n`);
  console.log(JSON.stringify(configForLog, null, 2));
  if (fitConfig?.patch) {
    console.log(`  (patch fields omitted from display)`);
  }

  console.log(`\n✓ Wrote ${result.path}`);
  return { path: result.path, artifacts: [result.artifact], details: [] };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const fitPerformerDir = resolveFitPerformerDir() ?? "";
    // Select an existing cluster or create a fresh one; a created Capella cluster
    // is classified from its connection string so the FITConfig gets the Capella
    // treatment automatically.
    const outcome = await selectOrCreateCluster();
    if (!outcome.ready) {
      process.exit(1);
    }
    return generateFitConfiguration(outcome.cluster, fitPerformerDir, { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0, runIndex: 0 });
  });
}
