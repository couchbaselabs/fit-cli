/**
 * Workflow: collect cluster diagnostics (cbcollect — one log bundle per node)
 * with cbdinocluster's native `collect-logs` subcommand, pulling the bundles
 * into a local directory.
 *
 * fit-cli runs this automatically just before tearing down a cluster it
 * allocated, so the diagnostics land in the run's artifacts dir for later
 * debugging.
 *
 * Run on its own against an existing cluster (writes into the current run dir's
 * server-logs/ unless you pass a destination):
 *   bun src/cluster/cluster-cbcollect/cluster-cbcollect.ts <cluster-id> [dest-dir]
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { ensureRunDir } from "../../util/non-fit/replay.js";
import {
  localClusterCommandExecutor,
  type ClusterCommandExecutor,
} from "../cluster-create/allocate-cluster.js";
import { ensureCbdinocluster } from "../cluster-create/ensure-cbdinocluster.js";
import { DEFAULT_CAPELLA_ENV, capellaLogCollectionAvailable } from "../../fit/util/config.js";

/** Build the `cbdinocluster collect-logs <id> <dest-path>` args. */
export function collectLogsArgs(id: string, destPath: string): string[] {
  return ["collect-logs", id, destPath];
}

/**
 * Collect cluster diagnostics (cbcollect — one log bundle per node) into
 * `logsDir`, typically just before the cluster is torn down so the blob lands in
 * the run's artifacts dir.
 *
 * cbdinocluster writes the bundles wherever it runs — the remote box, for a
 * remote execution — into a directory that must already exist, so we recreate
 * that directory first, then pull each collected file back to `logsDir` locally
 * (a no-op when execution is already local).
 *
 * Best effort: cbcollect can take a long time and can fail (e.g. a node is
 * already down); a failure here is logged and swallowed so it never blocks the
 * removal that usually follows. Resolves whether it worked.
 */
export async function collectClusterLogs(
  cbdinocluster: string,
  id: string,
  logsDir: string,
  execution: ClusterCommandExecutor,
): Promise<boolean> {
  console.log(`\nCollecting cluster diagnostics for ${id} (cbcollect — this can take a while)...`);
  // The directory cbdinocluster writes into must already exist, and it lives on
  // the execution side (the box, when remote). Recreate it so stale bundles from
  // an earlier cluster on the same box don't get mixed in.
  const targetDir = execution.targetFilePath(logsDir);
  try {
    await execution.run("rm", ["-rf", targetDir]);
    await execution.run("mkdir", ["-p", targetDir]);
    await execution.run(cbdinocluster, collectLogsArgs(id, targetDir));
    const collected = (await execution.capture("ls", ["-1", targetDir]))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    for (const name of collected) {
      await execution.collectFile(join(targetDir, name), join(logsDir, name));
    }
    console.log(`\n✓ Collected ${collected.length} diagnostic file(s) for ${id} into ${logsDir}`);
    return true;
  } catch (err) {
    console.error(`\n✗ Failed to collect diagnostics for ${id}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Like {@link collectClusterLogs}, but for a Capella-cloud cluster (one with
 * `couchbaseClusterUuid` set) first checks whether the cluster's Capella environment
 * actually has cbcollect support configured (see `capellaLogCollectionAvailable`) —
 * cbdinocluster's internal-support API fails outright without an internal support
 * token, which the Capella team can currently only issue for "dev". Skips with an
 * explanatory message instead of attempting and failing when it's not configured.
 * Docker/CNG clusters (no `couchbaseClusterUuid`) are unaffected and always attempt
 * collection, as before.
 */
export async function collectClusterLogsIfSupported(
  clusterState: {
    cbdinoclusterCommand?: string;
    clusterId?: string;
    logsDir?: string;
    couchbaseClusterUuid?: string;
    capellaEnvironment?: string;
  },
  execution: ClusterCommandExecutor,
  options: { checkAvailable?: (block: string) => Promise<boolean> } = {},
): Promise<boolean> {
  const checkAvailable = options.checkAvailable ?? capellaLogCollectionAvailable;
  const { cbdinoclusterCommand, clusterId, logsDir, couchbaseClusterUuid } = clusterState;
  if (!cbdinoclusterCommand || !clusterId || !logsDir) {
    return false;
  }
  if (couchbaseClusterUuid !== undefined) {
    const capellaEnvironment = clusterState.capellaEnvironment ?? DEFAULT_CAPELLA_ENV;
    if (!(await checkAvailable(capellaEnvironment))) {
      console.log(
        `\nSkipping cluster diagnostics for ${clusterId}: Capella environment "${capellaEnvironment}" has no ` +
          `internal support token configured (only "dev" and "sandbox" does) — cbdinocluster can't collect logs from a ` +
          `Capella cluster without one.`,
      );
      return false;
    }
  }
  return collectClusterLogs(cbdinoclusterCommand, clusterId, logsDir, execution);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const id = process.argv[2];
    const destDir = process.argv[3] ?? join(ensureRunDir(), "server-logs");
    if (!id) {
      console.error(
        "Usage: tsx src/cluster/cluster-cbcollect/cluster-cbcollect.ts <cluster-id> [dest-dir]",
      );
      process.exit(2);
    }

    const cbdinocluster = await ensureCbdinocluster();
    if (!cbdinocluster) {
      process.exit(1);
    }

    const ok = await collectClusterLogs(cbdinocluster, id, destDir, localClusterCommandExecutor());
    process.exit(ok ? 0 : 1);
  });
}
