import * as prompts from "@inquirer/prompts";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { fitCliInfo, runScriptPrefix } from "./fit-cli-log.js";

/**
 * Absolute path to the fit-cli repo root, derived from this file's location
 * (src/util/non-fit/replay.ts → three levels up). The recorded invocation
 * entrypoint is stored relative to this so a replay log is portable across
 * checkouts; replay resolves it back against the repo root on the replaying
 * machine. See {@link captureReplayInvocation}.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export type PromptKind =
  | "checkbox"
  | "confirm"
  | "input"
  | "number"
  | "password"
  | "search"
  | "select";

export interface PromptLogEntry {
  id: string;
  kind: PromptKind;
  message: string;
  response: unknown;
}

export interface PromptResolveOptions<T> {
  serializeResponse?: (response: T) => unknown;
  deserializeResponse?: (response: unknown) => T;
  nonInteractiveDefault?: () => T | Promise<T>;
}

export interface ReplayInvocation {
  /**
   * The workflow script that was run, as a path relative to {@link REPO_ROOT}
   * (e.g. "src/main.ts"). Kept relative so the log doesn't pin to a specific
   * checkout location. Falls back to an absolute path only if the entrypoint
   * lives outside the repo.
   */
  entrypoint: string;
  args: string[];
}

export interface PromptSessionHooks {
  onUnusedReplayPrompts?: (entries: readonly PromptLogEntry[]) => Promise<"continue" | "exit">;
}

export interface PromptSessionConfig {
  entrypoint?: string;
  env?: NodeJS.ProcessEnv;
}

export interface PromptLogFile {
  version: 1;
  createdAt: string;
  workflow?: string;
  invocation?: ReplayInvocation;
  prompts: PromptLogEntry[];
}

type PromptSessionMode = "record" | "replay" | "defaults" | "non-interactive";

export const RUN_ROOT_DIR = "/tmp/fit-cli";
const RUN_FROM_DEFINITION_ENTRYPOINT = "src/fit/functional/run-from-definition/run-from-definition.ts";

// Some commands (notably `run` / `definition`) should run with default answers
// unless `--interactive` is passed, regardless of how they were launched — the
// compiled `fit` binary and `bun run <cmd>` share one entrypoint, so we can't
// tell them apart by entrypoint path alone. The command's entrypoint declares
// its default by calling this before the prompt session starts.
let nonInteractiveByDefault = false;
export function markNonInteractiveByDefault(value = true): void {
  nonInteractiveByDefault = value;
}

export function extractReplayFlag(
  argv: string[],
  env?: NodeJS.ProcessEnv,
): {
  replayRequested: boolean;
  replayDefaults: boolean;
  replayFile?: string;
  positionals: string[];
} {
  env ??= process.env;
  const positionals: string[] = [];
  let replayRequested = false;
  let replayDefaults = false;
  let replayFile: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--replay") {
      replayRequested = true;
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        replayFile = next;
        i++;
      }
    } else if (arg.startsWith("--replay=")) {
      replayRequested = true;
      replayFile = arg.slice("--replay=".length);
    } else if (arg === "--defaults") {
      replayRequested = true;
      replayDefaults = true;
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        replayFile = next;
        i++;
      }
    } else if (arg.startsWith("--defaults=")) {
      replayRequested = true;
      replayDefaults = true;
      replayFile = arg.slice("--defaults=".length);
    } else {
      positionals.push(arg);
    }
  }

  const npmReplayDefaults = env.npm_lifecycle_event === "replay" ? env.npm_config_defaults : undefined;
  if (replayRequested && !replayDefaults && npmReplayDefaults !== undefined && npmReplayDefaults !== "false") {
    replayDefaults = true;
    if (!replayFile && npmReplayDefaults !== "true" && npmReplayDefaults.length > 0) {
      replayFile = npmReplayDefaults;
    }
  }

  return { replayRequested, replayDefaults, replayFile, positionals };
}

export function extractInteractiveFlag(argv: string[]): {
  interactive: boolean;
  positionals: string[];
} {
  const positionals: string[] = [];
  let interactive = false;

  for (const arg of argv) {
    if (arg === "--interactive") {
      interactive = true;
    } else {
      positionals.push(arg);
    }
  }

  return { interactive, positionals };
}

