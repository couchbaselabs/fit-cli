/**
 * Step: turn a results database + cbdino settings into a situational
 * FITConfiguration.json — build the config and write it to a fresh per-iteration
 * file for passing to test-driver via `-Dfit.config`.
 *
 * The situational counterpart to generate-fit-configuration.ts. The config
 * itself is built by build-situational-configuration.ts (pure); this step does
 * the IO and masks the secret results-DB password in the echoed output.
 *
 * Run on its own (prints where a config would be written):
 *   bun src/fit/situational/configuration/generate-situational-configuration.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { type RunOutput } from "../../../util/non-fit/artifacts.js";
import { type PieceData } from "../../../util/non-fit/config-pieces.js";
import { printFileContent } from "../../../util/non-fit/fit-cli-log.js";
import type { DefinitionRunPath } from "../../../util/non-fit/replay.js";
import { DEFAULT_PERFORMER_PORT } from "../../performers/util/performer-port.js";
import {
  buildSituationalConfiguration,
  DEFAULT_CBDINO_SETTINGS,
  type CbdinoSettings,
} from "./build-situational-configuration.js";
import { fitConfigDocPath, writeFitConfiguration } from "../../shared/fit-configuration/write-fit-configuration.js";

/** Build and write a situational FITConfiguration.json to the run directory. */
export function generateSituationalConfiguration(
  cbdino: CbdinoSettings = DEFAULT_CBDINO_SETTINGS,
  fitPerformerDir: string,
  path: DefinitionRunPath,
  performerPort: number = DEFAULT_PERFORMER_PORT,
  fitConfigPiece?: PieceData,
  capellaEnvironment: string = "dev",
): RunOutput & { path: string } {
  const config = buildSituationalConfiguration(cbdino, performerPort, fitConfigPiece, capellaEnvironment);

  console.log(
    `\nGenerating a situational FITConfiguration.json for you. You can also produce this by hand by ` +
      `following ${fitConfigDocPath(fitPerformerDir)} and the situational notes in SITUATIONAL_TESTING.md.`,
  );
  const result = writeFitConfiguration(config, path);
  console.log(`\nWriting ${result.path}:\n`);
  printFileContent(JSON.stringify(config, null, 2));
  console.log(`\n✓ Wrote ${result.path}`);

  return { path: result.path, artifacts: [result.artifact], details: [] };
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const sample = buildSituationalConfiguration();
    console.log(JSON.stringify(sample, null, 2));
    return Promise.resolve();
  });
}
