#!/usr/bin/env node
/**
 * Sweeps the Capella clusters that runs leave behind when they die before their
 * own teardown. Called by the scheduled cleanup-capella-clusters workflow.
 *
 * `cleanup` runs `cbdinocluster cleanup cloud`. It removes every expired
 * cbdinocluster project in the organization, whoever made it, because an expiry
 * means the owner is done with it. Live clusters are never touched. Clusters in
 * `destroyFailed` are left and flagged, since only Capella support can clear them.
 *
 * cbdinocluster runs here against a throwaway config in a temp file, so the
 * developer's own ~/.cbdinocluster is never touched ([CONFIG1] in
 * specs/credentials-and-secrets.md). That init never creates a Capella API key
 * pool. The shared primary key is enough for sweep volume.
 *
 * bun run capella-clusters list [--env <name>]
 * bun run capella-clusters cleanup [--dry-run] [--env <name>]
 * bun run capella-clusters --help
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { fitCliWarn, runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import { capture, run, runHiddenUntilFailure } from "../../util/non-fit/proc.js";
import { findOnPath } from "../../util/non-fit/which.js";
import { isFitCliPurpose } from "../../cluster/cluster-create/allocate-purpose.js";
import { capellaCleanupCbdinoclusterInitArgs } from "../../cluster/cluster-create/default-cbdinocluster-init-config.js";
import { installCbdinoclusterLocally } from "../../cluster/cluster-create/install-cbdinocluster.js";
import {
  DEFAULT_CAPELLA_ENV,
  resolveCapellaConfig,
  resolveCbdinoclusterPath,
  type ResolvedCapellaConfig,
} from "../../fit/util/config.js";

/** The bare command name we look for on the PATH. */
const CBDINOCLUSTER = "cbdinocluster";

/** cbdinocluster's deployer for Capella's control plane. The local config can also hold docker clusters. */
const CAPELLA_DEPLOYER = "cloud";

/** Capella's state for a cluster it failed to destroy. cbdinocluster cannot clear these, so a human must. */
const DESTROY_FAILED_STATE = "destroyFailed";

/** One entry of `cbdinocluster ps --json` (its ClusterListOutput_Item, fields we use). */
export interface CbdinoclusterListItem {
  id: string;
  type?: string;
  /**
   * `provisioning` is also what an empty project (a failed allocate that never
   * reached cluster creation) shows as, and `corrupted` a half-deleted one.
   */
  state?: string;
  /**
   * The `--purpose` the cluster was allocated with, which cbdinocluster carries in
   * the Capella project name. Absent when the cluster was allocated without one.
   */
  purpose?: string;
  /** RFC3339. Absent when the cluster has no expiry at all, and so is never swept. */
  expiry?: string;
  deployer: string;
  /** Capella's own ids, for tracing a cluster in the Capella UI. Absent when empty. */
  cloud_project_id?: string;
  cloud_cluster_id?: string;
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index !== -1 ? argv[index + 1] : undefined;
}

/** Parse --env, the Capella environment (a key under `capella` in environments.json5). */
function parseEnvName(argv: string[]): string {
  const value = flag(argv, "env");
  if (argv.includes("--env") && !value) {
    throw new Error("--env needs a Capella environment name, e.g. --env prod.");
  }
  return value ?? DEFAULT_CAPELLA_ENV;
}

/**
 * Pull the Capella clusters out of `cbdinocluster ps --json`, dropping the other
 * deployers. cbdinocluster prints `null`, not `[]`, when it finds nothing.
 */
export function parseCloudClusters(json: string): CbdinoclusterListItem[] {
  const parsed: unknown = JSON.parse(json.trim() || "null");
  if (!Array.isArray(parsed)) {
    return [];
  }
  return (parsed as CbdinoclusterListItem[]).filter((item) => item?.deployer === CAPELLA_DEPLOYER);
}

