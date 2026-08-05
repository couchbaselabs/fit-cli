#!/usr/bin/env node
/**
 * Top-level `fit run` — execute FIT tests. This is the most common end-user
 * entrypoint; authoring and inspecting definition files lives under
 * `fit definition`.
 *
 *   bun run run preset <preset> --performer <image> [resume flags] [--cbcollect]
 *   bun run run definition <file.json5> [--resume-at=<point>] [resume selectors] [--cbcollect]
 *
 * The subcommand says what kind of thing is being run: a named `preset`
 * template, or a `definition` file (path or URL).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatUncaughtError, isMain, runCli } from "../../util/non-fit/cli.js";
import { extractCbcollectFlag, extractInteractiveFlag, extractReplayFlag, markNonInteractiveByDefault } from "../../util/non-fit/replay.js";
import { runFromDefinition, type RunFromDefinitionOptions } from "../functional/run-from-definition/run-from-definition.js";
import {
  definitionSummary,
  detectDefinitionFormat,
  isDefinitionUrl,
  cacheDefinition,
  parseDefinitionRaw,
  validateDefinition,
  resolveAndLoadDefinition,
} from "../shared/definition/parse-definition.js";
import {
  extractResumeAt,
  extractResumeSelector,
  parseResumePoint,
} from "../functional/run-from-definition/resume.js";
import {
  applyDotPathOverride,
  assertEnvOverridesUsed,
  formatKnownPresetsByTag,
  generatePreset,
  parseKeyValueFlag,
  validateEnvOverrides,
} from "../definition/generate-preset/generate-preset.js";
import { expandPresetGroupNames, formatKnownPresetGroups, formatPresetsAndGroupsListing } from "../definition/generate-preset/preset-groups.js";
import { analysePerformerImage, performerImageShortName } from "../performers/util/performer-image.js";
import { formatFitDefinition } from "../shared/definition/generate-definition.js";
import { combineRunOutputs, type RunOutput } from "../../util/non-fit/artifacts.js";
import { printVersion } from "../version/version.js";
import { runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import { FIT_PERFORMER } from "../util/repos.js";

/** Maps a `--repo-dir` key (a {@link Repo.name}) to the env var {@link resolveFitPerformerDir} reads it from. */
const REPO_DIR_ENV_VARS: Record<string, string> = {
  [FIT_PERFORMER.name]: "FIT_PERFORMER_DIR",
};

