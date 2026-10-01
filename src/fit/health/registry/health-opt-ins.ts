/**
 * SDKs that have opted in to `fit health`, one entry per SDK. Adding an entry is the opt-in:
 * it includes the SDK in health reports and tells `fit health backfill` where its nightly
 * lives. Collecting run records does not depend on it.
 *
 * Kept apart from the SDK registry (src/util/sdk/sdks.ts) so an opt-in is a one-entry change
 * to this file. Which FIT test-driver an SDK uses - and so which SDKs its test names can be
 * compared with - follows from its family in that registry, so it isn't repeated here.
 *
 * Testing an opt-in before it is committed: point FIT_HEALTH_OPT_INS at a JSON5 file of
 * entries in the same shape. They are merged over the ones below and treated exactly the
 * same - same validation, same backfill, report and Slack paths - so what is tested is what
 * the real opt-in will do. Pair it with FIT_HEALTH_STORE pointing at a scratch store.
 */
import { existsSync, readFileSync } from "node:fs";
import JSON5 from "json5";
import { sdkByValue, type SdkValue } from "../../../util/sdk/sdks.js";

export const HEALTH_OPT_INS_ENV_VAR = "FIT_HEALTH_OPT_INS";

export interface HealthOptIn {
  /** GitHub repo holding the SDK's nightly FIT workflow, "owner/name". */
  repo: string;
  /** Workflow files whose scheduled runs are this SDK's nightly. Each must run only this SDK. */
  workflows: string[];
  /** Only runs on this branch count towards the trend. Default: the repo's default branch. */
  branch?: string;
  /**
   * For a repo that holds more than one SDK (couchbase-jvm-clients): the folders that are this
   * SDK and its performer, e.g. ["kotlin-client/", "kotlin-fit-performer/"]. A commit is a
   * change to this SDK only if it touches one of these or a shared path. Leave it out and every
   * commit to the repo counts.
   */
  paths?: string[];
  /**
   * Folders shared with sibling SDKs that ship in this SDK, e.g. ["core-io/"]: a change here
   * is a change to every SDK listing it.
   */
  sharedCorePaths?: string[];
  /**
   * Shared test-harness folders, e.g. ["core-fit-performer/"]: a change here can make every
   * sibling SDK fail without being an SDK bug, so it is shown but never counted as an SDK change.
   */
  sharedHarnessPaths?: string[];
  /** SDKs built on a common core share a family (e.g. "jvm"), for comparing across SDKs. */
  family?: string;
}


export const HEALTH_OPT_INS: Partial<Record<SdkValue, HealthOptIn>> = {
  dotnet: {
    repo: "couchbase/couchbase-net-client",
    workflows: ["fit-testing-dotnet.yml"],
    branch: "master",
  },
};

/** Problems with one entry, as sentences; empty when it is valid. */
export function validateOptIn(sdk: string, o: unknown): string[] {
  const problems: string[] = [];
  if (!sdkByValue(sdk)) problems.push(`"${sdk}" is not an SDK in src/util/sdk/sdks.ts`);
  const e = o as Partial<HealthOptIn> | null;
  if (!e || typeof e !== "object") return [...problems, "the entry must be an object"];
  if (typeof e.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(e.repo)) problems.push(`repo must be "owner/name", got ${JSON.stringify(e.repo)}`);
  if (!Array.isArray(e.workflows) || e.workflows.length === 0 || !e.workflows.every((w) => typeof w === "string" && /\.ya?ml$/.test(w))) {
    problems.push("workflows must be a non-empty list of workflow file names (e.g. fit-testing-java.yml)");
  }
  if (e.branch !== undefined && (typeof e.branch !== "string" || !e.branch)) problems.push("branch, when given, must be a branch name");
  // Where output goes is data, not code: `fit health settings <sdk> --slack-channel <id>`.
  if ((o as Record<string, unknown>).slack !== undefined) problems.push("slack is no longer part of an opt-in: set it with `fit health settings <sdk> --slack-channel <id>`");
  for (const field of ["paths", "sharedCorePaths", "sharedHarnessPaths"] as const) {
    const v = e[field];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length === 0 || !v.every((p) => typeof p === "string" && /^[\w.-][\w./-]*$/.test(p) && !p.includes(".."))) {
      problems.push(`${field}, when given, must be a non-empty list of repo-relative paths (folders end in /)`);
    }
  }
  if ((e.sharedCorePaths || e.sharedHarnessPaths) && !e.paths) problems.push("sharedCorePaths and sharedHarnessPaths need paths too");
  if (e.family !== undefined && (typeof e.family !== "string" || !/^[a-z][a-z0-9-]*$/.test(e.family))) problems.push("family, when given, must be a lower-case name like jvm");
  return problems;
}

/** Problems across entries: SDKs that share a repo must not share a workflow, or own the same paths. */
export function validateOptInSet(entries: Record<string, HealthOptIn>): string[] {
  const problems: string[] = [];
  const list = Object.entries(entries);
  for (const [i, [a, ea]] of list.entries()) {
    for (const [b, eb] of list.slice(i + 1)) {
      if (ea.repo !== eb.repo) continue;
      const wf = ea.workflows.filter((w) => eb.workflows.includes(w));
      if (wf.length) problems.push(`${a} and ${b} both claim ${wf.join(", ")} in ${ea.repo}: each nightly workflow must run one SDK`);
      if (!ea.paths || !eb.paths) {
        problems.push(`${a} and ${b} share ${ea.repo}, so each needs paths saying which part of it is that SDK`);
        continue;
      }
      const overlap = ea.paths.filter((p) => eb.paths!.some((q) => p.startsWith(q) || q.startsWith(p)));
      if (overlap.length) problems.push(`${a} and ${b} both own ${overlap.join(", ")}: shared code belongs in sharedCorePaths`);
    }
  }
  return problems;
}

/** The committed opt-ins, with FIT_HEALTH_OPT_INS entries merged over them. Throws on an invalid entry. */
export function loadOptIns(env: NodeJS.ProcessEnv = process.env): Record<string, HealthOptIn & { local?: true }> {
  const out: Record<string, HealthOptIn & { local?: true }> = { ...(HEALTH_OPT_INS as Record<string, HealthOptIn>) };
  const file = env[HEALTH_OPT_INS_ENV_VAR]?.trim();
  if (file) {
    if (!existsSync(file)) throw new Error(`${HEALTH_OPT_INS_ENV_VAR} points at ${file}, which does not exist`);
    const local = JSON5.parse<Record<string, unknown>>(readFileSync(file, "utf8"));
    for (const [sdk, entry] of Object.entries(local)) out[sdk] = { ...(entry as HealthOptIn), local: true };
  }
  for (const [sdk, entry] of Object.entries(out)) {
    const problems = validateOptIn(sdk, entry);
    if (problems.length) throw new Error(`Invalid fit health opt-in for ${sdk}${entry.local ? ` (from ${file})` : ""}: ${problems.join("; ")}`);
  }
  const across = validateOptInSet(out);
  if (across.length) throw new Error(`Invalid fit health opt-ins: ${across.join("; ")}`);
  return out;
}

export function healthOptIn(sdk: string, env: NodeJS.ProcessEnv = process.env): (HealthOptIn & { local?: true }) | undefined {
  return loadOptIns(env)[sdk];
}
