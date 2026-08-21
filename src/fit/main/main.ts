#!/usr/bin/env node
/**
 * The FIT CLI wizard. This file only presents the top-level menu and hands off
 * to a definition-focused flow. Each flow lives in its own directory and can be
 * run on its own for debugging — see the header of its entrypoint.
 */
import { existsSync } from "node:fs";
import { type RunOutput } from "../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { loadDotenv } from "../../util/non-fit/dotenv.js";
import { input, select } from "../../util/non-fit/prompts.js";
import { ensurePromptSession, type PromptSession } from "../../util/non-fit/replay.js";
import { createFitDefinition } from "../shared/create-definition/create-definition.js";
import { resolveOutputFormat } from "../util/config.js";
import { runFromDefinition } from "../functional/run-from-definition/run-from-definition.js";
import type { DefinitionFormat } from "../shared/definition/generate-definition.js";
import { extractPushGistVisibility, type GistVisibility } from "../shared/definition/push-gist.js";
import { isMachineOutputDefinitionSubcommand, runDefinitionMain } from "../definition/definition.js";
import { isMachineOutputPresetSubcommand, runPresetMain } from "../preset/preset.js";
import { runRunMain } from "../run/run.js";
import { runPresetWizard } from "../definition/preset-wizard/preset-wizard.js";
import { runArchiveMain } from "../archive/archive.js";
import { runCapsMain } from "../caps/caps.js";
import { runConfigMain } from "../config/config.js";
import { runEditWorkflow } from "../config/edit.js";
import { defaultFitCliConfigPath } from "../util/config.js";
import { runCloudInstancesMain } from "../../cloud/cloud-instances/cloud-instances.js";
import { runCapellaClustersMain } from "../../cloud/capella-clusters/capella-clusters.js";
import { runPerformerMain } from "../performer/performer.js";
import { runSecretsMain } from "../../cloud/util/aws/secrets-cli.js";
import { printVersion } from "../version/version.js";
import { runUpgradeMain } from "../upgrade/upgrade.js";
import { runMaintenanceMain } from "../maintenance/maintenance.js";
import { main as replayMain } from "../../util/non-fit/replay-entry.js";
import { installFitCliConsoleFormatting, isFitBinary, printInvocationOnce, runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import { printLogo } from "./logo.js";
import { runRecentDefinitionsWizard } from "./recent-definitions-wizard.js";
import { checkPlatform } from "./check-platform.js";

const WORKFLOW_PROMPT_MESSAGE = "What would you like to do?";

const WORKFLOW_CHOICES = [
  { name: "Run or export a preset", value: "preset" },
  { name: "Build a FIT definition file", value: "create-definition" },
  { name: "Run or share a recently generated definition file", value: "recent-definitions" },
  { name: "Run a FIT definition file", value: "run-definition" },
  { name: "Configure fit-cli", value: "configure" },
] as const;

export type WorkflowChoice = (typeof WORKFLOW_CHOICES)[number]["value"];
const WORKFLOW_PROMPT_ID = "workflow.choose";
const DEFINITION_PATH_PROMPT_ID = "workflow.definition.path";

function isWorkflowChoice(value: string): value is WorkflowChoice {
  return WORKFLOW_CHOICES.some((choice) => choice.value === value);
}

export async function chooseWorkflow(
  promptSession: PromptSession = ensurePromptSession(),
  selectWorkflow: (config: {
    promptId: string;
    message: string;
    choices: readonly { name: string; value: WorkflowChoice }[];
    default?: WorkflowChoice;
  }) => Promise<WorkflowChoice> = select,
  configMissing: boolean = !existsSync(defaultFitCliConfigPath()),
): Promise<WorkflowChoice> {
  const storedWorkflow = promptSession.getWorkflow();
  let replayWorkflow: WorkflowChoice | undefined;
  if (storedWorkflow) {
    if (storedWorkflow === "functional-tests") {
      throw new Error(
        "Replay log references the removed top-level workflow 'functional-tests'. Recreate it as a FIT definition run instead.",
      );
    }
    if (!isWorkflowChoice(storedWorkflow)) {
      throw new Error(`Unknown workflow in replay log: ${storedWorkflow}`);
    }
    replayWorkflow = storedWorkflow;
    if (promptSession.replaysStoredWorkflow()) {
      promptSession.consumeLegacyWorkflowPrompt(replayWorkflow);
      return replayWorkflow;
    }
  }

  const choices = configMissing
    ? ([
        { name: "Run or export a preset", value: "preset" },
        { name: "Build a FIT definition file", value: "create-definition" },
        { name: "Run or share a recently generated definition file", value: "recent-definitions" },
        { name: "Run a FIT definition file", value: "run-definition" },
        { name: "Configure fit-cli (recommended)", value: "configure" },
      ] as const)
    : WORKFLOW_CHOICES;

  // Note - only very high-level workflows should go here. We don't want an overwhelming list of options at the top level.
  // Users can run smaller workflows and steps for debugging or development through the mini cli tools.
  const choice = await selectWorkflow({
    promptId: WORKFLOW_PROMPT_ID,
    message: WORKFLOW_PROMPT_MESSAGE,
    choices,
    default: replayWorkflow ?? (configMissing ? "configure" : undefined),
  });
  promptSession.setWorkflow(choice);
  return choice;
}

export async function askDefinitionPath(): Promise<string> {
  const definitionPath = await input({
    promptId: DEFINITION_PATH_PROMPT_ID,
    message: "Path to the FIT definition file to run:",
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return "Enter a path to a FIT definition file.";
      }
      if (!existsSync(trimmed)) {
        return `Definition file not found: ${trimmed}`;
      }
      return true;
    },
  });
  return definitionPath.trim();
}

