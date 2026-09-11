/**
 * Utility functions for checking if a run, or an entire group of runs, should be skipped because
 * it requires CNG support and the SDK being tested does not support it.
 */
import type { ResolvedExecutionGroup, ResolvedExecutionRun } from "../../shared/definition/resolve-definition.js";

/** Every run in a group, in execution order. */
function groupRuns(group: ResolvedExecutionGroup): ResolvedExecutionRun[] {
  return group.type === "functional" ? group.sessions.flatMap((session) => session.runs) : group.runs;
}

/** Whether a run connects over CNG: functional runs via their group's cluster, situational runs individually. */
export function isCngRun(group: ResolvedExecutionGroup, run: ResolvedExecutionRun): boolean {
  return group.type === "functional" ? group.cng : run.type === "situational" && run.cng;
}

/** Whether this run should be skipped, because it's CNG and its SDK doesn't support CNG. */
export function shouldSkipCngRun(group: ResolvedExecutionGroup, run: ResolvedExecutionRun): boolean {
  // SDKs without a `cng` field (the Analytics ones) don't support CNG.
  return isCngRun(group, run) && !("cng" in run.sdk && run.sdk.cng);
}

/** Whether every run in the group would be skipped, so the whole group (instance, cluster) can be. */
export function shouldSkipCngGroup(group: ResolvedExecutionGroup): boolean {
  const runs = groupRuns(group);
  return runs.length > 0 && runs.every((run) => shouldSkipCngRun(group, run));
}
