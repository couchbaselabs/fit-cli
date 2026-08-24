import { basename, relative } from "node:path";

/**
 * Decide whether to emit ANSI colour. Precedence:
 *   FORCE_COLOR set & not "0"  -> on   (covers GHA/CI, which have no TTY but
 *                                       whose log viewers still render ANSI)
 *   NO_COLOR set               -> off  (https://no-color.org)
 *   GITHUB_ACTIONS === "true"  -> on   (GHA renders ANSI despite no TTY)
 *   otherwise                  -> stderr.isTTY
 *
 * FORCE_COLOR deliberately overrides NO_COLOR so the test runner can force a
 * deterministic result even on a dev box that exports NO_COLOR.
 */
export function colourEnabled(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stderr.isTTY ?? false,
): boolean {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  if (env.NO_COLOR !== undefined) return false;
  if (env.GITHUB_ACTIONS === "true") return true;
  return isTTY;
}

const colourOn = colourEnabled();
const RESET = colourOn ?"[0m" : "";
const RED = colourOn ? "[31m" : "";
const YELLOW = colourOn ? "[33m" : "";
/** Pastel blue for echoed commands (`$ ...`). */
const BLUE = colourOn ? "[94m" : "";

const baseStdoutWrite = process.stdout.write.bind(process.stdout);
const baseStderrWrite = process.stderr.write.bind(process.stderr);

let consoleFormattingInstalled = false;
let timestampProvider = (): string => new Date().toTimeString().slice(0, 8);
let rawTerminalWriteDepth = 0;
/** When > 0, lines are rendered in soft grey with the prefix replaced by spaces. */
let greyIndentDepth = 0;
/** When > 0, lines keep the `[HH:MM:SS·ctx]` prefix but content is rendered in soft grey. */
let greyTextDepth = 0;

/** Soft grey (ANSI 90), for the unobtrusive separators in the log-line prefix. */
const DIM = colourOn ? "[90m" : "";
/** The dot that separates the prefix's timestamp and context segments. */
const PREFIX_SEPARATOR = "·";

export interface LogContext {
  /** Global run progress, e.g. "5/13", counting across every instance/cluster/session/run in the definition. Set at the start of each iteration. */
  progress?: string;
  /** Execution target label, e.g. "local" or "aws1". Set once the target is acquired. */
  env?: string;
  /** Cluster label, e.g. "cbdino1". Set once a cluster is allocated/resumed. */
  cluster?: string;
  /** Performer (session) label, e.g. "java:main". Set at the start of each iteration. */
  performer?: string;
  /** Run label, e.g. "functional" or a preset name. Set at the start of each iteration. */
  run?: string;
}

let logContext: LogContext = {};

/** Merge new fields into the running log context (e.g. as each run phase starts). */
export function setLogContext(partial: Partial<LogContext>): void {
  logContext = { ...logContext, ...partial };
}

/** Remove specific fields from the log context (e.g. pop session/sdk after a performer stops). */
export function popLogContext(...fields: (keyof LogContext)[]): void {
  const next = { ...logContext };
  for (const field of fields) {
    delete next[field];
  }
  logContext = next;
}

/** Reset the log context entirely (e.g. between execution cycles). */
export function clearLogContext(): void {
  logContext = {};
}

type StreamWrite = typeof process.stdout.write;

export interface TimestampedChunk {
  text: string;
  atLineStart: boolean;
}