export function extractCbcollectFlag(argv: string[]): {
  cbcollect: boolean;
  positionals: string[];
} {
  const positionals = argv.filter((a) => a !== "--cbcollect");
  return { cbcollect: positionals.length !== argv.length, positionals };
}

export function defaultsToNonInteractive(
  entrypoint: string | undefined = process.argv[1],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // CI environments (GitHub Actions, CircleCI, etc.) set CI=true and must never prompt.
  if (env.CI) {
    return true;
  }
  // A command may declare itself non-interactive-by-default (e.g. `definition`),
  // which holds however it was launched — see markNonInteractiveByDefault.
  if (nonInteractiveByDefault) {
    return true;
  }
  if (!entrypoint) {
    return false;
  }

  const normalizedEntrypoint = entrypoint.replaceAll("\\", "/");
  return normalizedEntrypoint.endsWith(RUN_FROM_DEFINITION_ENTRYPOINT);
}

function captureReplayInvocation(
  argv: string[],
  entrypoint: string | undefined = process.argv[1],
  cwd = process.cwd(),
): ReplayInvocation | undefined {
  if (!entrypoint) {
    return undefined;
  }

  const absolute = isAbsolute(entrypoint) ? entrypoint : resolve(cwd, entrypoint);
  const repoRelative = relative(REPO_ROOT, absolute);
  // Keep the entrypoint relative when it lives inside the repo; only an
  // entrypoint outside the repo (which escapes with "..") falls back to absolute.
  const portable = repoRelative.startsWith("..") || isAbsolute(repoRelative) ? absolute : repoRelative;

  return {
    entrypoint: portable,
    args: extractReplayFlag(argv).positionals,
  };
}

