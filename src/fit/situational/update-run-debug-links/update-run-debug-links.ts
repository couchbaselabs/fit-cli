/**
 * Step: after a situational run, resolve `forDatabase.debug.items[]` (Capella UI,
 * Fleet Manager, DataDog logs, run-archive fetch command) for each run bundle
 * collected from the test-driver's `results/` directory (see
 * situational-results.ts) and merge them into that bundle's `run.json5`,
 * under `forDatabase.debug.items`.
 *
 * Situational testing is file-only: fit-cli no longer writes to any hosted
 * results database. fit-cli holds the URL-building "smarts"
 * (environments.json5); the test-driver only resolves the runtime Capella
 * cloud cluster UUID (via `cbdinocluster cloud get-cloud-id`), so this step
 * reads that id back out of run.json5's `forDatabase.debug` block rather than
 * the test-driver needing to know how to build these URLs. Best-effort per
 * bundle — one bundle with no cloud cluster id doesn't stop the others from
 * being processed.
 *
 * Run on its own:
 *   bun src/fit/situational/update-run-debug-links/update-run-debug-links.ts <results-dir>
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { loadEnvironments, type EnvironmentsFile } from "../../util/environments.js";
import { buildDebugLinks, type DebugLink } from "../../../cluster/cluster-create/capella-debug-links.js";
import { listSituationalRunBundles, type SituationalRunBundle } from "../../shared/run-test-driver/situational-results.js";

/**
 * Return `runParams` with `items` appended to `forDatabase.debug.items` — the
 * test-driver itself may already have written entries there (e.g. a CI run link), so
 * this adds to that array rather than replacing it. Any other existing
 * `forDatabase`/`forDatabase.debug` fields are kept.
 */
export function mergeDebugItemsIntoRunParams(runParams: unknown, items: readonly DebugLink[]): unknown {
  const params = (runParams ?? {}) as Record<string, unknown>;
  const forDatabase = (params.forDatabase ?? {}) as Record<string, unknown>;
  const debug = (forDatabase.debug ?? {}) as Record<string, unknown>;
  const existingItems: unknown[] = Array.isArray(debug.items) ? debug.items : [];
  return {
    ...params,
    forDatabase: { ...forDatabase, debug: { ...debug, items: [...existingItems, ...items] } },
  };
}

/** Overwrite `<dir>/run.json5` with `runParams`. */
export function writeRunParams(dir: string, runParams: unknown): void {
  writeFileSync(join(dir, "run.json5"), JSON.stringify(runParams, null, 2));
}

/**
 * Resolve and merge `forDatabase.debug.items[]` into `run.json5` for one run bundle.
 * Skips entirely if run.json5 has no Capella cloud cluster id / environment
 * (the run failed before one was created, or the cluster wasn't
 * cloud-deployed).
 */
function writeDebugLinksForBundle(bundle: SituationalRunBundle, archiveZipKey: string | undefined, environments: EnvironmentsFile): void {
  const info = bundle.runDebug;
  if (!info?.capellaCloudClusterId || !info.capellaEnvironment) {
    return;
  }
  const links = buildDebugLinks(info.capellaEnvironment, info.capellaCloudClusterId, archiveZipKey, environments);
  if (links.length === 0) {
    return;
  }
  writeRunParams(bundle.dir, mergeDebugItemsIntoRunParams(bundle.runParams, links));
  console.log(`✓ Wrote ${links.length} debug item(s) for run ${bundle.runUuid} to ${join(bundle.dir, "run.json5")}:`);
  console.log(JSON.stringify(links, null, 2));
}

/**
 * Resolve and merge `forDatabase.debug.items[]` into `run.json5` for every run bundle in a
 * collected `results/` directory. Best-effort per bundle — one
 * failing/incomplete bundle doesn't stop the others from being processed.
 */
export function writeDebugLinksFromBundles(
  bundles: readonly SituationalRunBundle[],
  archiveZipKey?: string,
  environments: EnvironmentsFile = loadEnvironments(),
): void {
  for (const bundle of bundles) {
    writeDebugLinksForBundle(bundle, archiveZipKey, environments);
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const args = process.argv.slice(2).filter((a) => a !== "--");
    if (args.length !== 1 || args[0] === "--help" || args[0] === "-h") {
      console.log("Usage: bun src/fit/situational/update-run-debug-links/update-run-debug-links.ts <results-dir>");
      process.exit(args.length === 1 ? 0 : 2);
    }
    const bundles = listSituationalRunBundles(args[0]);
    if (bundles.length === 0) {
      console.error(`No run bundles found under: ${args[0]}`);
      process.exit(1);
    }
    writeDebugLinksFromBundles(bundles);
    return Promise.resolve();
  });
}