// Matches a full ANSI CSI escape sequence (ESC [ ... <final byte>), e.g. the
// `cursorShow` (`[?25h`) that @inquirer/core appends after the trailing
// newline when a prompt resolves. These are invisible on the terminal and
// must not count as "content" when deciding whether we're at line start.
// eslint-disable-next-line no-control-regex
const ANSI_CSI_SEQUENCE = /\u001B\[[0-9;?]*[A-Za-z]/g;

function advanceLineStart(text: string, atLineStart: boolean): boolean {
  const visible = text.replace(ANSI_CSI_SEQUENCE, "");
  let nextLineStart = atLineStart;
  for (const char of visible) {
    if (char !== "\n") {
      nextLineStart = false;
      continue;
    }
    nextLineStart = true;
  }
  return nextLineStart;
}

function stringify(arg: unknown): string {
  if (arg instanceof Error) {
    // In compiled Bun binaries, arg.stack can render as just the bare error
    // name (e.g. "Error") with the message dropped, so a truthy stack isn't
    // enough to trust it — fall back to the message when it isn't included.
    if (arg.stack?.includes(arg.message)) return arg.stack;
    return arg.message || arg.stack || String(arg);
  }
  return String(arg);
}

/**
 * Optional first argument to the warn/error helpers. When a `classification` is
 * given it's appended to the label so the line reads `FitCliWarn/FatalToCluster:`
 * (or `FitCliError/FatalToRun:`), making the failure's severity/scope visible at
 * a glance. Kept as a plain string so this FIT-agnostic logging layer doesn't
 * depend on the FIT `FailureClassification` type.
 */
export interface FitCliLogOptions {
  classification?: string;
}

function isLogOptions(arg: unknown): arg is FitCliLogOptions {
  return (
    typeof arg === "object" &&
    arg !== null &&
    !Array.isArray(arg) &&
    !(arg instanceof Error) &&
    "classification" in arg
  );
}

/** Peel an optional leading {@link FitCliLogOptions} off the variadic log args. */
function splitLogArgs(args: unknown[]): { classification?: string; rest: unknown[] } {
  if (args.length > 0 && isLogOptions(args[0])) {
    const { classification } = args[0];
    return { ...(classification ? { classification } : {}), rest: args.slice(1) };
  }
  return { rest: args };
}

function formatFitCliMessage(
  label: "FitCliError" | "FitCliWarn",
  color: string,
  args: unknown[],
  classification?: string,
): string {
  const message = args.map(stringify).join(" ").trimEnd();
  const leadingNewlines = message.match(/^\n*/)?.[0] ?? "";
  const body = message
    .slice(leadingNewlines.length)
    .replace(/^(?:FitCliError|FitCliWarn)(?:\/\w+)?:\s*/, "")
    .replace(/^(?:✗|→)\s*/, "");
  const fullLabel = classification ? `${label}/${classification}` : label;
  // For multi-line bodies (e.g. boxed banners) put the label on its own line, so
  // the inline prefix doesn't shift only the first line right and break alignment.
  const separator = body.includes("\n") ? "\n" : " ";
  return `${leadingNewlines}${fullLabel}:${separator}${color}${body}${RESET}`;
}

export function formatFitCliError(...args: unknown[]): string {
  const { classification, rest } = splitLogArgs(args);
  return formatFitCliMessage("FitCliError", RED, rest, classification);
}

export function formatFitCliWarn(...args: unknown[]): string {
  const { classification, rest } = splitLogArgs(args);
  return formatFitCliMessage("FitCliWarn", YELLOW, rest, classification);
}

export function formatTimestampedChunk(
  text: string,
  atLineStart: boolean = true,
  getTimestamp: () => string = timestampProvider,
  getContext: () => LogContext = () => logContext,
  colour: boolean = false,
): TimestampedChunk {
  // Colour is gated to the terminal path so ANSI codes never leak into the log
  // files (which call this with colour off). The dot separator itself is always
  // applied — it's structural, not styling.
  const separator = colour ? `${DIM}${PREFIX_SEPARATOR}${RESET}` : PREFIX_SEPARATOR;
  let formatted = "";
  let nextLineStart = atLineStart;
  for (const char of text) {
    if (nextLineStart && char !== "\n") {
      const ctx = getContext();
      const segments = [ctx.progress, ctx.env, ctx.cluster, ctx.performer, ctx.run].filter(
        (segment): segment is string => Boolean(segment),
      );
      formatted += `[${[getTimestamp(), ...segments].join(separator)}] `;
      nextLineStart = false;
    }
    formatted += char;
    if (char === "\n") {
      nextLineStart = true;
    }
  }
  return { text: formatted, atLineStart: nextLineStart };
}

/**
 * Compute how many characters wide the plain (no-ANSI) prefix would be right now,
 * so we can indent grey-mode lines to align with normal log output.
 */
function currentPrefixWidth(
  getTimestamp: () => string = () => timestampProvider(),
  getContext: () => LogContext = () => logContext,
): number {
  const ts = getTimestamp();
  const ctx = getContext();
  const segments = [ctx.progress, ctx.env, ctx.cluster, ctx.performer, ctx.run].filter(
    (s): s is string => Boolean(s),
  );
  return `[${[ts, ...segments].join(PREFIX_SEPARATOR)}] `.length;
}

/**
 * Format a chunk for grey-indented mode: replace the timestamp prefix with spaces
 * of equal width and wrap each line in DIM/RESET. Used for file content echoes
 * and LogType1 subprocess output so the content is readable and copy-pasteable
 * without the timestamp noise, while still being spatially aligned.
 *
 * Only called on the terminal path — colour=false callers (log files) skip this
 * and use the normal timestamp formatter.
 */
function formatGreyIndentedChunk(
  text: string,
  atLineStart: boolean,
  getTimestamp: () => string = () => timestampProvider(),
  getContext: () => LogContext = () => logContext,
): TimestampedChunk {
  let formatted = "";
  let nextLineStart = atLineStart;
  let inGreyLine = false;
  for (const char of text) {
    if (nextLineStart && char !== "\n") {
      const width = currentPrefixWidth(getTimestamp, getContext);
      formatted += " ".repeat(width) + DIM;
      inGreyLine = true;
      nextLineStart = false;
    }
    if (char === "\n") {
      if (inGreyLine) {
        formatted += RESET;
        inGreyLine = false;
      }
      formatted += "\n";
      nextLineStart = true;
    } else {
      formatted += char;
    }
  }
  if (inGreyLine) {
    formatted += RESET;
  }
  return { text: formatted, atLineStart: nextLineStart };
}

/**
 * Format a chunk keeping the `[HH:MM:SS·ctx]` timestamp prefix intact but
 * rendering the content text in DIM grey. Used for proof-of-life / heartbeat
 * lines that should stay clearly timestamped but visually secondary.
 *
 * Only called on the terminal path — log files use the normal timestamp formatter.
 */
function formatDimTextChunk(
  text: string,
  atLineStart: boolean,
  getTimestamp: () => string = () => timestampProvider(),
  getContext: () => LogContext = () => logContext,
): TimestampedChunk {
  const separator = `${DIM}${PREFIX_SEPARATOR}${RESET}`;
  let formatted = "";
  let nextLineStart = atLineStart;
  let inDimContent = false;
  for (const char of text) {
    if (nextLineStart && char !== "\n") {
      const ctx = getContext();
      const segments = [ctx.env, ctx.cluster, ctx.performer, ctx.run].filter(
        (s): s is string => Boolean(s),
      );
      formatted += `[${[getTimestamp(), ...segments].join(separator)}] ${DIM}`;
      inDimContent = true;
      nextLineStart = false;
    }
    if (char === "\n") {
      if (inDimContent) {
        formatted += RESET;
        inDimContent = false;
      }
      formatted += "\n";
      nextLineStart = true;
    } else {
      formatted += char;
    }
  }
  if (inDimContent) formatted += RESET;
  return { text: formatted, atLineStart: nextLineStart };
}

function installTimestampedStreamWrite(stream: NodeJS.WriteStream, original: StreamWrite): void {
  let atLineStart = true;
  stream.write = function (
    chunk: Parameters<StreamWrite>[0],
    encoding?: Parameters<StreamWrite>[1],
    callback?: Parameters<StreamWrite>[2],
  ): boolean {
    const text = typeof chunk === "string"
      ? chunk
      : Buffer.from(chunk).toString(typeof encoding === "string" ? encoding : undefined);

    let textToEmit: string;
    if (rawTerminalWriteDepth > 0) {
      atLineStart = advanceLineStart(text, atLineStart);
      if (typeof encoding === "function") {
        return original(chunk, encoding);
      }
      if (callback) {
        return original(chunk, encoding, callback);
      }
      if (encoding) {
        return original(chunk, encoding);
      }
      return original(chunk);
    } else if (greyIndentDepth > 0) {
      const formatted = formatGreyIndentedChunk(text, atLineStart);
      atLineStart = formatted.atLineStart;
      textToEmit = formatted.text;
    } else if (greyTextDepth > 0) {
      const formatted = formatDimTextChunk(text, atLineStart);
      atLineStart = formatted.atLineStart;
      textToEmit = formatted.text;
    } else {
      const formatted = formatTimestampedChunk(text, atLineStart, timestampProvider, () => logContext, true);
      atLineStart = formatted.atLineStart;
      textToEmit = formatted.text;
    }

    if (typeof encoding === "function") {
      return original(textToEmit, encoding);
    }
    if (callback) {
      return original(textToEmit, encoding, callback);
    }
    if (encoding) {
      return original(textToEmit, encoding);
    }
    return original(textToEmit);
  } as StreamWrite;
}

export async function withRawTerminalWrites<T>(operation: () => Promise<T>): Promise<T> {
  rawTerminalWriteDepth++;
  try {
    return await operation();
  } finally {
    rawTerminalWriteDepth--;
  }
}

/**
 * Write text to stdout verbatim, without the per-line `[HH:MM:SS]` timestamp
 * prefix — for dumping file contents (e.g. a generated definition) into the
 * terminal, where the timestamps would just be noise in front of the file.
 */
export function printWithoutTimestamps(text: string): void {
  rawTerminalWriteDepth++;
  try {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  } finally {
    rawTerminalWriteDepth--;
  }
}

/**
 * Print file content to stdout in soft grey with the timestamp prefix replaced by
 * spaces, so the output is aligned with normal log lines and copy-pasteable
 * without timestamp noise. On non-TTY output (log files) the session log still
 * timestamps each line normally.
 */
export function printFileContent(text: string): void {
  greyIndentDepth++;
  try {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  } finally {
    greyIndentDepth--;
  }
}

/**
 * Enter grey-indented output mode for LogType1 subprocess output. While active,
 * lines written to stdout/stderr appear in soft grey with the timestamp prefix
 * replaced by spaces. Call stopGreyIndentedOutput() when the subprocess finishes.
 */
export function startGreyIndentedOutput(): void {
  greyIndentDepth++;
}

/** Leave grey-indented output mode (counterpart to startGreyIndentedOutput). */
export function stopGreyIndentedOutput(): void {
  greyIndentDepth = Math.max(0, greyIndentDepth - 1);
}

/**
 * Enter grey-text output mode. While active, lines keep the full `[HH:MM:SS·ctx]`
 * prefix but the content is rendered in soft grey — for proof-of-life / heartbeat
 * lines that should stay clearly timestamped but visually secondary.
 */
export function startGreyTextOutput(): void {
  greyTextDepth++;
}

/** Leave grey-text output mode (counterpart to startGreyTextOutput). */
export function stopGreyTextOutput(): void {
  greyTextDepth = Math.max(0, greyTextDepth - 1);
}

/**
 * Quote a single token for display so the echoed command line stays readable and
 * unambiguous: bare tokens are left alone, anything with whitespace or quotes is
 * wrapped in single quotes. This is for *display only* — use posixQuote when the
 * string is actually going to a shell.
 */
function displayQuote(token: string): string {
  if (token !== "" && !/[\s'"\\]/.test(token)) {
    return token;
  }
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/** Render a command and its args as one readable, shell-ish line. */
export function formatCommandLine(command: string, args: readonly string[] = []): string {
  return [command, ...args].map(displayQuote).join(" ");
}

/** Tag a command line with where it runs, e.g. `cbdinocluster ps  (on ubuntu@1.2.3.4)`. */
export function commandOn(line: string, where: string): string {
  return `${line}  (on ${where})`;
}

/**
 * Reconstruct how this fit-cli process was actually started, for the
 * "Ran with:" line printed at the top of every run. Called before `main.ts`'s
 * command dispatcher splices the subcommand token out of `process.argv`, so
 * `argv.slice(2)` below always still holds it.
 *
 * `bun run <script>` sets `npm_lifecycle_event` to the package.json script
 * name — using it (rather than the resolved script path Bun put in argv[1])
 * means this matches exactly what the user typed, e.g. `bun run wizard`
 * rather than `bun src/fit/main/main.ts wizard`. Mini CLI tools invoked
 * directly (`bun src/cluster/.../foo.ts`, no package.json script) have no
 * such env var, so those fall back to the resolved script path.
 */
export function invocationLine(): string {
  if (isFitBinary()) {
    return formatCommandLine("fit", process.argv.slice(2));
  }
  const scriptName = process.env.npm_lifecycle_event;
  if (scriptName) {
    // For scripts that bake the subcommand into the package.json entry itself
    // (e.g. "wizard": "bun src/fit/main/main.ts wizard"), argv[2] still holds
    // that same token at print time — drop it so it isn't shown twice.
    const rest = process.argv.slice(2);
    const args = rest[0] === scriptName ? rest.slice(1) : rest;
    return formatCommandLine("bun", ["run", scriptName, ...args]);
  }
  const scriptPath = process.argv[1] ? relative(process.cwd(), process.argv[1]) : "";
  return formatCommandLine("bun", [scriptPath, ...process.argv.slice(2)]);
}

let invocationPrinted = false;

/**
 * Print the "Ran with:" line exactly once per process. Called both early in
 * `main.ts` (before platform checks, so it survives an early failure there)
 * and inside `runCli()` (for mini-CLI scripts invoked directly, bypassing
 * `main.ts` entirely) — the guard keeps the two call sites from double-printing
 * when a command goes through both.
 */
export function printInvocationOnce(): void {
  if (invocationPrinted) return;
  invocationPrinted = true;
  fitCliInfo(`Ran with: ${invocationLine()}`);
}

/** Render a byte count as a short human-readable size, e.g. `4.2 MB`. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Echo the command about to run, as `$ <line>`. The single place fit-cli prints
 * "here's what I'm about to do" — every command-runner funnels through here so
 * the behaviour (and the format) lives in exactly one spot.
 */
export function echoCommand(line: string): void {
  console.log(`${BLUE}$ ${line}${RESET}`);
}

export function setFitCliTimestampProvider(provider: (() => string) | undefined): void {
  timestampProvider = provider ?? (() => new Date().toTimeString().slice(0, 8));
}

/**
 * Print an informational banner (session/artifact notices, role-assumption progress,
 * run summaries) to stderr — routed through process.stderr.write (looked up at call
 * time) so it still gets the timestamp prefix and session-log tee, same reasoning as
 * fitCliError(), but without wrapping the line in a misleading "FitCliError:" label.
 * Reserve console.error/fitCliError for things that are actually errors.
 */
export function fitCliInfo(...args: unknown[]): void {
  process.stderr.write(`${args.map(stringify).join(" ")}\n`);
}

export function fitCliError(...args: unknown[]): void {
  // Route through process.stderr.write (looked up at call time) rather than the
  // native console.error: Bun's console.error writes straight to fd 2, bypassing
  // the session-log tee installed on process.stderr.write, so error lines would
  // never reach session.info.log / session.debug.log. Same reasoning as the
  // console.log reroute in installFitCliConsoleFormatting().
  process.stderr.write(`${formatFitCliError(...args)}\n`);
}

export function fitCliWarn(...args: unknown[]): void {
  process.stderr.write(`${formatFitCliWarn(...args)}\n`);
}

export function installFitCliConsoleFormatting(): void {
  if (consoleFormattingInstalled) {
    return;
  }
  installTimestampedStreamWrite(process.stdout, baseStdoutWrite);
  installTimestampedStreamWrite(process.stderr, baseStderrWrite);
  // Bun's console.log writes directly to fd 1, bypassing process.stdout.write and
  // therefore bypassing the session-log monkey-patch. Replace it so log output is
  // routed through process.stdout.write (looked up at call time, not install time,
  // so the session log tee installed later by startSessionLog() picks it up).
  console.log = (...args: unknown[]) => process.stdout.write(args.map(stringify).join(" ") + "\n");
  // console.error/console.warn must route through process.stderr.write for the
  // same reason as console.log above — see fitCliError() for the full rationale.
  console.error = (...args: unknown[]) => fitCliError(...args);
  console.warn = (...args: unknown[]) => fitCliWarn(...args);
  consoleFormattingInstalled = true;
}

/**
 * True when running as the compiled `fit` binary (bun build --compile).
 * Use process.execPath, which resolves to the actual binary path in both modes:
 * the compiled binary (basename "fit" / "fit-linux-x64" etc.) vs the bun runtime
 * (basename "bun") when running via `bun run`. Note process.argv[0] is NOT usable
 * here: in a Bun standalone executable it is the literal string "bun", not the
 * binary path. Use this to tailor guidance messages telling the user how to re-run.
 */
export function isFitBinary(): boolean {
  const bin = basename(process.execPath ?? "");
  return bin === "fit" || bin.startsWith("fit-");
}

/**
 * Return the canonical invocation for a bun script, adapting to whether the
 * user is running as the compiled `fit` binary or via `bun run`.
 *   scriptInvocation("config") → "fit config"  OR  "bun run config"
 */
function scriptInvocation(script: string): string {
  return isFitBinary() ? `fit ${script}` : `bun run ${script}`;
}

/**
 * Return the prefix for running a definition file, adjusted for whether the
 * user is running as the compiled `fit` binary or via `bun run`.
 *   fit run definition [flags] <file>   ≡   bun run run definition [flags] <file>
 */
export function runDefinitionPrefix(): string {
  return `${scriptInvocation("run")} definition`;
}

/**
 * Return the invocation prefix for a sub-command script, adjusted for whether
 * the user is running as the compiled `fit` binary or via bun.
 *   fit config edit   ≡   bun run config edit
 */
export function runScriptPrefix(script: string): string {
  return scriptInvocation(script);
}
