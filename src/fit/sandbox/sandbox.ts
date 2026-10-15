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
import {
  commandArgs,
  DEPLOY_SUMMARY,
  deployUsage,
  FOLLOW_SUMMARY,
  followUsage,
  runSandboxDeployMain,
  runSandboxFollowMain,
  sandboxCommand,
} from "./deploy/deploy-sandbox.js";

const SUBCOMMANDS: Readonly<Record<string, { usage: () => string; summary: string; main: (argv: string[]) => void }>> = {
  deploy: { usage: deployUsage, summary: DEPLOY_SUMMARY, main: runSandboxDeployMain },
  follow: { usage: followUsage, summary: FOLLOW_SUMMARY, main: runSandboxFollowMain },
};

function helpText(): string {
  const subcommands = Object.entries(SUBCOMMANDS);
  return `Manage Capella sandbox control planes.

Usage:
${subcommands.map(([, { usage }]) => `  ${usage()}`).join("\n")}
  ${sandboxCommand("<subcommand> --help")}

Subcommands:
${subcommands.map(([name, { summary }]) => `  ${name.padEnd(10)}${summary}`).join("\n")}`;
}

export function runSandboxMain(): void {
  const [subcommand, ...rest] = commandArgs(process.argv.slice(2));
  const command = subcommand && Object.hasOwn(SUBCOMMANDS, subcommand) ? SUBCOMMANDS[subcommand] : undefined;
  if (!command) {
    const help = subcommand === "--help" || subcommand === "-h" || subcommand === "help";
    if (subcommand && !help) console.error(`Unknown subcommand: ${subcommand}\n`);
    (help ? console.log : console.error)(helpText());
    process.exit(help ? 0 : 2);
  }
  command.main(rest);
}

if (isMain(import.meta.url)) {
  runSandboxMain();
}
