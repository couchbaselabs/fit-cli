#!/usr/bin/env node
/**
 * Sweeps the Capella clusters that runs leave behind when they die before their
 * own teardown. Called by the scheduled cleanup-capella-clusters workflow.
 *
 * The organization is shared, so a cluster is only removed when fit-cli's purpose
 * is stamped on it (see allocate-purpose.ts) and its expiry has passed.
 *
 * cbdinocluster runs here against a throwaway config in a temp file, so the
 * developer's own ~/.cbdinocluster is never touched ([CONFIG1] in
 * specs/credentials-and-secrets.md).
 *
 * bun run capella-clusters list [--env <name>]
 * bun run capella-clusters cleanup [--dry-run] [--include-unlabelled] [--env <name>]
 * bun run capella-clusters --help
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import { capture, runHiddenUntilFailure } from "../../util/non-fit/proc.js";
import { findOnPath } from "../../util/non-fit/which.js";
import { localClusterCommandExecutor } from "../../cluster/cluster-create/allocate-cluster.js";
import { FITCLI_PURPOSE_PREFIX, isFitCliPurpose } from "../../cluster/cluster-create/allocate-purpose.js";
import { capellaCleanupCbdinoclusterInitArgs } from "../../cluster/cluster-create/default-cbdinocluster-init-config.js";
import { installCbdinoclusterLocally } from "../../cluster/cluster-create/install-cbdinocluster.js";
import { removeCluster } from "../../cluster/cluster-create/setup-declarative-cluster.js";
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

/** Capella's state for a cluster it failed to destroy. cbdinocluster skips these, so a human must remove them. */
const DESTROY_FAILED_STATE = "destroyFailed";

