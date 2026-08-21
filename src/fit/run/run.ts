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
import { postSlackRunResults } from "../slack/post-run-summary.js";
import type { SlackRunResult } from "../slack/util/slack-results.js";

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
  ${run} preset <preset>[,<preset>...] --performer <image> [--env-override <path>=<value>] [resume flags] [--cbcollect] [--slack-thread <ref>] [--repeat <n>] [--stop-on-failure]
  ${run} definition <file.json5> [--override <dotpath>=<value>] [--resume-at=<point>] [resume selectors] [--cbcollect] [--slack-thread <ref>] [--repeat <n>] [--stop-on-failure]
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
  --slack-thread <ref>            Post a run summary as a reply into a Slack thread. <ref> is a message
                                  permalink, channel:ts (C0123:1720000000.123456), a p-number, or a bare ts.
                                  The FIT bot must be a member of the target channel. Needs a bot token via
                                  SLACK_BOT_TOKEN or the fit-cli/slack/token AWS secret; best-effort — a
                                  Slack failure warns but never fails the run.
  --repeat <n>                     Run every test in the definition (or generated preset) n times in a row,
                                  reusing the same cluster/performer — sets "repeat: n" on every run. Errors
                                  if any run already sets the mutually-exclusive "versions" field; target
                                  that run individually with --override instead.
  --stop-on-failure                Turn any failure into an immediate abort of the whole run (instead of
                                  continuing to the next run/cluster/instance). Combine with --repeat <n> to
                                  stop a repeated run at its first failure.

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

/**
 * Pull `--slack-thread <ref>` (or `--slack-thread=<ref>`) out of an argv list. The
 * ref points at a Slack thread to post the run summary into: a message permalink,
 * `channel:ts`, a p-number, or a bare `ts`.
 */
function extractSlackThreadFlag(argv: readonly string[]): { slackThread?: string; positionals: string[] } {
  const positionals: string[] = [];
  let slackThread: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--slack-thread") {
      slackThread = argv[++i];
    } else if (arg.startsWith("--slack-thread=")) {
      slackThread = arg.slice("--slack-thread=".length);
    } else {
      positionals.push(arg);
    }
  }
  return { slackThread, positionals };
}

/**
 * Pull `--slack-result-file <path>` out of an argv list. Internal flag used by the GHA
 * preset-group matrix (see .github/workflows/fit-cli.yaml): a single matrix job runs
 * one already-expanded preset, so it has no group to combine a Slack message over.
 * Instead of posting live, it writes its SlackRunResult rows to this file — a final
 * job downloads every matrix job's file and posts them as one combined message via
 * `fit slack post-collected`. Standalone: doesn't need `--slack-thread`, since this
 * invocation never posts to a thread itself.
 */
function extractSlackResultFileFlag(argv: readonly string[]): { slackResultFile?: string; positionals: string[] } {
  const positionals: string[] = [];
  let slackResultFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--slack-result-file") {
      slackResultFile = argv[++i];
    } else if (arg.startsWith("--slack-result-file=")) {
      slackResultFile = arg.slice("--slack-result-file=".length);
    } else {
      positionals.push(arg);
    }
  }
  return { slackResultFile, positionals };
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

/** Pull `--repeat <n>` and `--stop-on-failure` out of an argv list. They're independent: `--stop-on-failure`
 * escalates any failure to abort the whole run and doesn't require `--repeat` to be set. */
export function extractRepeatFlags(argv: readonly string[]): { repeat?: number; stopOnFailure: boolean; positionals: string[] } {
  const positionals: string[] = [];
  let repeat: number | undefined;
  let stopOnFailure = false;
  const inline = "--repeat=";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--stop-on-failure") {
      stopOnFailure = true;
      continue;
    }
    const kv = arg === "--repeat" ? argv[++i] : arg.startsWith(inline) ? arg.slice(inline.length) : undefined;
    if (kv === undefined) {
      positionals.push(arg);
      continue;
    }
    const n = Number(kv);
    if (!Number.isInteger(n) || n < 1) {
      console.error(`--repeat must be a positive integer; got ${JSON.stringify(kv)}`);
      process.exit(2);
    }
    repeat = n;
  }
  return { repeat, stopOnFailure, positionals };
}

/**
 * Set `repeat: n` on every run under `session.runs`, erroring if a run already sets
 * the mutually-exclusive `versions` field (see {@link SituationalRun.versions}).
 */
function setRepeatOnSession(session: Record<string, unknown>, n: number, path: string): void {
  const runs = Array.isArray(session.runs) ? (session.runs as Record<string, unknown>[]) : [];
  runs.forEach((run, runIndex) => {
    if (run.versions !== undefined) {
      throw new Error(
        `--repeat can't apply to "${path}.runs.${runIndex}" — it already sets "versions", which is mutually ` +
          `exclusive with "repeat". Target that run individually instead, e.g. ` +
          `--override ${path}.runs.${runIndex}.repeat=${n}.`,
      );
    }
    run.repeat = n;
  });
}

