import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { ensureRunDir } from "./replay.js";

/** A file produced during the current fit-cli run, stored under ARTIFACT_DIR. */
export interface Artifact {
  /** File path relative to ARTIFACT_DIR. */
  filename: string;
  /** Short explanation of what the file is for. */
  explanation: string;
}

export interface ArtifactCollection {
  artifacts: Artifact[];
}

/** A copy-pasteable command or fact worth surfacing at the end of a run. */
export interface Detail {
  label: string;
  value: string;
  /** When true, also rendered as a highlighted banner after the run summary tables. */
  callToAction?: true;
}

export interface DetailCollection {
  details: Detail[];
}

/** A failure that affected a definition run, for exit-code and summary purposes. */
export interface RecordedFailure {
  classification: string;
  message: string;
  context: {
    instanceIndex: number;
    clusterIndex?: number;
    sessionIndex?: number;
    runIndex?: number;
    clusterless?: boolean;
    /** Standardised position label (e.g. `aws1 / 7.6-stable / java:main / func`), preferred over the indexes when known. */
    label?: string;
  };
}

export interface RunOutput extends ArtifactCollection, DetailCollection {
  worstFailure?: RecordedFailure;
  failureCount?: number;
}

const FAILURE_SEVERITY: Record<string, number> = {
  NonFatal: 0,
  FatalToRun: 1,
  FatalToSession: 2,
  FatalToCluster: 3,
  FatalToInstance: 4,
  FatalToAll: 5,
};

export function worstFailureShouldExitNonZero(failure: RecordedFailure): boolean {
  return (FAILURE_SEVERITY[failure.classification] ?? 0) >= FAILURE_SEVERITY.FatalToRun;
}

export function formatFailureSummaryLine(failure: RecordedFailure, totalCount: number): string {
  const { classification, message, context } = failure;
  const extra = totalCount > 1 ? ` (+${totalCount - 1} more failure${totalCount > 2 ? "s" : ""})` : "";
  // Prefer the standardised label (e.g. `aws1 / 7.6-stable / java:main / func`)
  // that the rest of fit-cli uses; fall back to the bare index form for failures
  // raised before a run's inputs were known (precondition checks, etc.).
  const location =
    context.label ??
    [
      `instance ${context.instanceIndex + 1}`,
      // Clusterless (situational) sessions aren't tied to a cluster, so they show a
      // session but no cluster; functional runs show both.
      ...(!context.clusterless && context.clusterIndex !== undefined ? [`cluster ${context.clusterIndex + 1}`] : []),
      ...(context.sessionIndex !== undefined ? [`session ${context.sessionIndex + 1}`] : []),
      ...(context.runIndex !== undefined ? [`run ${context.runIndex + 1}`] : []),
    ].join(", ");
  return `Returning non-zero due to ${classification} error '${message}' on ${location}${extra}`;
}

interface ArtifactTableRow extends Artifact {
  size?: string;
}

/** Turn an absolute artifact path into a first-class artifact record. */
export function artifactFromPath(
  path: string,
  explanation: string,
  artifactDir: string = ensureRunDir(),
): Artifact {
  const filename = relative(artifactDir, path);
  if (filename === "" || filename.startsWith("..") || isAbsolute(filename)) {
    throw new Error(`Artifact ${path} is not inside ARTIFACT_DIR ${artifactDir}`);
  }
  return { filename, explanation };
}

