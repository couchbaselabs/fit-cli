#!/usr/bin/env node
/**
 * Top-level dispatcher for the `definition` bun script and for the compiled
 * `fit definition [...]` subcommand. This namespace is for authoring and
 * inspecting definition files; to *run* one (or a preset), use `fit run`, and
 * to list/expand/generate presets, use `fit preset`.
 *
 * bun run definition validate <file.yaml>
 * bun run definition generate-desc <file.yaml>
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { extractInteractiveFlag, extractReplayFlag, markNonInteractiveByDefault } from "../../util/non-fit/replay.js";
import { cacheDefinition, definitionSummary, isDefinitionUrl, loadDefinition, resolveAndLoadDefinition, upgradeDefinitionFileInPlace } from "../shared/definition/parse-definition.js";
import { describeDefinition } from "../shared/definition/generate-desc.js";
import { runDispatch } from "../run/run.js";
import { expandUsage, presetDispatch, runRawExpand } from "../preset/preset.js";
import type { RunOutput } from "../../util/non-fit/artifacts.js";
import { printWithoutTimestamps, runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";

const SUBCOMMANDS = ["validate", "generate-desc"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

/**
 * The preset subcommands that used to live here and now belong to `fit preset`.
 * Kept working — undocumented, and absent from SUBCOMMANDS/HELP — because CI in
 * other repos calls them (e.g. couchbase-jvm-clients does
 * `fit definition expand-preset-group "$PRESETS" --json`). Each delegates to the
 * `preset` dispatcher and warns on *stderr*: `expand-preset-group`'s stdout is
 * parsed by those callers, so a warning there would corrupt it.
 */
const DEPRECATED_PRESET_ALIASES: Record<string, string> = {
  "list-presets": "list",
  "expand-preset-group": "expand",
  "generate-preset": "generate",
};

function warnDeprecatedPresetAlias(subcommand: string): void {
  const replacement = DEPRECATED_PRESET_ALIASES[subcommand];
  process.stderr.write(
    `Warning: \`${runScriptPrefix("definition")} ${subcommand}\` is deprecated — use \`${runScriptPrefix("preset")} ${replacement}\` instead.\n`,
  );
}

/**
 * Subcommands whose stdout is machine-parseable and must therefore carry
 * nothing but the payload — CI pipes them straight into things like
 * `$GITHUB_OUTPUT`, where a stray `Ran with:` banner or `[HH:MM:SS]` prefix is
 * not noise but a hard failure. `main.ts` consults this before it installs any
 * console formatting; see runRawSubcommand.
 */
const MACHINE_OUTPUT_SUBCOMMANDS: readonly string[] = ["generate-desc", "expand-preset-group"];

/** `args` is argv after the `definition` token, e.g. ["expand-preset-group", "all-release"]. */
export function isMachineOutputDefinitionSubcommand(args: readonly string[]): boolean {
  return args.length > 0 && MACHINE_OUTPUT_SUBCOMMANDS.includes(args[0]);
}

function buildHelp(): string {
  const def = runScriptPrefix("definition");
  const run = runScriptPrefix("run");
  const preset = runScriptPrefix("preset");
  return `Author and inspect FIT definition files.

To run a definition file or a preset, use \`${run}\` instead.
To list, expand or generate presets, use \`${preset}\` instead.

Usage:
  ${def} validate <file.json5>
  ${def} upgrade <file.json5>
  ${def} generate-desc <file.json5>
  ${def} --help

Both .json5 and .yaml definition files are accepted.

Subcommands:
  validate       Parse and validate a definition file without running it.
  generate-desc  Print a compact description of a definition file (useful for CI labels).`;
}

/**
 * Translate legacy `execute-preset` args (preset chosen via `--type <preset>`)
 * into `run preset` args (preset given as a positional). Other args — the
 * performer image, resume flags — pass straight through for the run dispatcher
 * to parse.
 */
function legacyExecutePresetToRunPreset(rest: string[]): string[] {
  const passthrough: string[] = [];
  let type: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--type") {
      type = rest[++i];
    } else if (arg.startsWith("--type=")) {
      type = arg.slice("--type=".length);
    } else {
      passthrough.push(arg);
    }
  }
  return type ? [type, ...passthrough] : passthrough;
}

/**
 * Dispatcher for definition subcommands. Called either from the `bun run
 * definition` entrypoint (via runCli) or from the compiled `fit` binary's
 * `main.ts` when the user runs `fit definition [...]`.
 *
 * `argv` is the slice of args after the `definition` keyword (i.e. the
 * subcommand and its flags/positionals).
 */
