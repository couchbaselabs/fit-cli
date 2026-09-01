#!/usr/bin/env node
/**
 * Sweeps the Capella clusters that runs leave behind when they die before their
 * own teardown. Called by the scheduled cleanup-capella-clusters workflow.
 *
 * The organization is shared, so the fit-cli pass only removes a cluster when
 * fit-cli's purpose is stamped on it (see allocate-purpose.ts) and its expiry has
 * passed. Empty (`provisioning`) and corrupted projects are swept under the same
 * rules.
 *
 * `--all-expired` adds a second pass, `cbdinocluster cleanup cloud`, which takes
 * every expired cbdinocluster project in the organization, whoever made it. Other
 * teams leave expired projects behind and nothing else reaps those.
 *
 * cbdinocluster runs here against a throwaway config in a temp file, so the
 * developer's own ~/.cbdinocluster is never touched ([CONFIG1] in
 * specs/credentials-and-secrets.md). That init never creates a Capella API key
 * pool. The shared primary key is enough for sweep volume.
 *
 * bun run capella-clusters list [--env <name>]
 * bun run capella-clusters cleanup [--dry-run] [--older-than <duration>] [--all-expired] [--env <name>]
 * bun run capella-clusters --help
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { fitCliWarn, runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import { capture, runHiddenUntilFailure } from "../../util/non-fit/proc.js";
import { findOnPath } from "../../util/non-fit/which.js";
import { localClusterCommandExecutor, type ClusterCommandExecutor } from "../../cluster/cluster-create/allocate-cluster.js";
import { FITCLI_PURPOSE_PREFIX, isFitCliPurpose } from "../../cluster/cluster-create/allocate-purpose.js";
import { capellaCleanupCbdinoclusterInitArgs } from "../../cluster/cluster-create/default-cbdinocluster-init-config.js";
import { installCbdinoclusterLocally } from "../../cluster/cluster-create/install-cbdinocluster.js";
import { removeCluster } from "../../cluster/cluster-create/setup-declarative-cluster.js";
import { parseDuration } from "../util/aws/instance-age.js";
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

/** Capella's state for a cluster it failed to destroy. `rm` cannot clear these, so a human must. */
const DESTROY_FAILED_STATE = "destroyFailed";