/**
 * The clusters whose expiry had passed by `cutoff`. A cluster with no expiry, or
 * an expiry we can't parse, counts as live, so we never over-report what a sweep
 * would take.
 */
export function expiredClusters(
  clusters: readonly CbdinoclusterListItem[],
  cutoff: number = Date.now(),
): CbdinoclusterListItem[] {
  return clusters.filter((cluster) => {
    const expiry = cluster.expiry !== undefined ? Date.parse(cluster.expiry) : NaN;
    return !Number.isNaN(expiry) && expiry <= cutoff;
  });
}

function expiryCell(cluster: CbdinoclusterListItem): string {
  if (cluster.expiry === undefined) {
    return "none";
  }
  const parsed = Date.parse(cluster.expiry);
  return Number.isNaN(parsed) ? cluster.expiry : new Date(parsed).toISOString().slice(0, 19).replace("T", " ");
}

/** Render the clusters as a terminal table, mirroring cloud-instances.ts's table style. */
export function formatClustersTable(
  clusters: readonly CbdinoclusterListItem[],
  now: number = Date.now(),
): string {
  const expired = new Set(expiredClusters(clusters, now).map((cluster) => cluster.id));
  const headers = {
    id: "ID",
    type: "TYPE",
    state: "STATE",
    purpose: "PURPOSE",
    expiry: "EXPIRY (UTC)",
    expired: "EXPIRED",
  } as const;
  const rows = clusters.map((cluster) => ({
    id: cluster.id,
    type: cluster.type ?? "-",
    state: cluster.state ?? "-",
    purpose: cluster.purpose ?? "(none)",
    expiry: expiryCell(cluster),
    expired: expired.has(cluster.id) ? "EXPIRED" : "-",
  }));
  const widths = {
    id: Math.max(headers.id.length, ...rows.map((r) => r.id.length)),
    type: Math.max(headers.type.length, ...rows.map((r) => r.type.length)),
    state: Math.max(headers.state.length, ...rows.map((r) => r.state.length)),
    purpose: Math.max(headers.purpose.length, ...rows.map((r) => r.purpose.length)),
    expiry: Math.max(headers.expiry.length, ...rows.map((r) => r.expiry.length)),
    expired: Math.max(headers.expired.length, ...rows.map((r) => r.expired.length)),
  };
  const formatRow = (r: {
    id: string;
    type: string;
    state: string;
    purpose: string;
    expiry: string;
    expired: string;
  }): string =>
    `${r.id.padEnd(widths.id)} | ${r.type.padEnd(widths.type)} | ${r.state.padEnd(widths.state)} | ${r.purpose.padEnd(widths.purpose)} | ${r.expiry.padEnd(widths.expiry)} | ${r.expired.padEnd(widths.expired)}`;
  return [
    formatRow(headers),
    [widths.id, widths.type, widths.state, widths.purpose, widths.expiry, widths.expired]
      .map((width) => "-".repeat(width))
      .join("-+-"),
    ...rows.map(formatRow),
  ].join("\n");
}

/**
 * The `CAPELLA_*` variables `cbdinocluster init --auto` reads to fill its capella
 * block (see its cmd/init.go). They go through the environment, not init flags, so
 * the API secret and password never appear on a command line.
 */
function capellaInitEnv(capella: ResolvedCapellaConfig): Record<string, string> {
  return {
    CAPELLA_USER: capella.username ?? "",
    CAPELLA_PASS: capella.password,
    CAPELLA_ENDPOINT: capella.endpoint,
    CAPELLA_OID: capella.organizationId,
    CAPELLA_V4_ENDPOINT: capella.v4Endpoint,
    CAPELLA_API_KEY: capella.apiKey,
    CAPELLA_API_SECRET: capella.apiSecret,
    ...(capella.internalSupportToken ? { CAPELLA_INTERNAL_SUPPORT_TOKEN: capella.internalSupportToken } : {}),
    ...(capella.overrideToken ? { CAPELLA_OVERRIDE_TOKEN: capella.overrideToken } : {}),
  };
}