export async function runWorkflow(choice: WorkflowChoice, definitionPath?: string, format?: DefinitionFormat, pushGistVisibility?: GistVisibility): Promise<RunOutput> {
  switch (choice) {
    case "create-definition":
      return createFitDefinition({ format, pushGistVisibility });
    case "recent-definitions":
      return runRecentDefinitionsWizard(() => chooseWorkflow().then((c) => runWorkflow(c, definitionPath, format, pushGistVisibility)));
    case "run-definition":
      return runFromDefinition(definitionPath ?? await askDefinitionPath());
    case "preset":
      return runPresetWizard({ format, pushGistVisibility });
    case "configure":
      await runEditWorkflow();
      return { artifacts: [], details: [] };
  }
}

function extractOutputFormat(argv: readonly string[]): { format: DefinitionFormat; positionals: string[] } {
  const positionals: string[] = [];
  // Undefined until an explicit --output is seen; the config's output.format (then
  // the baked-in default) supplies the fallback below.
  let format: DefinitionFormat | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output") {
      const value = argv[i + 1];
      if (value !== "yaml" && value !== "json5") {
        throw new Error(`--output must be "yaml" or "json5"; got "${value ?? ""}"`);
      }
      format = value;
      i++;
    } else if (arg.startsWith("--output=")) {
      const value = arg.slice("--output=".length);
      if (value !== "yaml" && value !== "json5") {
        throw new Error(`--output must be "yaml" or "json5"; got "${value}"`);
      }
      format = value;
    } else {
      positionals.push(arg);
    }
  }
  return { format: format ?? resolveOutputFormat(), positionals };
}

async function runWizard(): Promise<RunOutput> {
  printLogo("making FIT easier to use, one vibe-coding session at a time.");
  console.log(
    "This wizard guides you through building a FIT definition file — a single, reusable\n" +
      "description of the FIT tests you want to run: functional, situational, performance,\n" +
      "or a mix. Once you have a definition file you can:\n" +
      "  • test it locally on this machine for a fast inner loop,\n" +
      "  • test it the way CI will, on a clean cloud (EC2) instance, and\n" +
      "  • hand the file straight to CI to run there.\n",
  );

  // Load any .env so secrets like the hosted results-DB password are available
  // without being passed on the command line. Real exported vars still win.
  loadDotenv();

  const { format, positionals: afterOutput } = extractOutputFormat(process.argv.slice(2));
  const pushGistVisibility = extractPushGistVisibility(afterOutput);
  // Remove --push-gist (and its optional value) from positionals so the length
  // check below works cleanly.
  const positionals = afterOutput.filter((arg, i) => {
    if (arg === "--push-gist") return false;
    if (arg === "public" || arg === "private") {
      return afterOutput[i - 1] !== "--push-gist";
    }
    if (arg.startsWith("--push-gist=")) return false;
    return true;
  });
  if (positionals.length > 0) {
    throw new Error(`Usage: ${runScriptPrefix("wizard")} [--output yaml|json5] [--push-gist [public|private]]`);
  }
  const choice = await chooseWorkflow();
  return runWorkflow(choice, undefined, format, pushGistVisibility);
}