/** Merge artifact lists while preserving first-seen order. */
export function combineArtifacts(...groups: ReadonlyArray<readonly Artifact[] | undefined>): Artifact[] {
  const combined: Artifact[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const artifact of group ?? []) {
      const key = `${artifact.filename}\u0000${artifact.explanation}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      combined.push(artifact);
    }
  }

  return combined;
}

/** List every file under `dir`, recursively, as paths relative to `dir`. */
function walkFilesRelative(dir: string, base: string = dir): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFilesRelative(full, base));
    } else if (entry.isFile()) {
      files.push(relative(base, full));
    }
  }
  return files;
}

/**
 * Union the explicitly-registered artifacts with every other file actually found
 * under the run dir, so the end-of-run table never silently omits something that
 * was written. Registered artifacts keep their first-seen order and their
 * human-written "Purpose"; anything else found on disk is appended (sorted) with
 * a generic purpose. Best-effort — if the dir can't be read, the explicit list is
 * returned unchanged.
 */
export function reconcileArtifactsWithDir(artifactDir: string, explicit: readonly Artifact[]): Artifact[] {
  const combined = combineArtifacts(explicit);
  let discovered: string[];
  try {
    discovered = walkFilesRelative(artifactDir);
  } catch {
    return combined;
  }
  const known = new Set(combined.map((artifact) => artifact.filename));
  const extras: Artifact[] = discovered
    .filter((filename) => !known.has(filename))
    // `_internal/` holds fit-cli's own bookkeeping (run-state.json, wrapper
    // scripts, etc.) — implementation detail, not something to surface in the
    // user-facing artifact table.
    .filter((filename) => !filename.split(/[\\/]/).includes("_internal"))
    // Individual surefire XML files are archived into surefire-reports.tar.gz;
    // suppress them from the table so only the archive appears.
    .filter((filename) => !/[\\/]surefire-reports[\\/]TEST-.*\.xml$/.test(filename))
    .sort()
    .map((filename) => ({ filename, explanation: "(captured during the run)" }));
  return [...combined, ...extras];
}

/** The terminal-output log every run writes, at the root of its run dir. */
export const SESSION_LOG_NAME = "session.info.log";

/**
 * Files every `fit` invocation produces whether or not it did anything. A run whose
 * artifacts are only these kept no record worth shipping.
 */
const BOILERPLATE_ARTIFACTS = new Set([SESSION_LOG_NAME, "session.debug.log", "prompts.json"]);

/**
 * True when the run produced nothing beyond {@link BOILERPLATE_ARTIFACTS}.
 *
 * Bookkeeping commands (`slack write-placeholder`, `preset generate`, `caps table`) go
 * through the same runCli plumbing as a real run, so on GHA each one zipped its run dir
 * to S3 and prepended its own "Run artifacts" block — which is why a job that ran one
 * real test run showed two of them.
 */
export function producedOnlyBoilerplate(artifacts: readonly Artifact[]): boolean {
  return artifacts.every((artifact) => BOILERPLATE_ARTIFACTS.has(artifact.filename));
}

/** Merge detail lists while preserving first-seen order. */
export function combineDetails(...groups: ReadonlyArray<readonly Detail[] | undefined>): Detail[] {
  const combined: Detail[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const detail of group ?? []) {
      const key = `${detail.label}\u0000${detail.value}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      combined.push(detail);
    }
  }

  return combined;
}

/**
 * Merge run outputs while preserving first-seen order within each output type.
 * `worstFailure` is the most severe failure across all groups (not just the
 * first with one set), and `failureCount` sums every group's count — this is
 * what lets multiple independent runs (e.g. a comma-separated preset list) be
 * combined into a single, accurate exit-code decision.
 */
export function combineRunOutputs(...groups: ReadonlyArray<Partial<RunOutput> | undefined>): RunOutput {
  let worstFailure: RecordedFailure | undefined;
  let failureCount = 0;
  for (const group of groups) {
    if (group?.worstFailure === undefined) continue;
    failureCount += group.failureCount ?? 1;
    if (!worstFailure || FAILURE_SEVERITY[group.worstFailure.classification] > FAILURE_SEVERITY[worstFailure.classification]) {
      worstFailure = group.worstFailure;
    }
  }
  return {
    artifacts: combineArtifacts(...groups.map((group) => group?.artifacts)),
    details: combineDetails(...groups.map((group) => group?.details)),
    ...(worstFailure !== undefined ? { worstFailure, failureCount } : {}),
  };
}

function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 ** 2) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  if (bytes < 1024 ** 3) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  }

  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** Format artifacts as a simple terminal table. */