/** Set `repeat: n` on every run in a raw (pre-validation) definition object, for `--repeat`. */
export function applyRepeatOverride(raw: Record<string, unknown>, n: number): void {
  const instances = Array.isArray(raw.instances) ? (raw.instances as Record<string, unknown>[]) : [];
  instances.forEach((instance, instanceIndex) => {
    const clusters = Array.isArray(instance.clusters) ? (instance.clusters as Record<string, unknown>[]) : [];
    clusters.forEach((cluster, clusterIndex) => {
      const sessions = Array.isArray(cluster.sessions) ? (cluster.sessions as Record<string, unknown>[]) : [];
      sessions.forEach((session, sessionIndex) => {
        setRepeatOnSession(session, n, `instances.${instanceIndex}.clusters.${clusterIndex}.sessions.${sessionIndex}`);
      });
    });
    const clusterlessSessions = Array.isArray(instance.clusterlessSessions)
      ? (instance.clusterlessSessions as Record<string, unknown>[])
      : [];
    clusterlessSessions.forEach((session, sessionIndex) => {
      setRepeatOnSession(session, n, `instances.${instanceIndex}.clusterlessSessions.${sessionIndex}`);
    });
  });
}

/**
 * Read a definition file, apply `patch` to its raw (pre-validation) object, validate
 * the result, and write it to a fresh `/tmp/fit-cli/patched-*` file. Used by
 * `--override` and `--repeat` on `run definition`, and by `--repeat` on `run preset`
 * (which patches the just-generated preset file).
 */
function patchDefinitionFile(resolvedPath: string, patch: (raw: Record<string, unknown>) => void): string {
  const rawText = readFileSync(resolvedPath, "utf8");
  const format = detectDefinitionFormat(resolvedPath);
  const raw = parseDefinitionRaw(rawText, format);
  patch(raw as Record<string, unknown>);
  const definition = validateDefinition(raw);
  console.log(definitionSummary(definition));
  const patched = formatFitDefinition(definition, format);
  mkdirSync("/tmp/fit-cli", { recursive: true });
  const patchedPath = join("/tmp/fit-cli", `patched-${Date.now()}.${format}`);
  writeFileSync(patchedPath, patched, "utf8");
  return patchedPath;
}

/**
 * Extract the resume point/selector, `--cbcollect` and `--repeat`/`--stop-on-failure`
 * shared by both run subcommands, returning the parsed run options, the run count
 * requested via `--repeat` (if any), and the remaining positionals.
 */
