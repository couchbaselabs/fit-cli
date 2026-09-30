/**
 * Collect the per-run `results/<runUuid>/` directory tree the FIT test-driver
 * writes for situational runs — one subdirectory per run, containing
 * `run.json5` (the exact `runs.params` blob, including cluster ids and
 * Capella environment under `forDatabase.debug`), `buckets.csv` (per-second
 * op/latency/error counts), `events.csv` (situation-starts/resolves/
 * sdk-error rows), and `scores.json5` (`{score, reasons}`, scored by the
 * test-driver itself from buckets.csv/events.csv) — see
 * situational-results.ts for the parser. Always written by the test-driver;
 * there's no hosted results database.
 *
 * Mirrors collect-junit.ts's tar+scp (remote) / plain copy (local) pattern —
 * the whole tree's shape (how many run folders, what's in each) isn't known
 * upfront, so this collects everything under `results/` in one shot rather
 * than enumerating run folders individually.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../../util/non-fit/proc.js";
import { runRunDir, type DefinitionRunPath } from "../../../util/non-fit/replay.js";
import type { ExecutionTarget } from "../../../util/non-fit/target.js";

/** Absolute path to the results/ directory the test-driver writes, given the performer checkout dir. */
export function situationalResultsDir(fitPerformerDir: string, testDriverModule: string = "test-driver"): string {
  return join(fitPerformerDir, testDriverModule, "results");
}

/** Local destination this run's collected results/ tree lands in. */
export function localSituationalResultsDir(path: DefinitionRunPath): string {
  return join(runRunDir(path), "results");
}

/** Shell command: tar the whole results/ tree (if present) to a tmp gz, printing its size and path (nothing printed if absent). */
export function remoteResultsArchiveArgs(sourceDir: string): string[] {
  return [
    "-lc",
    'if [ -d "$1" ]; then tmp=$(mktemp /tmp/fit-results-XXXXXX.tar.gz) && tar -czf "$tmp" -C "$1" . && stat -c%s "$tmp" && printf \'%s\\n\' "$tmp"; fi',
    "sh",
    sourceDir,
  ];
}

/**
 * Local: recursively copy `sourceDir` into this run's local results dir, if it
 * exists. Returns the local dir, or undefined if there was nothing to collect.
 */
export function collectResultsDir(sourceDir: string, path: DefinitionRunPath): string | undefined {
  if (!existsSync(sourceDir)) return undefined;
  const destDir = localSituationalResultsDir(path);
  rmSync(destDir, { recursive: true, force: true });
  cpSync(sourceDir, destDir, { recursive: true });
  return destDir;
}

/**
 * Remote: tar+scp the whole results/ tree off `target`, extract locally.
 * Returns the local dir, or undefined if there was nothing to collect
 * (results/ absent on the target).
 */
export async function collectResultsDirFromTarget(
  target: ExecutionTarget,
  sourceDir: string,
  path: DefinitionRunPath,
): Promise<string | undefined> {
  const output = (await target.capture("sh", remoteResultsArchiveArgs(sourceDir))).trim();
  if (output === "") return undefined;
  const [sizeLine, remoteArchive] = output.split("\n");
  if (!remoteArchive) return undefined;

  const destDir = localSituationalResultsDir(path);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const archivePath = join(runRunDir(path), "results.tar.gz");
  try {
    await target.getFile(remoteArchive, archivePath, Number(sizeLine));
    await run("tar", ["-xzf", archivePath, "-C", destDir]);
  } finally {
    await target.run("rm", ["-f", remoteArchive], undefined, { quiet: true });
    rmSync(archivePath, { force: true });
  }
  return destDir;
}
