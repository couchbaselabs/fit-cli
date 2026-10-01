#!/usr/bin/env node
/**
 * Show or set an SDK's report settings - where its output goes - kept in the store as
 * <sdk>/settings.json, so a team can turn its Slack digest on, move it, or turn it off without
 * a fit-cli PR. What defines the report (repo, workflows, paths) stays in the opt-in, under
 * review: a mistake there corrupts the report, a mistake here only misdirects it.
 *
 *   bun src/fit/health/report/settings.ts <sdk> [--slack-channel <id> | --no-slack] [--report-url <url>] [--store <dir|s3://…>]
 */
import type { RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliInfo, printWithoutTimestamps } from "../../../util/non-fit/fit-cli-log.js";
import type { LocalHealthStore } from "../store/health-store.js";
import { openStore } from "../store/s3-store.js";

export interface HealthSettings {
  /** Post a digest - a headline in the channel, the detail in its thread - after each CI report. */
  slack?: {
    /** Channel ID (C0123…), or a user ID (U0123…) to post to that person's conversation with the bot. The bot must be in a channel. */
    channel: string;
    /** Where the full report is, linked from the digest. Default: the SDK's page on the health Pages site. */
    reportUrl?: string;
  };
}

export const settingsKey = (sdk: string) => `${sdk}/settings.json`;

/** The health Pages site; each SDK's report is at <this>/<sdk>/. */
export const PAGES_URL = "https://couchbaselabs.github.io/fit-cli/health/";

export function readSettings(store: LocalHealthStore, sdk: string): HealthSettings {
  const raw = store.read(settingsKey(sdk));
  return raw ? (JSON.parse(raw.toString("utf8")) as HealthSettings) : {};
}

/** The digest's report link: the setting, else the SDK's Pages page. */
export function reportUrlFor(sdk: string, settings: HealthSettings): string {
  return settings.slack?.reportUrl ?? `${PAGES_URL}${sdk}/`;
}

/** Problems with a settings object, as sentences. */
export function validateSettings(s: unknown): string[] {
  const o = s as HealthSettings | null;
  if (!o || typeof o !== "object") return ["settings must be an object"];
  const problems: string[] = [];
  for (const k of Object.keys(o)) if (k !== "slack") problems.push(`unknown field "${k}" (only "slack" is supported)`);
  if (o.slack !== undefined) {
    if (!o.slack || typeof o.slack.channel !== "string" || !/^[CGUD][A-Z0-9]{6,}$/.test(o.slack.channel)) {
      problems.push(`slack.channel must be a Slack channel or user ID (C…/G…/U…), got ${JSON.stringify(o.slack?.channel)}`);
    }
    if (o.slack?.reportUrl !== undefined && !/^https:\/\//.test(o.slack.reportUrl)) problems.push("slack.reportUrl must be an https:// URL");
  }
  return problems;
}

/** `current` with the command's changes applied. */
export function applySettingsArgs(current: HealthSettings, args: { slackChannel?: string; noSlack?: boolean; reportUrl?: string }): HealthSettings {
  if (args.noSlack) {
    const { slack: _dropped, ...rest } = current;
    return rest;
  }
  if (!args.slackChannel && !args.reportUrl) return current;
  const channel = args.slackChannel ?? current.slack?.channel;
  if (!channel) throw new Error("--report-url needs a Slack channel: set one with --slack-channel");
  const reportUrl = args.reportUrl ?? current.slack?.reportUrl;
  return { ...current, slack: { channel, ...(reportUrl ? { reportUrl } : {}) } };
}

export function settingsHelp(prefix: string): string {
  return `Show or set an SDK's report settings - where its output goes - kept in the store.

Usage:
  ${prefix} <sdk> [--slack-channel <id> | --no-slack] [--report-url <url>] [--store <dir|s3://bucket/prefix/>]

  --slack-channel  Post the digest to this channel (C0123...) or user (U0123...). Invite the bot to a channel first.
  --no-slack       Stop posting the digest.
  --report-url     Link the digest to this page instead of ${PAGES_URL}<sdk>/.

With no option, prints the current settings. A digest posts automatically only in CI.`;
}

export async function runSettingsCommand(argv: string[], prefix: string): Promise<Partial<RunOutput>> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    console.log(settingsHelp(prefix));
    return {};
  }
  const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const sdk = argv.find((a, i) => !a.startsWith("-") && !argv[i - 1]?.startsWith("--"));
  if (!sdk) throw new Error(settingsHelp(prefix));
  const args = { slackChannel: opt("slack-channel"), noSlack: argv.includes("--no-slack"), reportUrl: opt("report-url") };
  if (args.noSlack && (args.slackChannel || args.reportUrl)) throw new Error("--no-slack can't be combined with --slack-channel or --report-url");
  const changing = args.noSlack || !!args.slackChannel || !!args.reportUrl;
  const opened = await openStore(opt("store") ?? process.env.FIT_HEALTH_STORE, sdk, { skipRawLogs: true });
  try {
    const current = readSettings(opened.store, sdk);
    if (changing) {
      const next = applySettingsArgs(current, args);
      const problems = validateSettings(next);
      if (problems.length) throw new Error(`Invalid settings: ${problems.join("; ")}`);
      opened.store.write(settingsKey(sdk), JSON.stringify(next, null, 1) + "\n");
      await opened.flush();
      fitCliInfo(`Set ${sdk}'s settings in ${opened.location}`);
    }
    printWithoutTimestamps(JSON.stringify(readSettings(opened.store, sdk), null, 1));
  } finally {
    opened.close();
  }
  return {};
}

if (isMain(import.meta.url)) {
  runCli(() => runSettingsCommand(process.argv.slice(2), "bun src/fit/health/report/settings.ts"));
}
