/**
 * Step: allocate a cluster with cbdinocluster from a def document. The def is
 * written to a file in the current run directory under /tmp/fit-cli and then
 * handed to
 * `cbdinocluster --verbose allocate --def-file=<file>` (with an optional
 * --deployer override), whose output is streamed to the console.
 *
 * Run on its own (allocates a default single-node cluster — this really does
 * create a cluster, so only run it if you mean to):
 *   bun src/cluster/cluster-create/allocate-cluster.ts
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { artifactFromPath, type RunOutput, type Artifact } from "../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { input } from "../../util/non-fit/prompts.js";
import { formatCommandLine, printFileContent } from "../../util/non-fit/fit-cli-log.js";
import { capture, run, runHiddenUntilFailure, type RunOptions } from "../../util/non-fit/proc.js";
import { ensureRunDir } from "../../util/non-fit/replay.js";
import { posixQuote, teeToFileCommand } from "../../util/non-fit/remote-target.js";
import { findOnPath } from "../../util/non-fit/which.js";
import { loadEnvironments } from "../../fit/util/environments.js";
import { allocatePurpose } from "./allocate-purpose.js";
import { buildClusterDef } from "./build-cluster-def.js";
import { printCapellaDebugLinks, printCapellaUiLink } from "./capella-debug-links.js";
import { ensureCbdinocluster } from "./ensure-cbdinocluster.js";
import { parseAllocatedId } from "./parse-allocated-id.js";
import { parseCloudClusterUuid } from "./parse-cloud-cluster-uuid.js";

/** A cluster cbdinocluster has just allocated. */
export type AllocatedCluster = RunOutput & {
  /** cbdino's own cluster id, as passed to `cbdinocluster connstr <id>`.  Distinct from the `couchbaseClusterUuid` */
  clusterId: string;
  /**
   * The Couchbase cluster's own UUID — distinct from `clusterId` above (cbdinocluster's
   * own tracking id). Present for the `cloud` (Capella) deployer only: cbdinocluster's
   * `--verbose allocate` logs it (`cloud-id`) whenever that deployer is used, so this
   * is always captured for a fresh Capella allocation, not just PE ones.
   */
  couchbaseClusterUuid?: string;
  /**
   * For CAO/CNG clusters: the management-UI hostname and CNG-gateway connection
   * string host, fetched via `cbdinocluster mgmt <id>` and
   * `cbdinocluster connstr --couchbase2 <id>` after allocation.
   * Absent for non-CAO deployers.
   */
  caoHosts?: { uiHost: string; cngHost: string };
};

export interface WriteClusterDefResult {
  path: string;
  artifact: Artifact;
}