function runWizardMain(): void {
  runCli(runWizard);
}

function runReplayMain(): void {
  replayMain(["--replay", ...process.argv.slice(2)]);
}

// Single source of truth for all top-level commands.
// Anything listed here is available as both `fit <cmd>` and `bun run <cmd>`.
/**
 * `machineOutput` marks invocations whose stdout is parsed by a machine rather
 * than read by a human — CI does `presets=$(fit preset expand ... --json) >>
 * $GITHUB_OUTPUT`. For those we install no console formatting and print no
 * "Ran with:" banner, so stdout carries the payload and nothing else. It takes
 * the command's args because it's the *sub*command that decides.
 */
const COMMANDS: Record<string, { fn: () => void; description: string; hidden?: boolean; machineOutput?: (args: string[]) => boolean }> = {
  "wizard":          { fn: runWizardMain,          description: "Interactive walkthrough (default when no command given)" },
  "run":             { fn: runRunMain,             description: "Run FIT tests from a preset or a definition file" },
  "preset":          { fn: runPresetMain,          description: "List, expand or generate FIT presets", machineOutput: isMachineOutputPresetSubcommand },
  "definition":      { fn: runDefinitionMain,      description: "Author or inspect a FIT definition file", machineOutput: isMachineOutputDefinitionSubcommand },
  "config":          { fn: runConfigMain,           description: "Manage fit-cli configuration" },
  "cloud-instances": { fn: runCloudInstancesMain,  description: "Manage cloud (EC2) instances" },
  "capella-clusters": { fn: runCapellaClustersMain, description: "Sweep the Capella clusters failed runs left behind" },
  "performer":       { fn: runPerformerMain,        description: "Build FIT performer images from an SDK repo ref" },
  "caps":            { fn: runCapsMain,             description: "Show the FIT capabilities each SDK's performer reports" },
  "secrets":         { fn: runSecretsMain,          description: "Manage AWS secrets", hidden: true },
  "maintenance":     { fn: runMaintenanceMain,       description: "Repo & release maintenance (branch channels)", hidden: true },
  "archive":         { fn: runArchiveMain,          description: "Archive run artifacts" },
  "replay":          { fn: runReplayMain,           description: "Replay a recorded session" },
  "version":         { fn: printVersion,            description: "Print the fit-cli version" },
  "upgrade":         { fn: runUpgradeMain,           description: "Upgrade fit-cli to the latest released build" },
  "help":            { fn: printHelp,               description: "Print this help message" },
};

function printHelp(): void {
  const visible = Object.entries(COMMANDS).filter(([, { hidden }]) => !hidden);
  const maxLen = Math.max(...visible.map(([k]) => k.length));
  const lines = visible
    .map(([name, { description }]) => `  ${name.padEnd(maxLen)}  ${description}`)
    .join("\n");
  const bin = isFitBinary() ? "fit" : "bun run";
  console.log(`${bin} — FIT CLI\n\nUsage: ${bin} [command] [...args]\n\nCommands:\n${lines}\n`);
}

// import.meta.main is true in compiled Bun binaries where isMain() can't
// compare virtual /$bunfs/ paths against the real executable path.
if (isMain(import.meta.url) || import.meta.main) {
  const cmd = process.argv[2];
  const entry = cmd ? COMMANDS[cmd] : undefined;
  const machineOutput = entry?.machineOutput?.(process.argv.slice(3)) ?? false;

  // Printed before anything else — and before the subcommand token below is
  // spliced out of process.argv — so a CI log always shows exactly how
  // fit-cli was invoked, even if the run fails before any other output is
  // produced. Both are suppressed for machine-output invocations, whose stdout
  // must stay clean enough for a caller to parse.
  if (!machineOutput) {
    installFitCliConsoleFormatting();
    printInvocationOnce();
  }

  checkPlatform();

  const command = entry?.fn;

  if (command) {
    process.argv.splice(2, 1);
    command();
  } else if (!cmd || cmd.startsWith("-")) {
    // bare `fit` or flags only → wizard
    runCli(runWizard);
  } else {
    console.error(`Unknown command: ${cmd}\nRun '${runScriptPrefix("help")}' for usage.`);
    process.exit(1);
  }
}
