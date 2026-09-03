import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactFromPath,
  formatArtifactsSection,
  formatCallToActionBanner,
  formatDetailsSection,
  combineRunOutputs,
  reconcileArtifactsWithDir,
  worstFailureShouldExitNonZero,
  formatFailureSummaryLine,
  producedOnlyBoilerplate,
  SESSION_LOG_NAME,
  type RunOutput,
} from "./artifacts.js";
import { installFitCliConsoleFormatting, printInvocationOnce, fitCliError, fitCliInfo, runScriptPrefix } from "./fit-cli-log.js";
import { startSessionLog, startDebugLog } from "./proc.js";
import { ensurePromptSession } from "./replay.js";
import {
  emitGhaArtifactNotice,
  appendArtifactFetchToGhaSummary,
  appendFailureSnippetToGhaSummary,
  type FailureHeading,
} from "../../fit/util/gha.js";
import { maybeUploadRunArtifacts } from "../../fit/util/aws/upload-run-artifacts.js";

/**
 * Shared plumbing for the small per-step CLIs. Every file under steps/ exports
 * its step function(s) for the wizard to use, and also has a `if (isMain(...))`
 * block so it can be run on its own for debugging and development iteration.
 */

/**
 * Print the end-of-run summary: the artifact table (reconciled against the run
 * dir, so files captured during the run show up even when we have no explicit
 * artifact list), the details section, any call-to-action banners, and the GHA
 * notice. On GHA, also uploads artifacts to S3 automatically. Factored out so
 * it renders on BOTH the success and failure paths — a thrown error (including
 * one from teardown after a completed run) must not swallow the artifact table
 * the user needs to debug.
 */
async function renderRunSummary(
  runDir: string,
  runOutput: RunOutput,
  context: { sessionTail: () => string; uncaughtError?: unknown },
): Promise<void> {
  // Grabbed first: from the next line on, the terminal output is the artifact table and
  // the zip/upload chatter, not whatever went wrong.
  const sessionTail = context.sessionTail();

  const artifacts = reconcileArtifactsWithDir(runDir, runOutput.artifacts);
  const sections = [formatArtifactsSection(runDir, artifacts), formatDetailsSection(runOutput.details)].filter(Boolean);
  const summaryOutput = sections.join("\n\n") || undefined;
  if (summaryOutput) {
    fitCliInfo(`\n${summaryOutput}`);
  }
  for (const detail of runOutput.details ?? []) {
    if (detail.callToAction) {
      fitCliInfo(`\n${formatCallToActionBanner(detail.label, detail.value)}`);
    }
  }

  const heading = failureHeading(runOutput, context.uncaughtError);

  // A bookkeeping command that succeeded has nothing worth uploading, and a second
  // "Run artifacts" block in the job summary is just noise. It still uploads when it
  // fails, because then the logs are the only record of why.
  if (!heading && producedOnlyBoilerplate(artifacts)) {
    return;
  }

  const s3Uri = await maybeUploadRunArtifacts(runDir);
  if (!s3Uri) {
    fitCliInfo(`\nTo upload run artifacts to S3 (optional):\n  ${runScriptPrefix("archive")} s3-upload --zip ${runDir} s3://fit-cli/runs/`);
  } else {
    appendArtifactFetchToGhaSummary(s3Uri);
  }
  emitGhaArtifactNotice(s3Uri ?? undefined);

  // Last of the writers that prepend, so the failure lands above the artifacts block and
  // is the first thing on the summary page.
  if (heading) {
    appendFailureSnippetToGhaSummary(heading, sessionTail);
  }
}

/**
 * How to title the failure block, or undefined when the run didn't fail. Prefers the
 * recorded failure — it carries the classification and the standardised position label —
 * and falls back to a thrown error, which is what a failure before any run produces.
 */
function failureHeading(runOutput: RunOutput, uncaughtError: unknown): FailureHeading | undefined {
  const { worstFailure } = runOutput;
  if (worstFailure) {
    return {
      classification: worstFailure.classification,
      message: worstFailure.message,
      label: worstFailure.context.label,
    };
  }
  if (uncaughtError !== undefined) {
    return { message: uncaughtError instanceof Error ? uncaughtError.message : renderErrorValue(uncaughtError) };
  }
  return undefined;
}

/** True when the module at `metaUrl` is the script node/tsx was invoked with. */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entry);
  } catch {
    // In Bun compiled binaries, import.meta.url is a virtual /$bunfs/ path
    // that can't be resolved on disk — fall back to false.
    return false;
  }
}