export interface ClusterCommandExecutor {
  readonly description: string;
  run(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<void>;
  capture(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<string>;
  /** L2 HiddenUntilFailure — see {@link FitExecutionContext.runHiddenUntilFailure}. */
  runHiddenUntilFailure(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<void>;
  /** L1 StreamToTerminal + saved-to-file — see {@link FitExecutionContext.streamToTerminalAndFile}. */
  streamToTerminalAndFile(command: string, args: string[], targetPath: string, cwd?: string): Promise<void>;
  targetFilePath(localPath: string): string;
  stageFile(localPath: string, targetPath?: string): Promise<string>;
  /** Collect `targetPath` to `localPath`; returns the actual local path written (see {@link FitExecutionContext.collectFile}). */
  collectFile(targetPath: string, localPath: string): Promise<string>;
  commandAvailable(command: string): Promise<boolean>;
}

export function localClusterCommandExecutor(): ClusterCommandExecutor {
  return {
    description: "this machine",
    run,
    capture,
    runHiddenUntilFailure,
    streamToTerminalAndFile: (command, args, targetPath, cwd) => {
      mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
      // Stream live to the terminal (LogType1) AND save to the file for artifact
      // collection and cluster-id parsing.
      return run("bash", ["-lc", teeToFileCommand([command, ...args].map(posixQuote).join(" "), targetPath)], cwd, {
        display: formatCommandLine(command, args),
      });
    },
    targetFilePath: (localPath) => localPath,
    stageFile: (localPath) => Promise.resolve(localPath),
    collectFile: (targetPath, localPath) => {
      mkdirSync(dirname(localPath), { recursive: true, mode: 0o700 });
      if (targetPath !== localPath) {
        copyFileSync(targetPath, localPath);
      }
      return Promise.resolve(localPath);
    },
    commandAvailable: (command) => Promise.resolve(findOnPath(command) !== undefined),
  };
}

/**
 * Write the cbdinocluster def to a file in the given directory and return its
 * absolute path. Pass a cycle-scoped directory (e.g. `cycleRunDir(cycleIndex)`)
 * for full runs, or omit to use the run root for standalone invocations.
 */
export function writeClusterDef(
  def: string,
  cycleDir: string = ensureRunDir(),
  runDir: string = ensureRunDir(),
): WriteClusterDefResult {
  mkdirSync(cycleDir, { recursive: true, mode: 0o700 });
  const path = join(cycleDir, "cbdinocluster.yaml");
  writeFileSync(path, def);
  return {
    path,
    artifact: artifactFromPath(path, "cbdinocluster definition used to allocate the cluster", runDir),
  };
}

/**
 * Ask whether to override the cbdinocluster deployer, returning the override
 * string or undefined for "use the default". Empty input means no override.
 */
export async function askDeployer(): Promise<string | undefined> {
  const deployer = (
    await input({
      promptId: "cluster.create.deployer-override",
      message: "Override the cbdinocluster deployer? (leave blank for the default)",
    })
  ).trim();
  return deployer === "" ? undefined : deployer;
}

/**
 * Allocate a cluster: write `def` to a file and run
 * `cbdinocluster --verbose allocate [--deployer=<deployer>] --def-file=<file>`.
 * Progress is streamed; resolves with the new cluster's id when allocation
 * succeeds and rejects if it fails (including if no cluster id comes back).
 */
export async function allocateCluster(
  cbdinocluster: string,
  def: string,
  deployer?: string,
  execution: ClusterCommandExecutor = localClusterCommandExecutor(),
  cycleDir: string = ensureRunDir(),
  cng = false,
  /** Only used (to print debug links) when `deployer` is "cloud" — see {@link printCapellaDebugLinks}. */
  capellaEnvironment?: string,
): Promise<AllocatedCluster> {
  const runDir = ensureRunDir();
  const { path: localDefFile, artifact } = writeClusterDef(def, cycleDir, runDir);
  console.log(`Wrote cbdinocluster def to ${localDefFile}:\n`);
  printFileContent(def);
  const defFile = await execution.stageFile(localDefFile, execution.targetFilePath(localDefFile));

  const args = ["--verbose", "allocate"];
  if (deployer) {
    args.push(`--deployer=${deployer}`);
  }
  // Intentionally set a very long expiry, because:
  // cbdino generally creates instances that are bound to the lifetime of the created cloud instance, and
  // if the user leaves the instance up, they get this confusing error when they come back and bring the instance down
  // after cbdino has expired:
  // "[11:12:07·aws1·8.0.2-5503] FitCliError: Failed to remove cluster af698c6b9cd64570a1c209bd5cbc7914: ssh exited with code 1"
  // But `cloud` (Capella) and `cao` (CNG on the shared ROSA cluster) allocate against
  // shared infrastructure rather than the user's own throwaway instance, so a dangling
  // 31h claim can starve other users. Expire those quickly instead.
  const sharedResourceDeployer = deployer === "cloud" || cng;
  args.push(sharedResourceDeployer ? "--expiry=3h" : "--expiry=31h");
  // The purpose is how a leaked cluster is traced back to its run, and how the
  // capella-clusters sweeper tells fit-cli's Capella projects from other teams'.
  // cbdinocluster puts it in the Capella project name and in the `cbdc2.purpose`
  // label on the docker/CNG deployers.
  args.push(`--purpose=${allocatePurpose()}`);
  args.push(`--def-file=${defFile}`);

  mkdirSync(cycleDir, { recursive: true, mode: 0o700 });
  const localOutputFile = join(cycleDir, "cbdinocluster-allocate.stdout");
  const targetOutputFile = execution.targetFilePath(localOutputFile);
  let runError: unknown;
  try {
    await execution.streamToTerminalAndFile(cbdinocluster, args, targetOutputFile);
  } catch (err) {
    runError = err;
  }
  // Collect the output file locally so we can parse the cluster id from it (on
  // remote runs cbdinocluster's tee wrote it on the box). The output itself
  // already streamed live to the terminal and the session/debug logs via
  // streamToTerminalAndFile, so we deliberately don't re-log it here — doing so
  // would duplicate the whole allocate transcript. Collect even on failure: the
  // tee writes the output before the command exits non-zero, and a partial
  // transcript is exactly what's needed to diagnose the failure.
  let localOutput = "";
  try {
    await execution.collectFile(targetOutputFile, localOutputFile);
    localOutput = readFileSync(localOutputFile, "utf8");
  } catch {
    // best-effort: file may not exist if SSH itself never started
  }
  if (runError !== undefined) {
    // Allocation failed before cbdinocluster could log a Couchbase cluster UUID, so
    // there's nothing to build the other debug links from — but the Capella UI link
    // needs no UUID, letting the user browse to (and clean up) the cluster by hand.
    if (deployer === "cloud" && capellaEnvironment) {
      printCapellaUiLink(capellaEnvironment);
    }
    // Deferred rethrow of the original caught error after collecting output —
    // rethrow it verbatim so its type/stack are preserved.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw runError;
  }
  const clusterId = parseAllocatedId(localOutput);
  if (!clusterId) {
    if (deployer === "cloud" && capellaEnvironment) {
      printCapellaUiLink(capellaEnvironment);
    }
    throw new Error("cbdinocluster allocate didn't print a cluster id");
  }
  // Only the `cloud` (Capella) deployer prints this; cbdinocluster logs it on every
  // cloud allocation, so capture it here rather than a separate `cloud get-cloud-id`
  // round-trip when we already have it for free.
  const couchbaseClusterUuid = deployer === "cloud" ? parseCloudClusterUuid(localOutput) ?? undefined : undefined;
  if (deployer === "cloud") {
    console.log(
      couchbaseClusterUuid
        ? `  Couchbase cluster UUID: ${couchbaseClusterUuid}`
        : `  ⚠ cbdinocluster allocate didn't print a Couchbase cluster UUID for this cloud cluster.`,
    );
    if (capellaEnvironment) {
      if (couchbaseClusterUuid) {
        printCapellaDebugLinks(capellaEnvironment, couchbaseClusterUuid);
      } else {
        printCapellaUiLink(capellaEnvironment);
      }
    }
  }
   // Only CNG/CAO clusters expose a couchbase2 gateway + management-UI route that we
  // need to fetch here; a non-CNG cluster (e.g. a self-managed Enterprise Analytics
  // one) has no couchbase2 endpoint, so skip the probe — running it anyway just emits
  // a confusing "get CNG gateway host" line and a caught failure.
  let caoHosts: { uiHost: string; cngHost: string } | undefined;
  if (cng) {
    try {
      const [couchbase2Connstr, mgmtUrl] = await Promise.all([
        execution.capture(cbdinocluster, ["connstr", "--couchbase2", clusterId], undefined, {
          display: "cbdinocluster connstr --couchbase2 (get CNG gateway host)",
        }),
        execution.capture(cbdinocluster, ["mgmt", clusterId], undefined, {
          display: "cbdinocluster mgmt (get management UI host)",
        }),
      ]);
      // "couchbase2://cng-host[:port]" → "cng-host[:port]"
      const cngHost = couchbase2Connstr.trim().replace(/^couchbase2:\/\//, "");
      // "https://ui-host:443" or "http://ip:port" → "ui-host" (strip scheme and port)
      const uiHost = mgmtUrl.trim().replace(/^https?:\/\//, "").replace(/:\d+$/, "");
      if (cngHost && uiHost) {
        caoHosts = { uiHost, cngHost };
      }
    } catch {
      // Non-CAO deployer or commands not supported — caoHosts stays undefined.
    }
  }
  return {
    artifacts: [artifact],
    details: [],
    clusterId,
    ...(caoHosts ? { caoHosts } : {}),
    ...(couchbaseClusterUuid ? { couchbaseClusterUuid } : {}),
  };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const cbdinocluster = await ensureCbdinocluster();
    if (!cbdinocluster) {
      process.exit(1);
    }
    const def = buildClusterDef({
      nodeCount: 1,
      version: loadEnvironments().defaults.clusterVersion,
      services: ["kv", "n1ql", "index", "fts"],
      cng: false,
    });
    return allocateCluster(cbdinocluster, def, await askDeployer());
  });
}