export function readPromptLog(logFile: string): PromptLogFile {
  let raw: Partial<PromptLogFile>;
  try {
    raw = JSON.parse(readFileSync(logFile, "utf8")) as Partial<PromptLogFile>;
  } catch (err) {
    throw new Error(`Could not read replay log ${logFile}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (raw.version !== 1 || !Array.isArray(raw.prompts) || typeof raw.createdAt !== "string") {
    throw new Error(`Invalid replay log file: ${logFile}`);
  }
  return {
    version: 1,
    createdAt: raw.createdAt,
    workflow: typeof raw.workflow === "string" ? raw.workflow : undefined,
    invocation:
      raw.invocation &&
      typeof raw.invocation === "object" &&
      typeof raw.invocation.entrypoint === "string" &&
      Array.isArray(raw.invocation.args) &&
      raw.invocation.args.every((arg) => typeof arg === "string")
        ? {
            entrypoint: raw.invocation.entrypoint,
            args: raw.invocation.args,
          }
        : undefined,
    prompts: raw.prompts,
  };
}

/** Local time as `YYYYMMDD-HHMMSS`, the timestamp that starts every run directory name. */
export function runTimestamp(now: Date = new Date()): string {
  return [
    now.getFullYear().toString(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("") + `-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
}

function createRunDir(): string {
  mkdirSync(RUN_ROOT_DIR, { recursive: true, mode: 0o700 });
  const timestamp = runTimestamp();
  // Random suffix (not just the EEXIST retry below) so concurrent `fit run` invocations on
  // different hosts — e.g. parallel CI matrix jobs — can't land on the same session id and
  // silently overwrite each other's S3 archive (both are keyed off this directory's basename).
  const base = `${timestamp}-${randomBytes(2).toString("hex")}`;

  for (let attempt = 1; ; attempt++) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const runDir = join(RUN_ROOT_DIR, `${base}${suffix}`);
    try {
      mkdirSync(runDir, { mode: 0o700 });
      return runDir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
  }
}

function createRunFilePathInDir(runDir: string, filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  const stem = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  const extension = dotIndex > 0 ? filename.slice(dotIndex) : "";

  for (let attempt = 1; ; attempt++) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const path = join(runDir, `${stem}${suffix}${extension}`);
    if (!existsSync(path)) {
      return path;
    }
  }
}

function createLogFile(runDir: string): string {
  return createRunFilePathInDir(runDir, "prompts.json");
}

function formatReplayResponse(kind: PromptKind, response: unknown): string {
  if (kind === "password") {
    return "[hidden]";
  }
  if (typeof response === "string") {
    return JSON.stringify(response);
  }
  return inspect(response, { depth: null, breakLength: Infinity });
}

function formatPromptResolution(mode: PromptSessionMode): string {
  switch (mode) {
    case "defaults":
      return "replay defaults";
    case "non-interactive":
      return "non-interactive";
    default:
      return "replay";
  }
}

export class PromptSession {
  private replayIndex = 0;
  private readonly usedPromptIds = new Set<string>();

  private constructor(
    private readonly mode: PromptSessionMode,
    public readonly runDir: string,
    public readonly logFile: string,
    private readonly createdAt: string,
    private workflow: string | undefined,
    private readonly invocation: ReplayInvocation | undefined,
    private readonly prompts: PromptLogEntry[],
    private readonly hooks: PromptSessionHooks,
  ) {}

  static fromArgv(argv: string[], hooks: PromptSessionHooks = {}, config: PromptSessionConfig = {}): PromptSession {
    const env = config.env ?? process.env;
    const entrypoint = config.entrypoint ?? process.argv[1];
    const { interactive, positionals } = extractInteractiveFlag(argv);
    const { replayRequested, replayDefaults, replayFile } = extractReplayFlag(positionals, env);
    const runDir = createRunDir();
    if (replayRequested && !replayFile) {
      throw new Error(
        `Missing replay log file. Usage: ${runScriptPrefix("replay")} <logfile> or ${runScriptPrefix("replay")} --defaults <logfile>`,
      );
    }
    if (replayFile) {
      const resolved = isAbsolute(replayFile) ? replayFile : resolve(process.cwd(), replayFile);
      const log = readPromptLog(resolved);
      fitCliInfo(`ARTIFACT_DIR: ${runDir}`);
      fitCliInfo(
        `${replayDefaults ? "Replaying prompt log as defaults" : "Replaying prompt log"}: ${resolved}\n`,
      );
      return new PromptSession(
        replayDefaults ? "defaults" : "replay",
        runDir,
        resolved,
        log.createdAt,
        log.workflow,
        log.invocation,
        log.prompts,
        hooks,
      );
    }

    const logFile = createLogFile(runDir);
    const createdAt = new Date().toISOString();
    const mode: PromptSessionMode =
      interactive || !defaultsToNonInteractive(entrypoint, env) ? "record" : "non-interactive";
    const session = new PromptSession(
      mode,
      runDir,
      logFile,
      createdAt,
      undefined,
      captureReplayInvocation(argv, entrypoint),
      [],
      hooks,
    );
    session.persist();
    fitCliInfo(`Artifacts from this run will be written to: ${runDir}`);
    if (mode === "non-interactive") {
      fitCliInfo("Running non-interactively with default answers.\n");
    }
    return session;
  }

  getWorkflow(): string | undefined {
    return this.workflow;
  }

  getInvocation(): ReplayInvocation | undefined {
    return this.invocation;
  }

  replaysStoredWorkflow(): boolean {
    return this.mode === "replay";
  }

  setWorkflow(workflow: string): void {
    this.workflow = workflow;
    if (this.mode === "record" || this.mode === "non-interactive") {
      this.persist();
    }
  }

  consumeLegacyWorkflowPrompt(workflow: string): void {
    if (this.mode !== "replay") {
      return;
    }

    const entry = this.prompts[this.replayIndex];
    if (entry?.kind === "select" && entry.response === workflow) {
      this.replayIndex++;
    }
  }

  async finishReplay(): Promise<void> {
    if (this.mode === "record" || this.mode === "non-interactive") {
      return;
    }

    if (this.mode === "defaults") {
      await this.handleUnusedReplayPrompts(this.prompts.filter((entry) => !this.usedPromptIds.has(entry.id)));
      return;
    }

    if (this.replayIndex >= this.prompts.length) {
      return;
    }

    await this.handleUnusedReplayPrompts(this.prompts.slice(this.replayIndex));
    this.replayIndex = this.prompts.length;
  }

  formatRunReminder(): string {
    return ["Run files:", `  ARTIFACT_DIR: ${this.runDir}`].join("\n");
  }

  async resolvePrompt<T>(
    id: string,
    kind: PromptKind,
    message: string,
    prompt: (replayDefault?: T) => Promise<T>,
    options: PromptResolveOptions<T> = {},
  ): Promise<T> {
    if (this.usedPromptIds.has(id)) {
      throw new Error(`Prompt id ${id} was used more than once in this run.`);
    }
    this.usedPromptIds.add(id);

    if (this.mode === "non-interactive") {
      if (!options.nonInteractiveDefault) {
        throw new Error(`Prompt ${id} does not support non-interactive mode; rerun with --interactive.`);
      }
      const response = await options.nonInteractiveDefault();
      const storedResponse = options.serializeResponse ? options.serializeResponse(response) : response;
      this.prompts.push({
        id,
        kind,
        message,
        response: storedResponse,
      });
      this.persist();
      console.log(`[${formatPromptResolution(this.mode)}] ${message}\n  -> ${formatReplayResponse(kind, storedResponse)}`);
      return response;
    }

    if (this.mode === "defaults") {
      const entry = this.findPromptById(id);
      if (!entry) {
        console.log(`[${formatPromptResolution(this.mode)}] No saved answer for ${id}; asking now.`);
        return prompt();
      }
      if (entry.kind !== kind) {
        console.log(`[${formatPromptResolution(this.mode)}] Saved answer for ${id} was recorded as ${entry.kind}, but the code now expects ${kind}. Asking now.`);
        return prompt();
      }
      const response = options.deserializeResponse ? options.deserializeResponse(entry.response) : (entry.response as T);
      console.log(`[${formatPromptResolution(this.mode)}] ${message}\n  -> ${formatReplayResponse(kind, entry.response)}`);
      return prompt(response);
    }

    if (this.mode === "replay") {
      const replayMatchIndex = this.findReplayPromptIndex(id);
      if (replayMatchIndex === undefined) {
        if (this.replayIndex < this.prompts.length) {
          await this.handleUnusedReplayPrompts(this.prompts.slice(this.replayIndex));
          this.replayIndex = this.prompts.length;
        }
        console.log(`[${formatPromptResolution(this.mode)}] No saved answer for ${id}; asking now.`);
        return prompt();
      }

      if (replayMatchIndex > this.replayIndex) {
        await this.handleUnusedReplayPrompts(this.prompts.slice(this.replayIndex, replayMatchIndex));
        this.replayIndex = replayMatchIndex;
      }

      const entry = this.prompts[this.replayIndex];
      if (!entry || entry.id !== id) {
        throw new Error(`Replay state error while resolving ${id}.`);
      }
      this.replayIndex++;

      if (entry.kind !== kind) {
        console.log(`[${formatPromptResolution(this.mode)}] Saved answer for ${id} was recorded as ${entry.kind}, but the code now expects ${kind}. Asking now.`);
        return prompt();
      }
      const response = options.deserializeResponse ? options.deserializeResponse(entry.response) : (entry.response as T);
      console.log(
        `[${formatPromptResolution(this.mode)}] ${message}\n  -> ${formatReplayResponse(kind, entry.response)}`,
      );
      return response;
    }

    const response = await prompt();
    this.prompts.push({
      id,
      kind,
      message,
      response: options.serializeResponse ? options.serializeResponse(response) : response,
    });
    this.persist();
    return response;
  }

  private findReplayPromptIndex(id: string): number | undefined {
    for (let index = this.replayIndex; index < this.prompts.length; index++) {
      if (this.prompts[index]?.id === id) {
        return index;
      }
    }
    return undefined;
  }

  private findPromptById(id: string): PromptLogEntry | undefined {
    return this.prompts.find((entry) => entry.id === id);
  }

  private async handleUnusedReplayPrompts(entries: readonly PromptLogEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const action = this.hooks.onUnusedReplayPrompts
      ? await this.hooks.onUnusedReplayPrompts(entries)
      : await prompts.select<"continue" | "exit">({
          message:
            entries.length === 1
              ? `Replay log contains a saved answer for ${entries[0].id} that is no longer used. What do you want to do?`
              : `Replay log contains ${entries.length} saved answers that are no longer used. What do you want to do?`,
          choices: [
            { name: "Ignore them and continue", value: "continue" },
            { name: "Stop replay so I can review the log", value: "exit" },
          ],
        });

    if (action === "exit") {
      throw new Error("Replay stopped because the log contains answers for prompts that are no longer used.");
    }
  }

  private persist(): void {
    writeFileSync(
      this.logFile,
      `${JSON.stringify(
        {
          version: 1,
          createdAt: this.createdAt,
          workflow: this.workflow,
          invocation: this.invocation,
          prompts: this.prompts,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }
}

let activePromptSession: PromptSession | undefined;

export function ensurePromptSession(argv: string[] = process.argv.slice(2)): PromptSession {
  if (!activePromptSession) {
    activePromptSession = PromptSession.fromArgv(argv);
  }
  return activePromptSession;
}

export function ensureRunDir(argv: string[] = process.argv.slice(2)): string {
  return ensurePromptSession(argv).runDir;
}

export function createRunFilePath(filename: string, argv: string[] = process.argv.slice(2)): string {
  const runDir = ensureRunDir(argv);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  return createRunFilePathInDir(runDir, filename);
}

export interface DefinitionRunPath {
  instanceIndex: number;
  clusterIndex?: number;
  sessionIndex?: number;
  runIndex?: number;
  clusterlessSession?: boolean;
  /** Human-readable directory name overrides for each level of the artifact tree.
   *  When set, these replace the numeric fallbacks (e.g. `aws1` instead of `0`). */
  dirSegments?: {
    instance?: string;
    cluster?: string;
    session?: string;
    run?: string;
  };
}

/**
 * Sanitize a label for use as a filesystem directory segment.
 * GitHub Actions artifact upload rejects colons (and other chars illegal on Windows NTFS).
 * Also strips path separators and collapses runs of dots, so a label can never smuggle in
 * a `..` or `/` and traverse outside the intended run/instance/cluster/session directory.
 * Display labels (log prefixes, table output) keep their colons; call this only when
 * building actual file-system paths.
 */
export function sanitizePathSeg(seg: string): string {
  return seg.replace(/[/\\:]/g, "-").replace(/\.\.+/g, "-");
}

/** Absolute path to the artifact directory for instance N (e.g. `{runDir}/instances/aws1`).
 *  Accepts a full {@link DefinitionRunPath} (uses `dirSegments.instance` when present) or a
 *  plain index for callers that don't have label context. */
export function instanceRunDir(pathOrIndex: DefinitionRunPath | number, runDir: string = ensureRunDir()): string {
  if (typeof pathOrIndex === "number") {
    return join(runDir, "instances", String(pathOrIndex));
  }
  const seg = sanitizePathSeg(pathOrIndex.dirSegments?.instance ?? String(pathOrIndex.instanceIndex));
  return join(runDir, "instances", seg);
}

/** Absolute path to the artifact directory for a cluster lifetime. */
export function clusterRunDir(path: DefinitionRunPath, runDir: string = ensureRunDir()): string {
  const seg = sanitizePathSeg(path.dirSegments?.cluster ?? String(path.clusterIndex ?? 0));
  return join(instanceRunDir(path, runDir), "clusters", seg);
}

/** Absolute path to the artifact directory for a session lifetime. */
export function sessionRunDir(path: DefinitionRunPath, runDir: string = ensureRunDir()): string {
  const seg = sanitizePathSeg(path.dirSegments?.session ?? String(path.sessionIndex));
  if (path.clusterlessSession) {
    if (path.sessionIndex === undefined) {
      throw new Error("clusterless session paths require sessionIndex.");
    }
    return join(instanceRunDir(path, runDir), "clusterless-sessions", seg);
  }
  if (path.clusterIndex === undefined || path.sessionIndex === undefined) {
    throw new Error("cluster session paths require clusterIndex and sessionIndex.");
  }
  return join(clusterRunDir(path, runDir), "sessions", seg);
}

/** Absolute path to the artifact directory for a run. */
export function runRunDir(path: DefinitionRunPath, runDir: string = ensureRunDir()): string {
  if (path.runIndex === undefined) {
    throw new Error("run paths require runIndex.");
  }
  const seg = sanitizePathSeg(path.dirSegments?.run ?? String(path.runIndex));
  return join(sessionRunDir(path, runDir), "runs", seg);
}

/** Absolute path to the internal-files directory for an instance. */
export function instanceInternalRunDir(pathOrIndex: DefinitionRunPath | number, runDir: string = ensureRunDir()): string {
  return join(instanceRunDir(pathOrIndex, runDir), "_internal");
}
