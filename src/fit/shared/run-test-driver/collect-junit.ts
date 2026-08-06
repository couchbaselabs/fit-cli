/**
 * Collect the JUnit XML the FIT test-driver produces (via Maven surefire) into
 * the per-run ARTIFACT_DIR, and render a self-contained HTML visualisation of
 * the results with xunit-viewer.
 *
 * The surefire reports live under the performer repo's target/ directory, which
 * is overwritten by the next Maven run, so we copy them somewhere stable and
 * register them — and the generated report — as run artifacts.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { artifactFromPath, type Artifact } from "../../../util/non-fit/artifacts.js";
import { fitCliWarn } from "../../../util/non-fit/fit-cli-log.js";
import { run } from "../../../util/non-fit/proc.js";
import { posixQuote } from "../../../util/non-fit/remote-target.js";
import { runRunDir, type DefinitionRunPath } from "../../../util/non-fit/replay.js";
import type { ExecutionTarget } from "../../../util/non-fit/target.js";
import { throwFatalToRun } from "../failure-classification.js";

/**
 * Absolute path to the surefire JUnit XML directory the test-driver produces,
 * given the transactions-fit-performer checkout dir. Surefire's `reportsDirectory`
 * has no command-line property (only a `default-value`), so `-Dsurefire.reportsDirectory`
 * is silently ignored — reports always land in the project's default location.
 */
export function surefireReportsDir(fitPerformerDir: string, testDriverModule: string = "test-driver"): string {
  return join(fitPerformerDir, testDriverModule, "target", "surefire-reports");
}

/** The surefire XML report files (TEST-*.xml) found in `sourceDir`. */
function junitXmlFiles(sourceDir: string): string[] {
  if (!existsSync(sourceDir)) {
    return [];
  }
  return readdirSync(sourceDir).filter((file) => file.startsWith("TEST-") && file.endsWith(".xml"));
}

function parseJunitXmlFiles(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("TEST-") && line.endsWith(".xml"));
}

// It takes forever to copy these individually.
export function remoteJunitArchiveArgs(sourceDir: string): string[] {
  return [
    "-lc",
    'tmp=$(mktemp /tmp/fit-junit-XXXXXX.tar.gz) && cd "$1" && tar -czf "$tmp" -- TEST-*.xml && stat -c%s "$tmp" && printf \'%s\\n\' "$tmp"',
    "sh",
    sourceDir,
  ];
}

/**
 * Drop the surefire <properties> block (java.class.path, surefire.test.class.path
 * and friends) from a report. The values are huge and add no signal to the HTML
 * report, which embeds the raw XML, so we strip them from the copy we render.
 */
export function stripJunitProperties(xml: string): string {
  return xml.replace(/[ \t]*<properties>[\s\S]*?<\/properties>\n?/g, "");
}

/**
 * Patch the xunit-viewer HTML so suites render collapsed by default. The bundle
 * initialises every suite to active (expanded); flip that, and the "Expanded"
 * toggle's initial state, by rewriting the two tokens that drive it. Best effort:
 * returns the HTML unchanged (with a warning) if a token is no longer present,
 * e.g. after an xunit-viewer upgrade.
 */
export function collapseSuitesByDefault(html: string): string {
  const replacements: ReadonlyArray<readonly [string, string]> = [
    ["(r.currentSuites[a].active=!0)", "(r.currentSuites[a].active=!1)"],
    ["suitesExpanded:!0", "suitesExpanded:!1"],
  ];

  let patched = html;
  for (const [from, to] of replacements) {
    if (!patched.includes(from)) {
      fitCliWarn(`Could not collapse JUnit suites by default: xunit-viewer token not found (${from}).`);
      continue;
    }
    patched = patched.replaceAll(from, to);
  }
  return patched;
}

/**
 * Render report.html from the collected reports: strip the noisy <properties>
 * block from a throwaway copy, run xunit-viewer over it, then collapse the
 * suites in the generated HTML. Returns undefined (best effort) if the render
 * fails, leaving the raw XML artifact untouched.
 */
async function renderJunitReport(reportsDir: string, runDir: string): Promise<Artifact | undefined> {
  const renderDir = mkdtempSync(join(tmpdir(), "fit-junit-"));
  try {
    for (const file of readdirSync(reportsDir)) {
      const cleaned = stripJunitProperties(readFileSync(join(reportsDir, file), "utf8"));
      writeFileSync(join(renderDir, file), cleaned, { mode: 0o600 });
    }

    const reportFile = join(runDir, "report.html");
    await run("npx", ["--yes", "xunit-viewer", "--results", renderDir, "--output", reportFile]);
    writeFileSync(reportFile, collapseSuitesByDefault(readFileSync(reportFile, "utf8")), { mode: 0o600 });
    return artifactFromPath(reportFile, "HTML visualisation of the JUnit results (open in a browser)");
  } catch (err) {
    fitCliWarn(`Could not render the JUnit HTML report with xunit-viewer: ${(err as Error).message}`);
    return undefined;
  } finally {
    rmSync(renderDir, { recursive: true, force: true });
  }
}

