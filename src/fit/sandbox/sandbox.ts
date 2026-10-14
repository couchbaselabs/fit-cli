#!/usr/bin/env node
/**
 * fit sandbox — manage Capella sandbox control planes.
 *
 *   fit sandbox deploy [--auto] [--gha-ref <branch-or-tag>] [--input <name>=<value>]...
 *   fit sandbox follow <run-id or run URL>
 *
 * deploy: asks for the inputs of couchbase-cloud's sandbox/deploy-control-plane
 *         GitHub Actions workflow, dispatches it, waits, and prints its summaries
 *         (or the failed jobs' errors).
 * follow: waits for a deploy run already dispatched and reports it the same way.
 */
import { isMain } from "../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import {
  deployHelpText,
  followHelpText,
  runSandboxDeployMain,
  runSandboxFollowMain,
  withoutPromptSessionFlags,
} from "./deploy/deploy-sandbox.js";

const SUBCOMMANDS: Readonly<Record<string, { help: () => string; main: (argv: string[]) => void }>> = {
  deploy: { help: deployHelpText, main: runSandboxDeployMain },
  follow: { help: followHelpText, main: runSandboxFollowMain },
};

function helpText(): string {
  return `Manage Capella sandbox control planes.

Usage:
  ${runScriptPrefix("sandbox")} deploy [--auto] [--gha-ref <branch-or-tag>] [--input <name>=<value>]...
  ${runScriptPrefix("sandbox")} follow <run-id or run URL>
  ${runScriptPrefix("sandbox")} --help

Subcommands:
  deploy    Deploy a sandbox control plane through couchbase-cloud's GitHub Actions
            workflow, wait for it, and print its summaries.
            Run "${runScriptPrefix("sandbox")} deploy --help" for details.
  follow    Pick a deploy run up again (e.g. after Ctrl-C) and report it, without deploying.`;
}

export function runSandboxMain(): void {
  const [subcommand, ...rest] = withoutPromptSessionFlags(process.argv.slice(2));
  const command = subcommand && Object.hasOwn(SUBCOMMANDS, subcommand) ? SUBCOMMANDS[subcommand] : undefined;
  if (!command) {
    const help = subcommand === "--help" || subcommand === "-h" || subcommand === "help";
    if (subcommand && !help) console.error(`Unknown subcommand: ${subcommand}\n`);
    (help ? console.log : console.error)(helpText());
    process.exit(help ? 0 : 2);
  }
  if (rest.includes("--help") || rest.includes("-h")) console.log(command.help());
  else command.main(rest);
}

if (isMain(import.meta.url)) {
  runSandboxMain();
}