export function formatArtifactsTable(artifacts: readonly ArtifactTableRow[]): string | undefined {
  if (artifacts.length === 0) {
    return undefined;
  }

  const filenameHeader = "Artifact filename";
  const sizeHeader = "Size";
  const explanationHeader = "Purpose";
  const filenameWidth = Math.max(filenameHeader.length, ...artifacts.map((artifact) => artifact.filename.length));
  const showSize = artifacts.some((artifact) => artifact.size !== undefined);
  const sizeWidth = showSize
    ? Math.max(sizeHeader.length, ...artifacts.map((artifact) => (artifact.size ?? "").length))
    : 0;

  return [
    showSize
      ? `${filenameHeader.padEnd(filenameWidth)} | ${sizeHeader.padEnd(sizeWidth)} | ${explanationHeader}`
      : `${filenameHeader.padEnd(filenameWidth)} | ${explanationHeader}`,
    showSize
      ? `${"-".repeat(filenameWidth)}-+-${"-".repeat(sizeWidth)}-+-${"-".repeat(explanationHeader.length)}`
      : `${"-".repeat(filenameWidth)}-+-${"-".repeat(explanationHeader.length)}`,
    ...artifacts.map((artifact) =>
      showSize
        ? `${artifact.filename.padEnd(filenameWidth)} | ${(artifact.size ?? "").padEnd(sizeWidth)} | ${artifact.explanation}`
        : `${artifact.filename.padEnd(filenameWidth)} | ${artifact.explanation}`,
    ),
  ].join("\n");
}

/** Format details as a simple terminal table. */
export function formatDetailsTable(details: readonly Detail[]): string | undefined {
  if (details.length === 0) {
    return undefined;
  }

  const labelHeader = "Detail";
  const valueHeader = "Value";
  const labelWidth = Math.max(labelHeader.length, ...details.map((detail) => detail.label.length));
  const valueWidth = Math.max(valueHeader.length, ...details.map((detail) => detail.value.length));

  return [
    `${labelHeader.padEnd(labelWidth)} | ${valueHeader}`,
    `${"-".repeat(labelWidth)}-+-${"-".repeat(valueWidth)}`,
    ...details.map((detail) =>
      detail.label === "" && detail.value === ""
        ? `${" ".repeat(labelWidth)}   `
        : `${detail.label.padEnd(labelWidth)} | ${detail.value}`,
    ),
  ].join("\n");
}

/** Format the full artifact section shown at the end of a user-facing run. */
export function formatArtifactsSection(
  artifactDir: string,
  artifacts: readonly Artifact[],
): string | undefined {
  // Prefix every filename with ARTIFACT_DIR so each row is a copy-pasteable path.
  const fullPaths = artifacts.map((artifact) => ({
    ...artifact,
    filename: join(artifactDir, artifact.filename),
    size: (() => {
      try {
        return formatArtifactSize(statSync(join(artifactDir, artifact.filename)).size);
      } catch {
        return undefined;
      }
    })(),
  }));
  const table = formatArtifactsTable(fullPaths);
  if (!table) {
    return undefined;
  }

  return [table].join("\n");
}

/** Format the full details section shown at the end of a user-facing run. */
export function formatDetailsSection(details: readonly Detail[]): string | undefined {
  const table = formatDetailsTable(details);
  if (!table) {
    return undefined;
  }

  return [table].join("\n");
}

/**
 * Wrap a URL with an OSC 8 terminal hyperlink so it's clickable in supporting
 * terminals (iTerm2, GNOME Terminal, VS Code). GitHub Actions renders OSC 8
 * sequences as literal garbage rather than stripping them, so callers must
 * skip this on GHA.
 */
function terminalHyperlink(url: string): string {
  return `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`;
}

/**
 * Render a call-to-action detail as a highlighted box with a terminal hyperlink
 * (OSC 8) for the value when it looks like a URL. The hyperlink is suppressed on
 * GitHub Actions, which renders OSC 8 sequences as literal text rather than
 * stripping them.
 *
 * Example output:
 *   ╔══════════════════════════════════════════════════╗
 *   ║  Results UI:                                     ║
 *   ║  https://faas.couchbase.com/results/situational  ║
 *   ╚══════════════════════════════════════════════════╝
 */
export function formatCallToActionBanner(
  label: string,
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const header = `${label}:`;
  // innerWidth = 2 (left pad) + content + 2 (right pad)
  const innerWidth = Math.max(header.length, value.length) + 4;
  const top = `╔${"═".repeat(innerWidth)}╗`;
  const bottom = `╚${"═".repeat(innerWidth)}╝`;
  const padLine = (text: string, visibleLength: number) =>
    `║  ${text}${" ".repeat(innerWidth - visibleLength - 2)}║`;
  const isUrl = /^https?:\/\//.test(value);
  const isGha = env.GITHUB_ACTIONS === "true";
  const displayValue = isUrl && !isGha ? terminalHyperlink(value) : value;
  return [top, padLine(header, header.length), padLine(displayValue, value.length), bottom].join("\n");
}