/**
 * Copy the test-driver's JUnit XML from `sourceDir` into a temporary directory,
 * create a surefire-reports.tar.gz archive, render an HTML report, and return
 * artifacts for both. The individual XML files are not kept on disk — only the
 * archive and the HTML report. The source directory (`destDir`) is kept only so
 * that the caller can still run extractFitTestDriverSummaryFromJunitReports
 * after this call; individual files will not appear in the artifact table.
 *
 * A run that produced no JUnit reports at all is treated as FatalToRun.
 */
export async function collectJunitArtifacts(sourceDir: string, path: DefinitionRunPath): Promise<Artifact[]> {
  const xmlFiles = junitXmlFiles(sourceDir);
  if (xmlFiles.length === 0) {
    throwFatalToRun(`No JUnit reports found under ${sourceDir} — the test-driver produced no results for this run.`);
  }

  const runDir = runRunDir(path);
  const destDir = join(runDir, "surefire-reports");
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  for (const file of xmlFiles) {
    const src = join(sourceDir, file);
    const dest = join(destDir, file);
    // When the test-driver wrote surefire reports straight into this run's dir
    // (local execution), source and dest are the same file — nothing to copy.
    if (resolve(src) !== resolve(dest)) {
      cpSync(src, dest);
    }
  }

  // Archive the XML files; individual files are filtered from the artifact table
  // by reconcileArtifactsWithDir so only the archive appears there.
  const archivePath = join(runDir, "surefire-reports.tar.gz");
  await run("tar", ["-czf", archivePath, "-C", runDir, basename(destDir)]);

  const reportArtifact = await renderJunitReport(destDir, runDir);
  const artifacts: Artifact[] = [
    artifactFromPath(archivePath, `JUnit XML reports from the FIT test-driver (${xmlFiles.length} file(s), archived)`),
  ];
  if (reportArtifact) {
    artifacts.push(reportArtifact);
  }
  return artifacts;
}

/**
 * Copy JUnit XML off an execution target into ARTIFACT_DIR/surefire-reports.tar.gz,
 * extract to a local directory for summary extraction and HTML rendering, and
 * return artifacts for both. As with {@link collectJunitArtifacts}, a run that
 * produced no reports is FatalToRun. Individual XML files are not kept on disk
 * after this call — only the archive and the HTML report.
 */
export async function collectJunitArtifactsFromTarget(
  target: ExecutionTarget,
  sourceDir: string,
  path: DefinitionRunPath,
): Promise<Artifact[]> {
  // Guard the find against a missing surefire-reports dir: a test run that
  // produced no reports (e.g. nothing matched, or the driver bailed early) would
  // otherwise make `find` exit non-zero and crash the whole run — taking the
  // end-of-run artifacts table down with it. Mirror the local existsSync guard.
  const xmlFiles = parseJunitXmlFiles(
    await target.capture("sh", [
      "-lc",
      `if [ -d ${posixQuote(sourceDir)} ]; then ` +
        `find ${posixQuote(sourceDir)} -maxdepth 1 -type f -name 'TEST-*.xml' -printf '%f\\n'; fi`,
    ]),
  );
  if (xmlFiles.length === 0) {
    throwFatalToRun(`No JUnit reports found under ${sourceDir} — the test-driver produced no results for this run.`);
  }

  const runDir = runRunDir(path);
  const destDir = join(runDir, "surefire-reports");
  const archivePath = join(runDir, "surefire-reports.tar.gz");
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  let remoteArchive = "";
  try {
    const [sizeLine, archiveLine] = (await target.capture("sh", remoteJunitArchiveArgs(sourceDir))).trim().split("\n");
    remoteArchive = archiveLine ?? "";
    if (remoteArchive === "") {
      throw new Error("Remote JUnit archive path was empty.");
    }
    // Keep the archive as an artifact; extract to destDir for summary extraction
    // and HTML rendering. Individual files are filtered from the artifact table.
    await target.getFile(remoteArchive, archivePath, Number(sizeLine));
    await run("tar", ["-xzf", archivePath, "-C", destDir]);
  } finally {
    if (remoteArchive !== "") {
      await target.run("rm", ["-f", remoteArchive], undefined, { quiet: true });
    }
  }

  const reportArtifact = await renderJunitReport(destDir, runDir);
  const artifacts: Artifact[] = [
    artifactFromPath(archivePath, `JUnit XML reports from the FIT test-driver (${xmlFiles.length} file(s), archived)`),
  ];
  if (reportArtifact) {
    artifacts.push(reportArtifact);
  }
  return artifacts;
}