/**
 * Render an arbitrary error property for display. Strings pass through; anything
 * else is JSON, falling back to String() for values JSON.stringify rejects — some
 * error properties (e.g. Bun's source-mapped stack frames) are cyclic, and the
 * formatter must not itself crash and hide the real error.
 *
 * Not for Errors: their `message`/`stack` are non-enumerable, so JSON.stringify
 * flattens them to `{}`. Callers holding a possible Error use String() instead.
 */
function renderErrorValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Format an uncaught error for the final terminal line: the stack trace (which
 * includes the message) when available, plus any AWS SDK error metadata
 * (request id, service error code) that isn't part of `.message` — AWS SDK v3
 * collapses unmodeled service exceptions down to a bare "UnknownError" message,
 * so the metadata is often the only clue to what actually failed.
 */
export function formatUncaughtError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.stack ?? err.message];
  if (err.cause !== undefined) {
    parts.push(`cause: ${err.cause instanceof Error ? String(err.cause) : renderErrorValue(err.cause)}`);
  }
  // AWS SDK v3 errors carry extra own-enumerable properties (name, $metadata, $fault, Code,
  // __type, etc.) beyond the standard Error shape — dump anything present rather than
  // guessing which fields a given service/exception happens to use, since unmodeled service
  // exceptions can otherwise surface as a bare "Error" with no message and no clue why.
  const skip = new Set(["stack", "message", "cause"]);
  const extra = Object.getOwnPropertyNames(err)
    .filter((key) => !skip.has(key))
    .map((key) => [key, (err as unknown as Record<string, unknown>)[key]] as const)
    .filter(([, value]) => value !== undefined);
  for (const [key, value] of extra) {
    parts.push(`${key}: ${renderErrorValue(value)}`);
  }
  return parts.join("\n");
}

/**
 * Run a step's CLI entry point with consistent error handling: a clean Ctrl-C /
 * Esc from @inquirer throws ExitPromptError and exits quietly, anything else
 * prints and exits non-zero.
 */
export function runCli(main: () => Promise<void | Partial<RunOutput>>): void {
  installFitCliConsoleFormatting();
  printInvocationOnce();
  const promptSession = ensurePromptSession(process.argv.slice(2));
  const sessionLog = startSessionLog(join(promptSession.runDir, SESSION_LOG_NAME));
  const debugLog = startDebugLog(join(promptSession.runDir, "session.debug.log"));
  const sessionLogArtifact = artifactFromPath(
    sessionLog.path,
    "Terminal output log for this fit-cli session",
    promptSession.runDir,
  );
  const debugLogArtifact = artifactFromPath(
    debugLog.path,
    "Full command I/O log (includes captured stdout/stderr not shown in terminal)",
    promptSession.runDir,
  );
  const logArtifacts = [sessionLogArtifact, debugLogArtifact];
  let runOutput: RunOutput | undefined;
  // renderRunSummary uploads to S3 and prepends a step-summary block each call, so it
  // must run at most once even if the success branch throws after already rendering
  // (e.g. in worstFailureShouldExitNonZero) and control falls through to .catch.
  let summaryRendered = false;
  const renderRunSummaryOnce = async (uncaughtError?: unknown) => {
    if (summaryRendered) return;
    summaryRendered = true;
    await renderRunSummary(promptSession.runDir, runOutput ?? { artifacts: logArtifacts, details: [] }, {
      sessionTail: sessionLog.tail,
      uncaughtError,
    });
  };
  Promise.resolve()
    .then(() => main())
    .then((result) => {
      runOutput = combineRunOutputs(result ?? undefined, { artifacts: logArtifacts });
      return promptSession.finishReplay();
    })
    .then(async () => {
      await renderRunSummaryOnce();
      if (runOutput?.worstFailure && worstFailureShouldExitNonZero(runOutput.worstFailure)) {
        fitCliError(formatFailureSummaryLine(runOutput.worstFailure, runOutput.failureCount ?? 1));
        await Promise.all([sessionLog.flush(), debugLog.flush()]);
        process.exit(1);
      }
    })
    .catch(async (err) => {
      if (err instanceof Error && err.name === "ExitPromptError") {
        fitCliInfo("\nCancelled.");
        await Promise.all([sessionLog.flush(), debugLog.flush()]);
        process.exit(0);
      }
      // A thrown error skips the success branch, but the user still needs the
      // artifact table (and S3 upload) to debug — so render the summary here too,
      // falling back to whatever artifacts we have (at least the session/debug
      // logs; reconcileArtifactsWithDir discovers the rest from the run dir).
      await renderRunSummaryOnce(err);
      console.error(formatUncaughtError(err));
      // Flush tee'd logs before exiting so the final error line is persisted.
      await Promise.all([sessionLog.flush(), debugLog.flush()]);
      process.exit(1);
    });
}
