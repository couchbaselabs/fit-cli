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
   * Optional. When set, `fit health report` also posts a digest to Slack - a headline in the
   * channel and the detail in its thread - automatically in CI, and on a local run only with
   * --slack. Leave it out and nothing is ever posted.
   */
  slack?: HealthSlackConfig;
}

export interface HealthSlackConfig {
  /** Channel ID (C0123…), or a user ID (U0123…) to post to that person's FIT Bot conversation. The bot must be in a channel. */
  channel: string;
  /** Where the full HTML report is published, linked from the digest. */
  reportUrl?: string;
}

export const HEALTH_OPT_INS: Partial<Record<SdkValue, HealthOptIn>> = {
  dotnet: {
    repo: "couchbase/couchbase-net-client",
    workflows: ["fit-testing-dotnet.yml"],
    branch: "master",
    slack: { channel: "CCFM9S771", reportUrl: "https://couchbaselabs.github.io/fit-cli/health/dotnet/" },
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
  if (e.slack !== undefined) {
    if (!e.slack || typeof e.slack.channel !== "string" || !/^[CGUD][A-Z0-9]{6,}$/.test(e.slack.channel)) {
      problems.push(`slack.channel must be a Slack channel or user ID (C…/G…/U…), got ${JSON.stringify(e.slack?.channel)}`);
    }
    if (e.slack?.reportUrl !== undefined && !/^https:\/\//.test(e.slack.reportUrl)) problems.push("slack.reportUrl must be an https:// URL");
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
  return out;
}

export function healthOptIn(sdk: string, env: NodeJS.ProcessEnv = process.env): (HealthOptIn & { local?: true }) | undefined {
  return loadOptIns(env)[sdk];
}