/** The configured cbdinocluster, else one on the PATH, else a fresh install. */
async function resolveLocalCbdinocluster(): Promise<string> {
  const configured = resolveCbdinoclusterPath();
  if (configured) {
    console.log(`→ capella-clusters: using cbdinocluster from your fit-cli config: ${configured}`);
    return configured;
  }
  const onPath = findOnPath(CBDINOCLUSTER);
  if (onPath) {
    console.log(`→ capella-clusters: using cbdinocluster from your PATH: ${onPath}`);
    return onPath;
  }
  return installCbdinoclusterLocally();
}

/** Give `body` a cbdinocluster that knows one Capella organization and nothing else. */
async function withCapellaConfig(
  envName: string,
  body: (cbdinocluster: string) => Promise<void>,
): Promise<void> {
  const capella = await resolveCapellaConfig({ block: envName });
  const cbdinocluster = await resolveLocalCbdinocluster();
  const configDir = mkdtempSync(join(tmpdir(), "fit-cli-cbdinocluster-"));
  const configPath = join(configDir, "config");
  Object.assign(process.env, capellaInitEnv(capella), { CBDINOCLUSTER_CONFIG: configPath });
  const initArgs = capellaCleanupCbdinoclusterInitArgs();
  try {
    console.log(
      `→ capella-clusters: writing a throwaway cbdinocluster config for the "${envName}" ` +
        `Capella organization (${capella.organizationId}) to ${configPath}`,
    );
    await runHiddenUntilFailure(cbdinocluster, ["init", ...initArgs.split(" ")], undefined, {
      display: `cbdinocluster init ${initArgs}`,
    });
    await body(cbdinocluster);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

async function listCloudClusters(cbdinocluster: string): Promise<CbdinoclusterListItem[]> {
  return parseCloudClusters(await capture(cbdinocluster, ["ps", "--json"]));
}

/** The clusters Capella failed to destroy. The cleanup skips them. */
export function destroyFailedClusters(clusters: readonly CbdinoclusterListItem[]): CbdinoclusterListItem[] {
  return clusters.filter((cluster) => cluster.state === DESTROY_FAILED_STATE);
}

/**
 * The GitHub Actions warning annotation for one cluster only Capella support can
 * clear. The runner parses these off stdout and shows them on the run page, so the
 * debris is visible without opening the job summary.
 */
export function destroyFailedAnnotation(cluster: CbdinoclusterListItem, envName: string): string {
  return (
    `::warning title=Capella ${DESTROY_FAILED_STATE} needs a human::` +
    `${cluster.id} purpose ${cluster.purpose ?? "none"} in ${envName} organization`
  );
}

function reportDestroyFailed(clusters: readonly CbdinoclusterListItem[], envName: string): void {
  const stuck = destroyFailedClusters(clusters);
  if (stuck.length === 0) {
    return;
  }
  fitCliWarn(
    `\n⚠ ${stuck.length} cluster(s) in ${DESTROY_FAILED_STATE}. The cleanup leaves them. ` +
      `Only Capella support can clear them. NEEDS A HUMAN`,
  );
  for (const cluster of stuck) {
    fitCliWarn(`  - ${cluster.id} (purpose ${cluster.purpose ?? "none"}, project ${cluster.cloud_project_id ?? "none"})`);
    if (process.env.GITHUB_ACTIONS === "true") {
      console.log(destroyFailedAnnotation(cluster, envName));
    }
  }
}

/**
 * The bound on the cleanup. A big backlog of expired projects is slow to delete.
 * The job cap is 120m, so this has to give up first for the summary to still be
 * written.
 */
export const CLEANUP_TIMEOUT = "90m";

/** Build the `cbdinocluster cleanup cloud` args. */
export function cleanupArgs(dryRun: boolean): string[] {
  return dryRun ? ["cleanup", CAPELLA_DEPLOYER, "--dry-run"] : ["cleanup", CAPELLA_DEPLOYER, "--timeout", CLEANUP_TIMEOUT];
}

/** Remove every expired cbdinocluster project in the organization. Throws if cbdinocluster fails. */
async function removeExpiredProjects(cbdinocluster: string, dryRun: boolean): Promise<void> {
  console.log(
    `\n${dryRun ? "Dry run of removing" : "Removing"} every expired cbdinocluster project ` +
      `in the organization, whoever made it`,
  );
  try {
    await run(cbdinocluster, cleanupArgs(dryRun));
  } catch (err) {
    throw new Error(`Capella cleanup failed. ${(err as Error).message}`, { cause: err });
  }
  console.log(`\n✓ ${dryRun ? "Dry run finished. Nothing was deleted." : "Removed every expired project in the organization."}`);
}

function helpText(): string {
  const p = runScriptPrefix("capella-clusters");
  return `Sweep the expired Capella clusters and projects in a Capella organization.

Usage:
  ${p} list [--env <name>]
  ${p} cleanup [--dry-run] [--env <name>]
  ${p} --help

Subcommands:
  list      Show the Capella clusters cbdinocluster can see, with the purpose and
            expiry of each, and which of them fit-cli created.
  cleanup   Show the same table, then run \`cbdinocluster cleanup ${CAPELLA_DEPLOYER}\`. It removes
            every expired cbdinocluster project in the organization, whoever made
            it, because an expiry means the owner is done with it. Bounded at
            ${CLEANUP_TIMEOUT}.

Options:
  --env <name>  Capella environment to sweep, a key under \`capella\` in
                environments.json5. Defaults to ${DEFAULT_CAPELLA_ENV}.
  --dry-run     Report what would be removed without removing anything.
                (cleanup only.)

Live clusters are never touched. Clusters Capella failed to destroy are left and
flagged loudly, since only Capella support can clear them.

This never touches your own ~/.cbdinocluster or the clusters it tracks. Each run
writes its own throwaway config to a temp file and deletes it afterwards. That
config never creates a Capella API key pool, the primary key is enough here.`;
}

async function cmdList(argv: string[]): Promise<void> {
  await withCapellaConfig(parseEnvName(argv), async (cbdinocluster) => {
    const clusters = await listCloudClusters(cbdinocluster);
    if (clusters.length === 0) {
      console.log("\nNo Capella clusters found.");
      return;
    }
    console.log(`\nFound ${clusters.length} Capella cluster(s):\n`);
    console.log(formatClustersTable(clusters));
    const ours = clusters.filter((cluster) => isFitCliPurpose(cluster.purpose));
    console.log(
      `\n${ours.length} of ${clusters.length} cluster(s) were created by fit-cli, ` +
        `${expiredClusters(ours).length} of those have expired.`,
    );
  });
}

async function cmdCleanup(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const envName = parseEnvName(argv);
  await withCapellaConfig(envName, async (cbdinocluster) => {
    const clusters = await listCloudClusters(cbdinocluster);
    if (clusters.length === 0) {
      console.log("\nNo Capella clusters found.");
    } else {
      console.log(`\nFound ${clusters.length} Capella cluster(s):\n`);
      console.log(formatClustersTable(clusters));
    }
    reportDestroyFailed(clusters, envName);
    await removeExpiredProjects(cbdinocluster, dryRun);
  });
}

export function runCapellaClustersMain(): void {
  runCli(async () => {
    const [subcommand, ...rest] = process.argv.slice(2);

    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      console.log(helpText());
      if (!subcommand) process.exit(2);
      return;
    }

    if (subcommand === "list") {
      await cmdList(rest);
      return;
    }

    if (subcommand === "cleanup") {
      await cmdCleanup(rest);
      return;
    }

    console.error(`Unknown subcommand: ${subcommand}\n`);
    console.error(helpText());
    process.exit(2);
  });
}

if (isMain(import.meta.url)) {
  runCapellaClustersMain();
}
