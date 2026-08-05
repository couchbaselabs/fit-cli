/**
 * Persisted state for resuming a definition-driven run. A run that is told to
 * "leave everything up" at teardown writes this file; a later `--resume-at`
 * invocation reads it to reconnect the same execution target and reuse the
 * cluster/performer the earlier run stood up.
 *
 * The file lives next to the definition you pass, under `_internal/`, so it
 * is clearly internal bookkeeping rather than a run artifact:
 *   <dir-of-fit.yaml>/_internal/run-state.json
 *
 * Reading and writing are the only IO here; deciding what to do with the state
 * (validation, which phases to skip) lives in the resume.ts/run-from-definition
 * logic so it stays testable.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SelectedCluster } from "../../../cluster/cluster-select/cluster-select.js";

/** How to reconnect to the execution target a previous run used. */
export interface ResumeTargetState {
  kind: "local" | "remote";
  /** EC2 instance id — reconnect to it over SSM, and terminate it on later teardown. */
  instanceId?: string;
  /** Whether fit-cli provisioned this instance (vs. the user bringing an existing one) — governs whether resume attaches a terminate handle. */
  owned?: boolean;
}

/** The shared cluster a previous run stood up (or resolved). */
export interface ResumeClusterState {
  /** The resolved cluster the runs test against. */
  cluster: SelectedCluster;
  /** Whether the earlier run allocated it (and so teardown should remove it). */
  allocated: boolean;
  /** cbdinocluster id, present when {@link allocated}; used to validate/remove it. */
  clusterId?: string;
  /** The cbdinocluster command (path) on the target, for teardown removal. */
  cbdinoclusterCommand?: string;
  /** The cluster's artifacts dir, where cbcollect diagnostics are gathered before removal. */
  logsDir?: string;
  /**
   * The Couchbase cluster's own UUID (distinct from cbdinocluster's own tracking
   * id, `clusterId`) — a generic concept that applies beyond Capella/PE. Populated
   * for any cloud (Capella) cluster, PE or not.
   */
  couchbaseClusterUuid?: string;
  /**
   * True only when this cluster has an AWS PrivateLink endpoint that must also be
   * deleted on teardown. Not implied by `couchbaseClusterUuid` alone, since that's
   * populated for every cloud cluster.
   */
  privateEndpointEnabled?: boolean;
}

/** A performer a previous run left running, per run. */
export interface ResumePerformerState {
  globalRunIndex: number;
  /** Docker container id, present when fit-cli manages the performer. */
  containerId?: string;
  port: number;
  /** SDK value (e.g. "java") and version, for the log file name. */
  sdk: string;
  version?: string;
  /** Docker network the performer joined, if any. */
  dockerNetwork?: string;
}

/** Everything a `--resume-at` run needs to pick up where a previous run stopped. */
export interface RunState {
  version: 1;
  executionGroupIndex: number;
  /** Within the execution group at executionGroupIndex, the first run to execute. Absent means 0. */
  startRunIndex?: number;
  /** Whether the run forced every execution group onto localhost, ignoring instance settings. */
  forceLocalhost?: boolean;
  /** Whether the run forced every execution group onto a fresh EC2 instance, ignoring instance settings. */
  forceAws?: boolean;
  target: ResumeTargetState;
  cluster?: ResumeClusterState;
  performers: ResumePerformerState[];
}

/** Where the run-state file lives inside the artifact directory `runDir`. */
export function runStatePath(runDir: string): string {
  return join(runDir, "_internal", "run-state.json");
}

/** Read the saved run state from `runDir`, or undefined if none exists. */
export function readRunState(runDir: string): RunState | undefined {
  const path = runStatePath(runDir);
  if (!existsSync(path)) {
    return undefined;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RunState> & { version?: unknown };
  if (parsed.version !== 1) {
    throw new Error(`Unsupported run-state version in ${path}: ${String(parsed.version)}`);
  }
  return parsed as RunState;
}

/** Write the run state into `runDir`, creating the `instances/0/_internal` dir. */
export function writeRunState(runDir: string, state: RunState): string {
  const path = runStatePath(runDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return path;
}