/** One entry of `cbdinocluster ps --json` (its ClusterListOutput_Item, fields we use). */
export interface CbdinoclusterListItem {
  id: string;
  type: string;
  state: string;
  /**
   * The `--purpose` the cluster was allocated with. Absent on clusters that predate
   * cbdinocluster reporting it, which is how we tell those apart from ours.
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
 * The clusters whose expiry has passed. A cluster with no expiry, or an expiry we
 * can't parse, counts as live, so we never over-report what a sweep would take.
 */
export function expiredClusters(
  clusters: readonly CbdinoclusterListItem[],
  now: number = Date.now(),
): CbdinoclusterListItem[] {
  return clusters.filter((cluster) => {
    const expiry = cluster.expiry !== undefined ? Date.parse(cluster.expiry) : NaN;
    return !Number.isNaN(expiry) && expiry <= now;
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
    type: cluster.type,
    state: cluster.state,
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

/** What a sweep would remove, and why it leaves everything else. */
export interface SweepPlan {
  /** fit-cli's own expired clusters. Removing one takes its Capella project with it. */
  remove: CbdinoclusterListItem[];
  /** Everything left alone, grouped by the reason, in the order the reasons were hit. */
  skipped: { reason: string; clusters: CbdinoclusterListItem[] }[];
}

/**
 * Decide which clusters a sweep removes: fit-cli's own, by the purpose stamped on
 * them, and past their expiry. `includeUnlabelled` also takes expired clusters
 * with no purpose, which may belong to anyone, so it is opt-in.
 */
export function planSweep(
  clusters: readonly CbdinoclusterListItem[],
  options: { includeUnlabelled?: boolean; now?: number } = {},
): SweepPlan {
  const expired = new Set(expiredClusters(clusters, options.now ?? Date.now()).map((cluster) => cluster.id));
  const remove: CbdinoclusterListItem[] = [];
  const skipped = new Map<string, CbdinoclusterListItem[]>();
  const skip = (reason: string, cluster: CbdinoclusterListItem): void => {
    const existing = skipped.get(reason);
    if (existing) existing.push(cluster);
    else skipped.set(reason, [cluster]);
  };

  for (const cluster of clusters) {
    if (cluster.purpose !== undefined && !isFitCliPurpose(cluster.purpose)) {
      skip("created by something other than fit-cli", cluster);
    } else if (cluster.purpose === undefined && !options.includeUnlabelled) {
      skip("carries no purpose, so fit-cli can't prove it created it (--include-unlabelled takes these too)", cluster);
    } else if (!expired.has(cluster.id)) {
      skip("has not expired, so a run may still be using it", cluster);
    } else if (cluster.state === DESTROY_FAILED_STATE) {
      skip(`in ${DESTROY_FAILED_STATE}, so Capella has to be cleared by hand`, cluster);
    } else {
      remove.push(cluster);
    }
  }

  return { remove, skipped: [...skipped].map(([reason, group]) => ({ reason, clusters: group })) };
}

/** List what a sweep leaves behind and why, so a quiet run never reads as "nothing to do". */
function reportSkipped(plan: SweepPlan): void {
  for (const { reason, clusters } of plan.skipped) {
    console.log(`\nSkipping ${clusters.length} cluster(s), ${reason}:`);
    for (const cluster of clusters) {
      console.log(`  - ${cluster.id} (purpose: ${cluster.purpose ?? "none"})`);
    }
  }
}

function helpText(): string {
  const p = runScriptPrefix("capella-clusters");
  return `Sweep the Capella clusters and projects that failed FIT runs left behind.

Usage:
  ${p} list [--env <name>]
  ${p} cleanup [--dry-run] [--include-unlabelled] [--env <name>]
  ${p} --help

Subcommands:
  list      Show the Capella clusters cbdinocluster can see, with the purpose and
            expiry of each, and which of them fit-cli created.
  cleanup   Remove fit-cli's expired clusters. Removing a cluster takes its Capella
            project with it.

Options:
  --env <name>            Capella environment to sweep, a key under \`capella\` in
                          environments.json5 (default: ${DEFAULT_CAPELLA_ENV}).
  --dry-run               Report what would be removed, then exit without removing
                          anything. (cleanup only.)
  --include-unlabelled    Also remove expired clusters that carry no purpose at all.
                          THESE MAY BE ANOTHER ENGINEER'S: nothing proves fit-cli
                          created them. Only for clearing clusters that predate
                          fit-cli stamping a purpose. (cleanup only.)

A cluster is only removed when fit-cli's purpose ("${FITCLI_PURPOSE_PREFIX}...") is stamped on it and
its expiry has passed. The Capella organization is shared with other teams, so
everything else is left alone and reported. Clusters Capella itself failed to
destroy are also left, since only Capella can clear those.

This never touches your own ~/.cbdinocluster or the clusters it tracks. Each run
writes its own throwaway config to a temp file and deletes it afterwards.`;
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
  const includeUnlabelled = argv.includes("--include-unlabelled");
  await withCapellaConfig(parseEnvName(argv), async (cbdinocluster) => {
    const clusters = await listCloudClusters(cbdinocluster);
    if (clusters.length > 0) {
      console.log(`\nFound ${clusters.length} Capella cluster(s):\n`);
      console.log(formatClustersTable(clusters));
    }

    const plan = planSweep(clusters, { includeUnlabelled });
    reportSkipped(plan);

    if (plan.remove.length === 0) {
      console.log(`\nNothing to remove.${dryRun ? " Nothing was deleted." : ""}`);
      return;
    }

    console.log(
      `\n${dryRun ? "Would remove" : "Removing"} ${plan.remove.length} expired cluster(s), ` +
        `and the Capella project of each:`,
    );
    for (const cluster of plan.remove) {
      console.log(`  - ${cluster.id} (purpose: ${cluster.purpose ?? "none"})`);
    }
    if (dryRun) {
      console.log("\nDry run, nothing was deleted.");
      return;
    }

    const execution = localClusterCommandExecutor();
    const failed: string[] = [];
    for (const cluster of plan.remove) {
      if (!(await removeCluster(cbdinocluster, cluster.id, execution))) {
        failed.push(cluster.id);
      }
    }
    // Every cluster is attempted before we give up, so one Capella failure doesn't
    // strand the rest for another hour.
    if (failed.length > 0) {
      throw new Error(`Failed to remove ${failed.length} of ${plan.remove.length} cluster(s): ${failed.join(", ")}`);
    }
    console.log(`\n✓ Removed ${plan.remove.length} expired cluster(s).`);
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
