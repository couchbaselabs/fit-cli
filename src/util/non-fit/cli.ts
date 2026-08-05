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
  type RunOutput,
} from "./artifacts.js";
import { installFitCliConsoleFormatting, printInvocationOnce, fitCliError, runScriptPrefix } from "./fit-cli-log.js";
import { startSessionLog, startDebugLog } from "./proc.js";
import { ensurePromptSession } from "./replay.js";
import { emitGhaArtifactNotice, appendArtifactFetchToGhaSummary } from "../../fit/util/gha.js";
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
async function renderRunSummary(runDir: string, runOutput: RunOutput): Promise<void> {
  const sections = [
    formatArtifactsSection(runDir, reconcileArtifactsWithDir(runDir, runOutput.artifacts)),
    formatDetailsSection(runOutput.details),
  ].filter(Boolean);
  const summaryOutput = sections.join("\n\n") || undefined;
  if (summaryOutput) {
    console.log(`\n${summaryOutput}`);
  }
  for (const detail of runOutput.details ?? []) {
    if (detail.callToAction) {
      console.log(`\n${formatCallToActionBanner(detail.label, detail.value)}`);
    }
  }
  const s3Uri = await maybeUploadRunArtifacts(runDir);
  if (!s3Uri) {
    console.log(`\nTo upload run artifacts to S3 (optional):\n  ${runScriptPrefix("archive")} s3-upload --zip ${runDir} s3://fit-cli/runs/`);
  } else {
    appendArtifactFetchToGhaSummary(s3Uri);
  }
  emitGhaArtifactNotice(s3Uri ?? undefined);
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
 * Format an uncaught error for the final terminal line: the stack trace (which
 * includes the message) when available, plus any AWS SDK error metadata
 * (request id, service error code) that isn't part of `.message` — AWS SDK v3
 * collapses unmodeled service exceptions down to a bare "UnknownError" message,
 * so the metadata is often the only clue to what actually failed.
 */
export function formatUncaughtError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.stack ?? err.message];
  if (err.cause !== undefined) parts.push(`cause: ${String(err.cause)}`);
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
    let rendered: string;
    if (typeof value === "string") {
      rendered = value;
    } else {
      try {
        rendered = JSON.stringify(value);
      } catch {
        // Some error properties (e.g. Bun's source-mapped stack frames) can be
        // cyclic, which JSON.stringify rejects outright — fall back to String()
        // rather than letting the formatter itself crash and hide the real error.
        rendered = String(value);
      }
    }
    parts.push(`${key}: ${rendered}`);
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
  const sessionLog = startSessionLog(join(promptSession.runDir, "session.info.log"));
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
  Promise.resolve()
    .then(() => main())
    .then((result) => {
      runOutput = combineRunOutputs(result ?? undefined, { artifacts: logArtifacts });
      return promptSession.finishReplay();
    })
    .then(async () => {
      await renderRunSummary(promptSession.runDir, runOutput ?? { artifacts: logArtifacts, details: [] });
      if (runOutput?.worstFailure && worstFailureShouldExitNonZero(runOutput.worstFailure)) {
        fitCliError(formatFailureSummaryLine(runOutput.worstFailure, runOutput.failureCount ?? 1));
        await Promise.all([sessionLog.flush(), debugLog.flush()]);
        process.exit(1);
      }
    })
    .catch(async (err) => {
      if (err instanceof Error && err.name === "ExitPromptError") {
        console.log("\nCancelled.");
        await Promise.all([sessionLog.flush(), debugLog.flush()]);
        process.exit(0);
      }
      // A thrown error skips the success branch, but the user still needs the
      // artifact table (and S3 upload) to debug — so render the summary here too,
      // falling back to whatever artifacts we have (at least the session/debug
      // logs; reconcileArtifactsWithDir discovers the rest from the run dir).
      await renderRunSummary(promptSession.runDir, runOutput ?? { artifacts: logArtifacts, details: [] });
      console.error(formatUncaughtError(err));
      // Flush tee'd logs before exiting so the final error line is persisted.
      await Promise.all([sessionLog.flush(), debugLog.flush()]);
      process.exit(1);
    });
}