/** One entry of `cbdinocluster ps --json` (its ClusterListOutput_Item, fields we use). */
export interface CbdinoclusterListItem {
  id: string;
  type?: string;
  /**
   * `provisioning` is also what an empty project (a failed allocate that never
   * reached cluster creation) shows as, and `corrupted` a half-deleted one. Both
   * are removable through `rm` and are swept under the same rules.
   */
  state?: string;
  /**
   * The `--purpose` the cluster was allocated with, which cbdinocluster carries in
   * the Capella project name. Absent on clusters that predate it, which is how we
   * tell those apart from ours.
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

/** Parse --older-than into milliseconds. Duration format is instance-age.ts's, e.g. 2h, 1d. */
function parseOlderThanMs(argv: string[]): number {
  const value = flag(argv, "older-than");
  if (argv.includes("--older-than") && !value) {
    throw new Error("--older-than needs a duration, e.g. --older-than 2h.");
  }
  return value !== undefined ? parseDuration(value) : 0;
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

/** What a sweep would remove, and why it leaves everything else. */
export interface SweepPlan {
  /** fit-cli's own expired clusters. Removing one takes its Capella project with it. */
  remove: CbdinoclusterListItem[];
  /** Everything left alone, grouped by the reason, in the order the reasons were hit. */
  skipped: { reason: string; clusters: CbdinoclusterListItem[]; warn?: boolean }[];
}

/**
 * Decide which clusters a sweep removes. Three ownership rings, provable from the
 * purpose cbdinocluster reads back out of the Capella project name.
 *
 * 1. Any cbdinocluster project, maybe another team's tooling. Never touched here,
 *    only by the all-expired pass, and then only once expired.
 * 2. Purpose starts with `fitcli-`, so fit-cli made it. Removed once expired.
 * 3. Purpose equals one run's full stamp. The run's own teardown handles that ring,
 *    not this sweep.
 *
 * A cluster with no purpose at all predates the stamping and may be anyone's, so
 * this pass never takes it. The all-expired pass does, once it has expired.
 * `olderThanMs` further requires the expiry to have passed at least that long
 * before `now`.
 */
export function planSweep(
  clusters: readonly CbdinoclusterListItem[],
  options: { olderThanMs?: number; now?: number } = {},
): SweepPlan {
  const now = options.now ?? Date.now();
  const cutoff = now - (options.olderThanMs ?? 0);
  const expiredAtAll = new Set(expiredClusters(clusters, now).map((cluster) => cluster.id));
  const expiredLongEnough = new Set(expiredClusters(clusters, cutoff).map((cluster) => cluster.id));
  const remove: CbdinoclusterListItem[] = [];
  const skipped = new Map<string, { clusters: CbdinoclusterListItem[]; warn?: boolean }>();
  const skip = (reason: string, cluster: CbdinoclusterListItem, warn?: boolean): void => {
    const existing = skipped.get(reason);
    if (existing) existing.clusters.push(cluster);
    else skipped.set(reason, { clusters: [cluster], ...(warn ? { warn } : {}) });
  };

  for (const cluster of clusters) {
    if (cluster.purpose !== undefined && !isFitCliPurpose(cluster.purpose)) {
      skip("created by something other than fit-cli", cluster);
    } else if (cluster.purpose === undefined) {
      skip("carries no purpose, the all-expired pass takes it once expired", cluster);
    } else if (!expiredAtAll.has(cluster.id)) {
      skip("has not expired, so a run may still be using it", cluster);
    } else if (!expiredLongEnough.has(cluster.id)) {
      skip("expired more recently than --older-than, so it is left for a later sweep", cluster);
    } else if (cluster.state === DESTROY_FAILED_STATE) {
      skip(`in ${DESTROY_FAILED_STATE}, which only Capella support can clear. NEEDS A HUMAN`, cluster, true);
    } else {
      remove.push(cluster);
    }
  }

  return {
    remove,
    skipped: [...skipped].map(([reason, group]) => ({ reason, clusters: group.clusters, ...(group.warn ? { warn: true } : {}) })),
  };
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

/** List what a sweep leaves behind and why, so a quiet run never reads as "nothing to do". */
function reportSkipped(plan: SweepPlan, envName: string): void {
  for (const { reason, clusters, warn } of plan.skipped) {
    const log = warn ? fitCliWarn : console.log;
    log(`\n${warn ? "⚠ " : ""}Skipping ${clusters.length} cluster(s), ${reason}:`);
    for (const cluster of clusters) {
      log(`  - ${cluster.id} (purpose: ${cluster.purpose ?? "none"}, state: ${cluster.state ?? "unknown"})`);
      if (warn && process.env.GITHUB_ACTIONS === "true") {
        console.log(destroyFailedAnnotation(cluster, envName));
      }
    }
  }
}

/**
 * The bound on the all-expired pass. It walks every expired project in the
 * organization one at a time, so a big backlog is slow. The job cap is 120m, so
 * this has to give up first for the summary to still be written.
 */
export const CLEANUP_ALL_EXPIRED_TIMEOUT = "90m";

/** Build the `cbdinocluster cleanup cloud` args for the all-expired pass. */
export function cleanupAllExpiredArgs(dryRun: boolean): string[] {
  return dryRun
    ? ["cleanup", CAPELLA_DEPLOYER, "--dry-run"]
    : ["cleanup", CAPELLA_DEPLOYER, "--timeout", CLEANUP_ALL_EXPIRED_TIMEOUT];
}

/**
 * Remove every expired cbdinocluster project in the organization, including the
 * ones fit-cli did not create. The FIT test driver used to sweep these by accident
 * after every test, and that call is gone, so this pass took over the duty.
 *
 * cbdinocluster only takes projects whose expiry has passed, and skips
 * `destroyFailed` itself, so a live run of any team is safe. Resolves whether it
 * worked, like {@link removeCluster}.
 */
async function removeEveryExpiredProject(
  cbdinocluster: string,
  execution: ClusterCommandExecutor,
  dryRun: boolean,
): Promise<boolean> {
  console.log(
    `\n${dryRun ? "Dry run of removing" : "Removing"} every expired cbdinocluster project ` +
      `in the organization, whoever made it`,
  );
  try {
    await execution.run(cbdinocluster, cleanupAllExpiredArgs(dryRun));
    console.log(`\n✓ ${dryRun ? "Dry run of the all-expired pass finished" : "Swept every expired project in the organization"}`);
    return true;
  } catch (err) {
    fitCliWarn(`\n✗ The all-expired pass failed: ${(err as Error).message}`);
    return false;
  }
}

function helpText(): string {
  const p = runScriptPrefix("capella-clusters");
  return `Sweep the Capella clusters and projects that failed FIT runs left behind.

Usage:
  ${p} list [--env <name>]
  ${p} cleanup [--dry-run] [--older-than <duration>] [--all-expired] [--env <name>]
  ${p} --help

Subcommands:
  list      Show the Capella clusters cbdinocluster can see, with the purpose and
            expiry of each, and which of them fit-cli created.
  cleanup   Remove fit-cli's expired clusters, including empty and corrupted
            projects. Removing a cluster takes its Capella project with it.

Options:
  --env <name>            Capella environment to sweep, a key under \`capella\` in
                          environments.json5 (default: ${DEFAULT_CAPELLA_ENV}).
  --dry-run               Report what would be removed, then exit without removing
                          anything. (cleanup only.)
  --older-than <duration> Only remove clusters whose expiry passed at least this
                          long ago, e.g. 2h, 1d. Creation time is not recorded
                          anywhere, only expiry is. (cleanup only.)
  --all-expired           After the fit-cli pass, run \`cbdinocluster cleanup ${CAPELLA_DEPLOYER}\` to
                          remove every expired cbdinocluster project in the
                          organization. This reaches projects fit-cli did not
                          create, and only takes ones whose expiry has already
                          passed, so no live run of any team is touched. Bounded at
                          ${CLEANUP_ALL_EXPIRED_TIMEOUT}. (cleanup only.)

The fit-cli pass only removes a cluster when fit-cli's purpose ("${FITCLI_PURPOSE_PREFIX}...") is
stamped on it and its expiry has passed. The Capella organization is shared with
other teams, so everything else is left alone and reported, unless --all-expired
takes it. Clusters Capella itself failed to destroy are always left, and flagged
loudly, since only Capella can clear those.

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
  const allExpired = argv.includes("--all-expired");
  const olderThanMs = parseOlderThanMs(argv);
  const envName = parseEnvName(argv);
  await withCapellaConfig(envName, async (cbdinocluster) => {
    const clusters = await listCloudClusters(cbdinocluster);
    if (clusters.length > 0) {
      console.log(`\nFound ${clusters.length} Capella cluster(s):\n`);
      console.log(formatClustersTable(clusters));
    }

    const plan = planSweep(clusters, { olderThanMs });
    reportSkipped(plan, envName);

    const execution = localClusterCommandExecutor();
    // Both passes always run, then their failures are reported together, so one
    // Capella failure never strands the rest for another hour.
    const problems: string[] = [];

    if (plan.remove.length === 0) {
      console.log(`\nNothing of fit-cli's to remove.${dryRun ? " Nothing was deleted." : ""}`);
    } else {
      console.log(
        `\n${dryRun ? "Would remove" : "Removing"} ${plan.remove.length} expired cluster(s), ` +
          `and the Capella project of each:`,
      );
      for (const cluster of plan.remove) {
        console.log(`  - ${cluster.id} (purpose: ${cluster.purpose ?? "none"}, state: ${cluster.state ?? "unknown"})`);
      }
      if (dryRun) {
        console.log("\nDry run, nothing was deleted.");
      } else {
        const failed: string[] = [];
        for (const cluster of plan.remove) {
          if (!(await removeCluster(cbdinocluster, cluster.id, execution))) {
            failed.push(cluster.id);
          }
        }
        if (failed.length > 0) {
          problems.push(`failed to remove ${failed.length} of ${plan.remove.length} cluster(s): ${failed.join(", ")}`);
        } else {
          console.log(`\n✓ Removed ${plan.remove.length} expired cluster(s).`);
        }
      }
    }

    if (allExpired && !(await removeEveryExpiredProject(cbdinocluster, execution, dryRun))) {
      problems.push("the all-expired pass failed");
    }

    if (problems.length > 0) {
      throw new Error(`Capella sweep problems. ${problems.join(". ")}`);
    }
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