function extractRunOptions(
  argv: readonly string[],
): { runOpts: RunFromDefinitionOptions; repeat?: number; slackResultFile?: string; positionals: string[] } {
  const { resumeAt, positionals: afterResume } = extractResumeAt(argv);
  const { selector: resumeSelector, positionals: afterSelector } = extractResumeSelector(afterResume);
  const { cbcollect, positionals: afterCbcollect } = extractCbcollectFlag(afterSelector);
  const { slackThread, positionals: afterSlackThread } = extractSlackThreadFlag(afterCbcollect);
  const { slackResultFile, positionals: afterSlackResultFile } = extractSlackResultFileFlag(afterSlackThread);
  const { repeat, stopOnFailure, positionals } = extractRepeatFlags(afterSlackResultFile);
  let resumePoint;
  try {
    resumePoint = parseResumePoint(resumeAt);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  const runOpts = {
    ...(resumePoint ? { resumeAt: resumePoint } : {}),
    resumeSelector,
    ...(cbcollect ? { cbcollect } : {}),
    ...(slackThread ? { slackThread } : {}),
    ...(stopOnFailure ? { stopOnFailure } : {}),
  };
  return { runOpts, repeat, ...(slackResultFile ? { slackResultFile } : {}), positionals };
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
    const { runOpts, repeat, slackResultFile, positionals: afterRunOpts } = extractRunOptions(afterRepoDirs);
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
    // Collects every preset's Slack rows when running a group, so the whole group posts
    // one combined message instead of one per preset (each still posts on its own for a
    // single-preset run, below).
    const groupSlackResults: SlackRunResult[] = [];
    for (const [index, type] of types.entries()) {
      if (types.length > 1) {
        console.log(`\n=== Running preset ${index + 1}/${types.length}: ${type} ===\n`);
      }
      let { path: definitionPath } = await generatePreset({
        type,
        image: performerImageShortName(parsed.sdk, parsed.tag),
        skipGuidance: true,
        ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
        ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
      });
      if (repeat !== undefined) {
        try {
          definitionPath = patchDefinitionFile(definitionPath, (raw) => applyRepeatOverride(raw, repeat));
        } catch (err) {
          console.error((err as Error).message);
          process.exit(2);
        }
        console.log(`✓ Applied --repeat ${repeat}; running from ${definitionPath}`);
      }
      // Presets in a group run in one process, so scope per-run prompt ids by preset
      // name — otherwise the second preset's teardown reuses the leave-up prompt id and
      // trips the replay "used more than once" guard. Single-preset runs stay unscoped.
      // Whether this preset's Slack rows should be collected at all — either to post
      // live after the group loop (slackThread) or to write to a file for a later job
      // to combine (slackResultFile).
      const wantsSlackOutput = Boolean(runOpts.slackThread || slackResultFile);
      if (types.length > 1) {
        // A crash mid-preset (e.g. an unmodeled AWS SDK error) must not take the rest of
        // the group down with it — one bad preset shouldn't cost the results of every
        // preset after it. Single-preset runs keep propagating straight to runCli's own
        // handler, which is the more useful behaviour there (full stack trace, exit 1).
        const slackResultsBefore = groupSlackResults.length;
        try {
          const output = await runFromDefinition(definitionPath, {
            ...runOpts,
            promptScope: type,
            ...(wantsSlackOutput ? { deferSlackTo: groupSlackResults } : {}),
          });
          if (output) outputs.push(output);
          // Some failures (e.g. resuming with no saved state) return normally without
          // ever reaching the Slack block inside runFromDefinition, so no rows get
          // pushed — without this, such a preset would silently vanish from the
          // combined message instead of showing up as a failure.
          if (wantsSlackOutput && output?.worstFailure && groupSlackResults.length === slackResultsBefore) {
            groupSlackResults.push({ label: type, sdk: type, ok: false });
          }
        } catch (err) {
          console.error(`\nPreset ${type} crashed and did not produce a result; continuing with the remaining presets.\n${formatUncaughtError(err)}`);
          if (wantsSlackOutput) {
            groupSlackResults.push({ label: type, sdk: type, ok: false });
          }
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
      } else if (slackResultFile) {
        // A single already-expanded preset (the shape a GHA matrix job runs) still
        // needs to defer rather than post live when a result file was requested, so
        // the final aggregation job can combine it with the group's other presets.
        const slackResultsBefore = groupSlackResults.length;
        const output = await runFromDefinition(definitionPath, { ...runOpts, deferSlackTo: groupSlackResults });
        if (output) outputs.push(output);
        if (output?.worstFailure && groupSlackResults.length === slackResultsBefore) {
          groupSlackResults.push({ label: type, sdk: type, ok: false });
        }
      } else {
        const output = await runFromDefinition(definitionPath, runOpts);
        if (output) outputs.push(output);
      }
    }
    // Mirrors the single-run formula (tracker.worst === undefined && results.every(ok)):
    // no preset recorded a run-failing failure, and every collected row passed.
    const groupPassed = outputs.every((o) => !o.worstFailure) && groupSlackResults.every((r) => r.ok);
    if (slackResultFile) {
      writeFileSync(slackResultFile, JSON.stringify({ passed: groupPassed, results: groupSlackResults }), "utf8");
      console.log(`✓ Wrote Slack result rows to ${slackResultFile} (posting deferred to a later job).`);
    } else if (types.length > 1 && runOpts.slackThread) {
      await postSlackRunResults({
        slackThread: runOpts.slackThread,
        title: typeList,
        results: groupSlackResults,
        passed: groupPassed,
      });
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
  const { runOpts, repeat, positionals } = extractRunOptions(afterEnvOverrides);
  const [definitionPath, ...extra] = positionals;
  if (!definitionPath || extra.length > 0) {
    console.error(
      `Usage: ${runScriptPrefix("run")} definition <file.json5> [--override <dotpath>=<value>] [--repeat <n>] [--stop-on-failure] [--resume-at=<point>] [resume selectors]\n` +
        "  --override: override a field in the definition (repeatable)\n" +
        "  --repeat: run every test in the file this many times\n" +
        "  --stop-on-failure: abort the whole run at the first failure\n" +
        "  --resume-at: after-instance-creation | after-remote-preparation | after-cluster-creation | after-performer\n" +
        "  resume selectors: --resume-instance=<n> --resume-cluster=<n> --resume-session=<n> --resume-clusterless-session=<n> --resume-run=<n>",
    );
    process.exit(2);
  }
  if (Object.keys(overrides).length > 0 || repeat !== undefined) {
    const resolvedPath = isDefinitionUrl(definitionPath) ? await cacheDefinition(definitionPath) : definitionPath;
    let patchedPath: string;
    try {
      patchedPath = patchDefinitionFile(resolvedPath, (raw) => {
        for (const [dotPath, rawValue] of Object.entries(overrides)) {
          applyDotPathOverride(raw, dotPath, rawValue);
        }
        if (repeat !== undefined) applyRepeatOverride(raw, repeat);
      });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(2);
    }
    const appliedParts = [
      ...(Object.keys(overrides).length > 0 ? [`${Object.keys(overrides).length} override(s)`] : []),
      ...(repeat !== undefined ? [`--repeat ${repeat}`] : []),
    ];
    console.log(`✓ Applied ${appliedParts.join(" and ")}; running from ${patchedPath}`);
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