const SUBCOMMANDS = ["preset", "definition"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function buildHelp(): string {
  const run = runScriptPrefix("run");
  return `Run FIT tests from a preset or a definition file.

Usage:
  ${run} preset <preset>[,<preset>...] --performer <image> [--env-override <path>=<value>] [resume flags] [--cbcollect]
  ${run} definition <file.json5> [--override <dotpath>=<value>] [--resume-at=<point>] [resume selectors] [--cbcollect]
  ${run} --help

Subcommands:
  preset      Generate a preset definition file and run it immediately.
              A comma-separated list of presets (or a preset group) runs them one after another.
  definition  Run an existing definition file (path or URL). Both .json5 and .yaml are accepted.

Known presets:
${formatKnownPresetsByTag()}

Known preset groups:
${formatKnownPresetGroups()}

Shared options (both subcommands):
  --repo-dir <repo>=<path>         Override, for this run only, where a local repo checkout lives —
                                  normally set once via \`${runScriptPrefix("config")} edit\` (repeatable).
                                  e.g. --repo-dir transactions-fit-performer=/path/to/checkout

preset options:
  --performer <image>             SDK-specific performer image ref (e.g. java-fit-performer:refs-changes-67-246067-3 or ghcr.io/couchbase/java-fit-performer:refs-changes-67-246067-3). Alias: --performer-image-name.
  --override <dotpath>=<value>    Override a field in the generated definition (repeatable).
                                  e.g. --override setup.repos.transactions-fit-performer.gerritRef=refs/changes/32/247532/1
  --env-override <path>=<value>   Override an environments.json5 value the preset templates in (repeatable),
                                  keyed by the preset's {{environments.<path>}} placeholder. Applies to every
                                  preset in a group, and is baked into the generated definition.
                                  e.g. --env-override defaults.clusterVersion=7.6-stable
                                  Common paths: defaults.clusterVersion, defaults.capellaClusterVersion,
                                  defaults.cngClusterVersion, defaults.enterpriseAnalyticsVersion

definition options:
  --override <dotpath>=<value>    Override a field in the definition before running (repeatable).
                                  e.g. --override setup.repos.transactions-fit-performer.gerritRef=refs/changes/05/247705/1

Resume points:
  --resume-at=after-instance-creation   Reuse a running instance.
  --resume-at=after-remote-preparation  Reuse a prepared remote workspace.
  --resume-at=after-cluster-creation    Reuse an allocated cluster.
  --resume-at=after-performer           Reuse the cluster and a running performer.

Resume selectors (narrow a resume to one run; emitted by a left-up run):
  --resume-instance=<n>             Which instance to resume.
  --resume-cluster=<n>              Which cluster within the instance.
  --resume-session=<n>              Which session within the cluster.
  --resume-clusterless-session=<n>  Which clusterless (situational) session.
  --resume-run=<n>                  Which run within the session.

See available presets in detail with: ${runScriptPrefix("preset")} list`;
}

/**
 * Pull repeatable `<flag> key=value` entries (e.g. `--override`, `--env-override`)
 * out of an argv list, leaving everything else in `positionals`.
 */
function extractKeyValueFlag(
  argv: readonly string[],
  flag: string,
): { values: Record<string, string>; positionals: string[] } {
  const values: Record<string, string> = {};
  const positionals: string[] = [];
  const inline = `${flag}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const kv = arg === flag ? argv[++i] : arg.startsWith(inline) ? arg.slice(inline.length) : undefined;
    if (kv === undefined) {
      positionals.push(arg);
      continue;
    }
    try {
      const [key, value] = parseKeyValueFlag(flag, kv);
      values[key] = value;
    } catch (err) {
      console.error((err as Error).message);
      process.exit(2);
    }
  }
  return { values, positionals };
}

/** Pull `--override key=value` entries out of an argv list (repeatable). */
function extractOverrides(argv: readonly string[]): { overrides: Record<string, string>; positionals: string[] } {
  const { values, positionals } = extractKeyValueFlag(argv, "--override");
  return { overrides: values, positionals };
}

/**
 * Pull `--repo-dir <repo-name>=<path>` entries (repeatable) out of an argv list.
 * This overrides, for this run only, where a local repo checkout lives — normally
 * set once via `fit config edit` (`localhost.repos.<name>.dir`). Fails fast on an
 * unknown repo name rather than silently doing nothing.
 */
function extractRepoDirs(argv: readonly string[]): { repoDirs: Record<string, string>; positionals: string[] } {
  const { values, positionals } = extractKeyValueFlag(argv, "--repo-dir");
  for (const name of Object.keys(values)) {
    if (!(name in REPO_DIR_ENV_VARS)) {
      console.error(`--repo-dir: unknown repo "${name}". Known repos: ${Object.keys(REPO_DIR_ENV_VARS).join(", ")}`);
      process.exit(2);
    }
  }
  return { repoDirs: values, positionals };
}

/** Apply `--repo-dir` overrides to the environment for the rest of this process. */
function applyRepoDirs(repoDirs: Record<string, string>): void {
  for (const [name, dir] of Object.entries(repoDirs)) {
    process.env[REPO_DIR_ENV_VARS[name]] = dir;
  }
}

/**
 * Pull `--env-override <dot.path>=<value>` entries (repeatable) out of an argv list.
 * These override `environments.json5` values as a preset's `{{environments.*}}`
 * placeholders are substituted — e.g. `defaults.clusterVersion=7.6-stable` to run a
 * preset against a different server version without editing `environments.json5`.
 *
 * Preset generation only: by the time a definition file exists, its placeholders are
 * already resolved, so `run definition` rejects this flag and points at `--override`.
 */
function extractEnvOverrides(argv: readonly string[]): { envOverrides: Record<string, string>; positionals: string[] } {
  const { values, positionals } = extractKeyValueFlag(argv, "--env-override");
  return { envOverrides: values, positionals };
}

/** Pull `--performer-image-name[=<image>]` (or the `--performer` alias) out of an argv list. */
function extractPerformerImageName(argv: readonly string[]): { performerImageName?: string; positionals: string[] } {
  const positionals: string[] = [];
  let performerImageName: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--performer-image-name" || arg === "--performer") {
      performerImageName = argv[++i];
    } else if (arg.startsWith("--performer-image-name=")) {
      performerImageName = arg.slice("--performer-image-name=".length);
    } else if (arg.startsWith("--performer=")) {
      performerImageName = arg.slice("--performer=".length);
    } else {
      positionals.push(arg);
    }
  }
  return { performerImageName, positionals };
}

/**
 * Extract the resume point/selector and `--cbcollect` shared by both run
 * subcommands, returning the parsed run options and the remaining positionals.
 */
function extractRunOptions(argv: readonly string[]): { runOpts: RunFromDefinitionOptions; positionals: string[] } {
  const { resumeAt, positionals: afterResume } = extractResumeAt(argv);
  const { selector: resumeSelector, positionals: afterSelector } = extractResumeSelector(afterResume);
  const { cbcollect, positionals } = extractCbcollectFlag(afterSelector);
  let resumePoint;
  try {
    resumePoint = parseResumePoint(resumeAt);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  const runOpts = { ...(resumePoint ? { resumeAt: resumePoint } : {}), resumeSelector, ...(cbcollect ? { cbcollect } : {}) };
  return { runOpts, positionals };
}

/**
 * Dispatcher for `fit run`. Called from the `bun run run` entrypoint (via
 * runCli) or from the compiled `fit` binary's `main.ts` when the user runs
 * `fit run [...]`. `argv` is the slice of args after the `run` keyword.
 */
export async function runDispatch(argv: string[]): Promise<RunOutput | void> {
  // The global --interactive / --replay flags are read straight from
  // process.argv by the prompt session; strip them before parsing positionals.
  const cleaned = extractInteractiveFlag(extractReplayFlag(argv).positionals).positionals;
  const [subcommand, ...rest] = cleaned;

  const HELP_FLAGS = new Set(["-h", "--help", "help"]);
  if (!subcommand || HELP_FLAGS.has(subcommand) || rest.some((a) => HELP_FLAGS.has(a))) {
    console.log(buildHelp());
    if (!subcommand) process.exit(2);
    return;
  }

  if (!SUBCOMMANDS.includes(subcommand as Subcommand)) {
    console.error(`Unknown subcommand: ${subcommand}\n`);
    console.error(buildHelp());
    process.exit(2);
  }

  printVersion();
  console.log();

  const { repoDirs, positionals: afterRepoDirs } = extractRepoDirs(rest);
  applyRepoDirs(repoDirs);

  if (subcommand === "preset") {
    const { runOpts, positionals: afterRunOpts } = extractRunOptions(afterRepoDirs);
    const { overrides, positionals: afterOverrides } = extractOverrides(afterRunOpts);
    const { envOverrides, positionals: afterEnvOverrides } = extractEnvOverrides(afterOverrides);
    const { performerImageName, positionals } = extractPerformerImageName(afterEnvOverrides);
    try {
      validateEnvOverrides(envOverrides);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(2);
    }
    const [typeList, ...extra] = positionals;
    if (!typeList || extra.length > 0) {
      console.error(
        `Usage: ${runScriptPrefix("run")} preset <preset-or-group>[,<preset-or-group>...] --performer <image>\n${formatPresetsAndGroupsListing()}`,
      );
      process.exit(2);
    }
    let types: string[];
    try {
      types = expandPresetGroupNames(typeList);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(2);
    }
    if (types.length > 1) {
      console.log(`"${typeList}" expands to ${types.length} presets, run in sequence: ${types.join(", ")}\n`);
    }
    // Checked against the whole expanded set, so a group-wide override only has to apply
    // to some of its presets — see assertEnvOverridesUsed.
    try {
      assertEnvOverridesUsed(types, envOverrides);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(2);
    }
    if (!performerImageName) {
      console.error("--performer is required, e.g. java-fit-performer:main");
      process.exit(2);
    }
    const parsed = analysePerformerImage(performerImageName);
    if ("error" in parsed) {
      console.error(`--performer-image-name: ${parsed.error}`);
      process.exit(2);
    }
    const outputs: RunOutput[] = [];
    for (const [index, type] of types.entries()) {
      if (types.length > 1) {
        console.log(`\n=== Running preset ${index + 1}/${types.length}: ${type} ===\n`);
      }
      const { path: definitionPath } = await generatePreset({
        type,
        image: performerImageShortName(parsed.sdk, parsed.tag),
        skipGuidance: true,
        ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
        ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
      });
      // Presets in a group run in one process, so scope per-run prompt ids by preset
      // name — otherwise the second preset's teardown reuses the leave-up prompt id and
      // trips the replay "used more than once" guard. Single-preset runs stay unscoped.
      if (types.length > 1) {
        // A crash mid-preset (e.g. an unmodeled AWS SDK error) must not take the rest of
        // the group down with it — one bad preset shouldn't cost the results of every
        // preset after it. Single-preset runs keep propagating straight to runCli's own
        // handler, which is the more useful behaviour there (full stack trace, exit 1).
        try {
          const output = await runFromDefinition(definitionPath, { ...runOpts, promptScope: type });
          if (output) outputs.push(output);
        } catch (err) {
          console.error(`\nPreset ${type} crashed and did not produce a result; continuing with the remaining presets.\n${formatUncaughtError(err)}`);
          outputs.push({
            artifacts: [],
            details: [],
            worstFailure: {
              classification: "FatalToAll",
              message: err instanceof Error ? err.message : String(err),
              context: { instanceIndex: 0, label: type },
            },
            failureCount: 1,
          });
        }
      } else {
        const output = await runFromDefinition(definitionPath, runOpts);
        if (output) outputs.push(output);
      }
    }
    return combineRunOutputs(...outputs);
  }

  // definition
  const { overrides, positionals: afterOverrides } = extractOverrides(afterRepoDirs);
  // A definition file has no `{{environments.*}}` placeholders left to resolve — they were
  // substituted when it was generated. Say so, rather than letting the flag fall through to
  // the positional parser and surface as a confusing usage error.
  const { envOverrides, positionals: afterEnvOverrides } = extractEnvOverrides(afterOverrides);
  if (Object.keys(envOverrides).length > 0) {
    console.error(
      `--env-override only applies to "${runScriptPrefix("run")} preset" (it resolves a preset's {{environments.*}} placeholders).\n` +
        "A definition file's placeholders are already resolved — edit it, or patch the field directly with --override.",
    );
    process.exit(2);
  }
  const { runOpts, positionals } = extractRunOptions(afterEnvOverrides);
  const [definitionPath, ...extra] = positionals;
  if (!definitionPath || extra.length > 0) {
    console.error(
      `Usage: ${runScriptPrefix("run")} definition <file.json5> [--override <dotpath>=<value>] [--resume-at=<point>] [resume selectors]\n` +
        "  --override: override a field in the definition (repeatable)\n" +
        "  --resume-at: after-instance-creation | after-remote-preparation | after-cluster-creation | after-performer\n" +
        "  resume selectors: --resume-instance=<n> --resume-cluster=<n> --resume-session=<n> --resume-clusterless-session=<n> --resume-run=<n>",
    );
    process.exit(2);
  }
  if (Object.keys(overrides).length > 0) {
    const resolvedPath = isDefinitionUrl(definitionPath) ? await cacheDefinition(definitionPath) : definitionPath;
    const rawText = readFileSync(resolvedPath, "utf8");
    const format = detectDefinitionFormat(resolvedPath);
    const raw = parseDefinitionRaw(rawText, format);
    for (const [dotPath, rawValue] of Object.entries(overrides)) {
      applyDotPathOverride(raw as Record<string, unknown>, dotPath, rawValue);
    }
    const definition = validateDefinition(raw);
    console.log(definitionSummary(definition));
    const patched = formatFitDefinition(definition, format);
    mkdirSync("/tmp/fit-cli", { recursive: true });
    const patchedPath = join("/tmp/fit-cli", `patched-${Date.now()}.${format}`);
    writeFileSync(patchedPath, patched, "utf8");
    console.log(`✓ Applied ${Object.keys(overrides).length} override(s); running from ${patchedPath}`);
    return runFromDefinition(patchedPath, runOpts);
  }
  const { resolvedPath, definition } = await resolveAndLoadDefinition(definitionPath);
  console.log(definitionSummary(definition));
  return runFromDefinition(resolvedPath, runOpts);
}

export function runRunMain(): void {
  // `fit run` runs CI-style with default answers unless `--interactive` is
  // passed. Declare it before runCli creates the prompt session below.
  markNonInteractiveByDefault();
  const argv = process.argv.slice(2);
  // Handle help before runCli creates the artifact directory.
  const positionals = extractInteractiveFlag(extractReplayFlag(argv).positionals).positionals;
  const helpFlags = new Set(["-h", "--help", "help"]);
  if (positionals.length === 0 || helpFlags.has(positionals[0]) || positionals.some((a) => helpFlags.has(a))) {
    console.log(buildHelp());
    process.exit(positionals.length === 0 ? 2 : 0);
  }
  runCli(() => runDispatch(argv));
}

if (isMain(import.meta.url)) {
  runRunMain();
}
