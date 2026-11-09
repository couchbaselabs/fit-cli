/**
 * Workflow: create a new Couchbase cluster with cbdinocluster. Reusable by any
 * feature that needs a fresh cluster — it makes sure cbdinocluster is usable,
 * asks what cluster to build, writes a def file under /tmp and allocates it.
 *
 * This workflow knows nothing about FIT configuration; it's the create-side
 * counterpart to the cluster-select workflow.
 *
 * Run this workflow on its own (this really does allocate a cluster):
 *   bun src/cluster/cluster-create/cluster-create.ts
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { type RunOutput } from "../../util/non-fit/artifacts.js";
import { capture } from "../../util/non-fit/proc.js";
import { parseConnstr } from "../cluster-select/parse-connstr.js";
import { allocateCluster, askDeployer } from "./allocate-cluster.js";
import { allocatePurpose } from "./allocate-purpose.js";
import { askClusterDef } from "./ask-cluster-def.js";
import { buildClusterDef } from "./build-cluster-def.js";
import { ensureCbdinocluster } from "./ensure-cbdinocluster.js";

/** The outcome of attempting to create a cluster. */
export type CreateResult =
  /** cbdinocluster allocated the cluster and we have its connection string. */
  | (RunOutput & { created: true; connectionString: string })
  /** cbdinocluster wasn't usable or allocation failed; a reason was printed. */
  | (RunOutput & { created: false });

/**
 * Walk the user through creating a cluster with cbdinocluster. Returns whether a
 * cluster was allocated; the user-facing explanation of any failure is printed
 * along the way.
 */
export async function createCluster(): Promise<CreateResult> {
  const cbdinocluster = await ensureCbdinocluster();
  if (!cbdinocluster) {
    return { created: false, artifacts: [], details: [] };
  }

  const def = buildClusterDef(await askClusterDef());
  const deployer = await askDeployer();

  let allocated;
  try {
    allocated = await allocateCluster(cbdinocluster, def, allocatePurpose(), deployer);
    console.log("\n✓ cbdinocluster allocated your cluster");
  } catch (err) {
    console.error(`\n✗ cbdinocluster failed to allocate the cluster: ${(err as Error).message}`);
    return { created: false, artifacts: [], details: [] };
  }

  // Pull the connection string straight from cbdinocluster so the caller can use
  // the new cluster without the user having to look it up and re-run.
  let connectionString: string | null;
  try {
    connectionString = parseConnstr(await capture(cbdinocluster, ["connstr", allocated.clusterId]));
  } catch (err) {
    console.error(
      `\n✗ Couldn't get the connection string for ${allocated.clusterId}: ${(err as Error).message}`,
    );
    return { created: false, artifacts: allocated.artifacts, details: allocated.details };
  }
  if (!connectionString) {
    console.error(`\n✗ cbdinocluster didn't return a connection string for ${allocated.clusterId}.`);
    return { created: false, artifacts: allocated.artifacts, details: allocated.details };
  }

  console.log(`→ Connection string: ${connectionString}`);
  return { created: true, connectionString, artifacts: allocated.artifacts, details: allocated.details };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const result = await createCluster();
    process.exit(result.created ? 0 : 1);
  });
}
