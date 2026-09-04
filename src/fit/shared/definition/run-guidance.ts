/**
 * Shared guidance printed after any definition file is generated, telling the
 * user how to run it locally and how to push it to CI.
 */
import { runDefinitionPrefix } from "../../../util/non-fit/fit-cli-log.js";
import { CAPELLA_SANDBOX_ENV_VAR_GUIDANCE } from "../../util/config.js";

export function definitionRunGuidance(definitionPath: string, targetsSandbox = false): string {
  const prefix = runDefinitionPrefix();
  const sandboxNote = targetsSandbox
    ? `\nThis definition targets a Capella sandbox — set its credentials in your environment before running:\n` +
      `    ${CAPELLA_SANDBOX_ENV_VAR_GUIDANCE}\n`
    : "";
  const ciInstructions =
    `\nTo run on CI via https://github.com/couchbaselabs/fit-cli, either:\n` +
    `\n` +
    `  Option A — upload as a gist:\n` +
    `    GIST_URL=$(gh gist create ${definitionPath} --desc "fit-cli FIT definition")\n` +
    `    echo "Gist: $GIST_URL"\n` +
    `    gh workflow run fit-cli.yaml --repo couchbaselabs/fit-cli --field definitionFile="\${GIST_URL/gist.github.com/gist.githubusercontent.com}/raw"\n` +
    `\n` +
    `  Option B — pass the file contents inline as base64 (no gist needed):\n` +
    `    gh workflow run fit-cli.yaml --repo couchbaselabs/fit-cli \\\n` +
    `      --field definitionBase64="$(base64 -w 0 ${definitionPath})"`;

  return (
    sandboxNote +
    `\nRun it later with:\n` +
    `  ${prefix} --interactive ${definitionPath}\n` +
    `\nOr non-interactively (e.g. on CI), taking the default answer to every prompt:\n` +
    `  ${prefix} ${definitionPath}` +
    ciInstructions
  );
}

export function printDefinitionRunGuidance(definitionPath: string, targetsSandbox = false): void {
  console.log(definitionRunGuidance(definitionPath, targetsSandbox));
}
