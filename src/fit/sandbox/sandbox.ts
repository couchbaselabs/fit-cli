#!/usr/bin/env node
/**
 * fit sandbox — manage Capella sandbox control planes.
 *
 *   fit sandbox deploy [--auto]
 *
 * deploy: asks for the inputs of couchbase-cloud's sandbox/deploy-control-plane
 *         GitHub Actions workflow, dispatches it, waits, and prints its summaries
 *         (or the failed jobs' errors).
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import type { RunOutput } from "../../util/non-fit/artifacts.js";
import { applyDeployAutoFlag, runSandboxDeployMain, withoutPromptSessionFlags } from "./deploy/deploy-sandbox.js";

function helpText(): string {
  return `Manage Capella sandbox control planes.

Usage:
  ${runScriptPrefix("sandbox")} deploy [--auto]
  ${runScriptPrefix("sandbox")} --help

Subcommands:
  deploy    Deploy a sandbox control plane through couchbase-cloud's GitHub Actions
            workflow, wait for it, and print its summaries.
            Run "${runScriptPrefix("sandbox")} deploy --help" for details.`;
}

export function runSandboxMain(): void {
  const [subcommand, ...rest] = withoutPromptSessionFlags(process.argv.slice(2));
  if (subcommand === "deploy") applyDeployAutoFlag(rest);

  runCli(async (): Promise<void | Partial<RunOutput>> => {
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      console.log(helpText());
      if (!subcommand) process.exit(2);
      return;
    }

    if (subcommand === "deploy") {
      return (await runSandboxDeployMain(rest)) ?? undefined;
    }

    console.error(`Unknown subcommand: ${subcommand}\n`);
    console.error(helpText());
    process.exit(2);
  });
}

if (isMain(import.meta.url)) {
  runSandboxMain();
}