export async function definitionDispatch(argv: string[]): Promise<RunOutput | void> {
  // The global --interactive / --replay flags are read straight from
  // process.argv by the prompt session, so strip them here before we pick the
  // subcommand off the front.
  const cleaned = extractInteractiveFlag(extractReplayFlag(argv).positionals).positionals;
  const [subcommand, ...rest] = cleaned;

  const HELP_FLAGS = new Set(["-h", "--help", "help"]);
  if (!subcommand || HELP_FLAGS.has(subcommand) || rest.some(a => HELP_FLAGS.has(a))) {
    console.log(buildHelp());
    if (!subcommand) process.exit(2);
    return;
  }

  // Hidden backward-compat: the old `definition execute` / `execute-preset`
  // subcommands now live under `fit run`. Keep them working (undocumented — not
  // in HELP) by delegating to the run dispatcher.
  if (subcommand === "execute") {
    return runDispatch(["definition", ...rest]);
  }
  if (subcommand === "execute-preset") {
    return runDispatch(["preset", ...legacyExecutePresetToRunPreset(rest)]);
  }

  // Deprecated preset subcommands, now under `fit preset`. `expand-preset-group`
  // never reaches here — it's machine-output, so runDefinitionMain routes it to
  // runRawSubcommand below before runCli installs any console formatting.
  if (subcommand in DEPRECATED_PRESET_ALIASES) {
    warnDeprecatedPresetAlias(subcommand);
    // `generate-preset` took the preset via `--type`; `preset generate` takes it
    // as a positional but still accepts `--type`, so `rest` passes straight through.
    return presetDispatch([DEPRECATED_PRESET_ALIASES[subcommand], ...rest]);
  }

  if (!SUBCOMMANDS.includes(subcommand as Subcommand)) {
    console.error(`Unknown subcommand: ${subcommand}\n`);
    console.error(buildHelp());
    process.exit(2);
  }

  // validate
  const [path, ...extra] = rest;
  if (!path || extra.length > 0) {
    console.error(`Usage: ${runScriptPrefix("definition")} validate <file.json5>`);
    process.exit(2);
  }
  const { definition } = await resolveAndLoadDefinition(path);
  console.log(definitionSummary(definition));
}

/**
 * `generate-desc` and the deprecated `expand-preset-group` print
 * machine-parseable output meant for CI to consume directly (e.g. building a
 * GHA matrix). runCli's session setup unconditionally prints
 * timestamp-prefixed banners and a closing artifact table to stdout, which
 * would corrupt that output — so these two run here, before runCli is ever
 * invoked, and write straight to the real stdout/stderr.
 *
 * `main.ts` keeps its side of that bargain by skipping console formatting for
 * these subcommands (see isMachineOutputDefinitionSubcommand); the raw writes
 * below are wrapped anyway so the payload survives even if some other
 * entrypoint has already installed the timestamped stdout wrapper.
 */
async function runRawSubcommand(argv: string[]): Promise<void> {
  if (argv[0] === "generate-desc") {
    const path = argv[1];
    if (!path) {
      process.stderr.write(`Usage: ${runScriptPrefix("definition")} generate-desc <file.json5>\n`);
      process.exit(2);
    }
    const resolvedPath = isDefinitionUrl(path) ? await cacheDefinition(path) : path;
    const definition = loadDefinition(resolvedPath);
    printWithoutTimestamps(describeDefinition(definition));
    return;
  }

  // Deprecated alias for `preset expand`. The warning goes to stderr so the
  // stdout payload its CI callers parse stays clean.
  warnDeprecatedPresetAlias("expand-preset-group");
  runRawExpand(argv.slice(1), expandUsage("definition", "expand-preset-group"));
}

export function runDefinitionMain(): void {
  // The `definition` command runs CI-style with default answers unless
  // `--interactive` is passed. This is the single entrypoint for every launch
  // form — `fit definition` and `bun run definition` — so declaring it here
  // covers them all, and it runs before runCli creates the prompt session below.
  markNonInteractiveByDefault();
  const argv = process.argv.slice(2);
  // Handle help before runCli creates the artifact directory.
  const positionals = extractInteractiveFlag(extractReplayFlag(argv).positionals).positionals;
  const helpFlags = new Set(["-h", "--help", "help"]);
  if (positionals.length === 0 || helpFlags.has(positionals[0]) || positionals.some(a => helpFlags.has(a))) {
    console.log(buildHelp());
    process.exit(positionals.length === 0 ? 2 : 0);
  }
  if (isMachineOutputDefinitionSubcommand(argv)) {
    runRawSubcommand(argv).catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
    return;
  }
  runCli(() => definitionDispatch(argv));
}

if (isMain(import.meta.url)) {
  runDefinitionMain();
}
