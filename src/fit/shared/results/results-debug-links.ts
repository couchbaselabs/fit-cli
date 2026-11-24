/**
 * Step: add debug links to the `run.json5` of each result bundle a run produced, under
 * `forDatabase.debug.items` — the list the results UI shows beside a run. Used for both
 * FIT/SIT and FIT/PERF bundles, which share the one-directory-per-run layout.
 *
 * The test-driver records facts there (cbdinocluster id, Capella cluster id, CI URL) but
 * can't turn them into links: the hosts live in environments.json5, which only fit-cli has.
 * So fit-cli adds:
 *   - Capella UI, Fleet Manager and DataDog, when the run had a Capella cluster. For SIT the
 *     id is the driver's own "Capella cluster id" fact; for PERF fit-cli allocated the
 *     cluster itself and passes the id in.
 *   - CI URL. The SIT driver writes one already; the perf engine is fit-cli's own, so it
 *     gets one here.
 *   - Run archive, only when this run will actually upload its artifact zip (CI only) —
 *     otherwise the link would point at nothing.
 *
 * Idempotent: an item whose label is already there is left alone, so a resume or a manual
 * re-upload doesn't duplicate entries.
 *
 * Run on its own:
 *   bun src/fit/shared/results/results-debug-links.ts <results-dir> [--capella-environment <env>] [--capella-cluster-id <id>]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { buildCapellaDebugItems, type DebugLink } from "../../../cluster/cluster-create/capella-debug-links.js";
import { s3ObjectConsoleUrl } from "../../../cloud/util/aws/upload-directory.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliWarn } from "../../../util/non-fit/fit-cli-log.js";
import { ensureRunDir } from "../../../util/non-fit/replay.js";
import { artifactUploadEnabled, runArtifactsZipKey } from "../../util/aws/upload-run-artifacts.js";
import { loadEnvironments, type EnvironmentsFile } from "../../util/environments.js";

/** The fact label the test-driver writes the Capella cloud cluster id under. */
export const CAPELLA_CLUSTER_ID_LABEL = "Capella cluster id";

export interface DebugLinkContext {
  /** Key under `capella` in environments.json5. Without it no Capella links can be built. */
  capellaEnvironment?: string;
  /** Overrides the bundle's own "Capella cluster id" fact — for clusters fit-cli allocated. */
  capellaClusterId?: string;
  /** `s3://` URI the run's artifact zip will be uploaded to. */
  archiveZipKey?: string;
  ciUrl?: string;
}

/** The GitHub Actions run URL, mirroring the test-driver's own `ciUrl()`. */
export function ciRunUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  return GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
    ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : undefined;
}

/** The parts of the context that come from the environment rather than the run itself. */
export function environmentDebugLinkContext(
  env: NodeJS.ProcessEnv = process.env,
  runDir: () => string = () => ensureRunDir(),
): Pick<DebugLinkContext, "archiveZipKey" | "ciUrl"> {
  const ciUrl = ciRunUrl(env);
  return {
    ...(artifactUploadEnabled(env) ? { archiveZipKey: runArtifactsZipKey(runDir()) } : {}),
    ...(ciUrl ? { ciUrl } : {}),
  };
}

type RunRecord = Record<string, unknown>;

function asRecord(value: unknown): RunRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RunRecord) : {};
}

function debugItemsOf(record: unknown): RunRecord[] {
  const items = asRecord(asRecord(asRecord(record).forDatabase).debug).items;
  return Array.isArray(items) ? items.map(asRecord) : [];
}

/** The `description` of the first debug item with this label — how the driver writes facts. */
export function debugFact(record: unknown, label: string): string | undefined {
  const value = debugItemsOf(record).find((item) => item.label === label)?.description;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The link items a bundle should carry, given its own run.json5 and what fit-cli knows. */
export function debugLinksFor(
  record: unknown,
  ctx: DebugLinkContext,
  environments: EnvironmentsFile = loadEnvironments(),
): DebugLink[] {
  const links: DebugLink[] = [];
  const clusterId = ctx.capellaClusterId ?? debugFact(record, CAPELLA_CLUSTER_ID_LABEL);
  if (ctx.capellaEnvironment && clusterId) {
    links.push(...buildCapellaDebugItems(ctx.capellaEnvironment, clusterId, environments));
  }
  if (ctx.ciUrl) {
    links.push({ label: "CI URL", url: ctx.ciUrl });
  }
  if (ctx.archiveZipKey) {
    links.push({
      label: "Run archive",
      url: s3ObjectConsoleUrl(ctx.archiveZipKey),
      description: "Zipped run artifacts (logs, JUnit reports, etc.), uploaded to S3 at the end of the run.",
      command: `fit archive fetch ${ctx.archiveZipKey}`,
    });
  }
  return links;
}

/**
 * `record` with `items` appended to `forDatabase.debug.items`, skipping any whose label is
 * already present. Everything else in the record is kept as-is.
 */
export function mergeDebugItems(record: unknown, items: readonly DebugLink[]): { record: RunRecord; added: DebugLink[] } {
  const root = asRecord(record);
  const forDatabase = asRecord(root.forDatabase);
  const debug = asRecord(forDatabase.debug);
  const existing = Array.isArray(debug.items) ? (debug.items as unknown[]) : [];
  const labels = new Set(existing.map((item) => asRecord(item).label));
  const added = items.filter((item) => !labels.has(item.label));
  return {
    record: { ...root, forDatabase: { ...forDatabase, debug: { ...debug, items: [...existing, ...added] } } },
    added,
  };
}

/**
 * Add debug links to every bundle under `resultsDir` (optionally just `onlyDirs`).
 * Best-effort per bundle: an unreadable run.json5 is reported and skipped, never fatal —
 * the run itself already happened.
 */
export function addDebugLinksToResults(
  resultsDir: string,
  ctx: DebugLinkContext,
  opts: { onlyDirs?: readonly string[]; environments?: EnvironmentsFile } = {},
): number {
  if (!existsSync(resultsDir)) {
    return 0;
  }
  const environments = opts.environments ?? loadEnvironments();
  let updated = 0;
  for (const entry of readdirSync(resultsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || (opts.onlyDirs && !opts.onlyDirs.includes(entry.name))) {
      continue;
    }
    const runJson5 = join(resultsDir, entry.name, "run.json5");
    if (!existsSync(runJson5)) {
      continue;
    }
    try {
      const original: unknown = JSON5.parse(readFileSync(runJson5, "utf8"));
      const { record, added } = mergeDebugItems(original, debugLinksFor(original, ctx, environments));
      if (added.length === 0) {
        continue;
      }
      // Plain JSON, like the writers on both sides: the .json5 name is a FIT convention.
      writeFileSync(runJson5, JSON.stringify(record));
      console.log(`✓ Added ${added.length} debug link(s) to ${runJson5}: ${added.map((l) => l.label).join(", ")}`);
      updated++;
    } catch (err) {
      fitCliWarn(`Could not add debug links to ${runJson5}: ${(err as Error).message}`);
    }
  }
  return updated;
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const args = process.argv.slice(2).filter((a) => a !== "--");
    if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
      console.log(
        "Add debug links (Capella UI, Fleet Manager, DataDog, CI URL, run archive) to each run.json5 under a results dir.\n\n" +
          "Usage: bun src/fit/shared/results/results-debug-links.ts <results-dir> [--capella-environment <env>] [--capella-cluster-id <id>]\n\n" +
          "  --capella-environment  Key under `capella` in environments.json5. Needed for the Capella links.\n" +
          "  --capella-cluster-id   Use this cluster id rather than the bundle's own \"Capella cluster id\" fact.",
      );
      process.exit(args.length === 0 ? 2 : 0);
    }
    const flag = (name: string): string | undefined => {
      const at = args.indexOf(name);
      if (at === -1) return undefined;
      const value = args[at + 1];
      args.splice(at, 2);
      return value;
    };
    const capellaEnvironment = flag("--capella-environment");
    const capellaClusterId = flag("--capella-cluster-id");
    const updated = addDebugLinksToResults(args[0], {
      ...environmentDebugLinkContext(),
      ...(capellaEnvironment ? { capellaEnvironment } : {}),
      ...(capellaClusterId ? { capellaClusterId } : {}),
    });
    return Promise.resolve({ artifacts: [], details: [{ label: "Bundles updated", value: String(updated) }] });
  });
}
