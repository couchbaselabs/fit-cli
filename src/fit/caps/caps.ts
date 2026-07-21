#!/usr/bin/env node
/**
 * fit caps — what every SDK's performer says it can do.
 *
 *   fit caps table [--sdks java,go] [--tag main]
 *   fit caps sync <path-to-transactions-fit-performer>
 *
 * table: starts each SDK's performer, calls the performerCapsFetch RPC, and prints a
 *        matrix of capability × SDK. No cluster is involved — performers report their
 *        caps before connecting to anything.
 * sync:  refreshes caps.json5 from the FIT protos, so newly-added capabilities show
 *        up in the table (and can be given a Jira ticket).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactFromPath, type RunOutput } from "../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { fitCliWarn, printWithoutTimestamps, runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import { ensureRunDir } from "../../util/non-fit/replay.js";
import { OPERATIONAL_SDKS, SDKS, isAnalyticsSdk, type Sdk } from "../../util/sdk/sdks.js";
import { DEFAULT_PERFORMER_IMAGE_TAG } from "../performers/util/performer-image.js";
import { ensureGhcrLogin, fetchCapsForSdk } from "./fetch-caps/fetch-caps.js";
import { DEFAULT_CAPS_PATH, findCap, loadCapsFile } from "./util/caps-metadata.js";
import { formatCapFocusReport, formatCapsMarkdown, formatCapsReport, type CapsFetchResult } from "./util/caps-table.js";
import { formatCapsFile, syncCapsFile } from "./util/sync-caps-file.js";

/**
 * Performers are started concurrently, but not all at once: each is a JVM or similar
 * booting up, and ten at a time on a laptop makes the slower ones time out.
 */
const CONCURRENCY = 4;

/** First host port to publish performers on. Deliberately away from the usual 8060. */
const BASE_PORT = 18060;

function helpText(): string {
  const p = runScriptPrefix("caps");
  return `Show the FIT capabilities each SDK's performer reports.

Usage:
  ${p} table [--sdks <sdk,sdk>] [--tag <tag>]
  ${p} sync <path-to-transactions-fit-performer>
  ${p} --help

Subcommands:
  table   Start every SDK's performer, call the performerCapsFetch RPC, and print a
          capability × SDK matrix. Also writes a Markdown version (with the Jira
          column) to the run's artifact directory.
            --sdks   Only query these SDKs (default: the operational SDKs — the
                     Analytics performers do not implement this RPC).
            --tag    Performer image tag to use (default: ${DEFAULT_PERFORMER_IMAGE_TAG}).
            --cap    Only show which SDKs have this one capability, by its name in
                     caps.json5 (e.g. --cap SDK_KV_RANGE_SCAN). The full Markdown
                     artifact is still written.

  sync    Refresh caps.json5 from the FIT protos in a transactions-fit-performer
          checkout. Adds capabilities the protos have gained; never overwrites the
          jira/description/notes you have written.

Capability metadata (including the Jira ticket for each cap) lives in caps.json5.`;
}

/** Run `worker` over `items`, at most `limit` at a time. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Resolve `--sdks java,go` into SDKs.
 *
 * The default is the operational SDKs. The Analytics performers are left out because
 * they answer performerCapsFetch with UNIMPLEMENTED — they're driven by the separate
 * columnar-test-driver — so including them by default would mean pulling two large
 * images on every run to render two columns of "?". `--sdks analytics-java` still
 * works if you want to check whether that's changed.
 */
export function resolveSdks(csv: string | undefined): Sdk[] {
  if (!csv) return [...OPERATIONAL_SDKS];

  const requested = csv
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return requested.map((value) => {
    const sdk = SDKS.find((candidate) => candidate.value === value);
    if (!sdk) {
      throw new Error(`Unknown SDK "${value}". Known SDKs: ${SDKS.map((s) => s.value).join(", ")}.`);
    }
    return sdk;
  });
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

async function cmdTable(argv: string[]): Promise<RunOutput> {
  const sdks = resolveSdks(flagValue(argv, "--sdks"));
  const tag = flagValue(argv, "--tag");
  const capName = flagValue(argv, "--cap");
  const capsFile = loadCapsFile();

  // Fail fast on a typo'd --cap before spending minutes pulling and starting
  // performer images to answer a question we can already tell is unanswerable.
  const cap = capName ? findCap(capsFile, capName) : undefined;
  if (capName && (!cap || cap.length === 0)) {
    throw new Error(`Unknown capability "${capName}". Run 'fit caps table' to see the full list, or 'fit caps sync' if it's new.`);
  }
  if (cap && cap.length > 1) {
    throw new Error(`"${capName}" matches a cap in more than one group (${cap.map((c) => c.group).join(", ")}) — this shouldn't happen, please raise it.`);
  }

  // Explain who isn't in the table, rather than leaving a reader to wonder where they
  // went: the Analytics performers don't implement this RPC.
  if (!flagValue(argv, "--sdks")) {
    const analytics = SDKS.filter(isAnalyticsSdk);
    console.log(
      `Note: the Analytics performers (${analytics.map((s) => s.value).join(", ")}) do not implement performerCapsFetch,` +
        ` so are not fetched by default. Add them with --sdks if you want to check that again.\n`,
    );
  }

  console.log(`Fetching capabilities from ${sdks.length} performers (${sdks.map((s) => s.value).join(", ")})...`);
  console.log(`Each is started from its ${tag ?? DEFAULT_PERFORMER_IMAGE_TAG} image, asked for its caps, then stopped. No cluster is needed.\n`);

  // Log in once before the fan-out; otherwise every worker that needs a pull discovers
  // it at the same moment and they all race to run `docker login`.
  let loggedIn = false;
  try {
    loggedIn = await ensureGhcrLogin();
  } catch {
    // Report this per-SDK below (as a pull failure) rather than losing the whole run.
  }

  const results: CapsFetchResult[] = await mapWithConcurrency(sdks, CONCURRENCY, (sdk, index) =>
    fetchCapsForSdk(sdk, { tag, port: BASE_PORT + index, loggedIn }),
  );

  printWithoutTimestamps(`\n${cap ? formatCapFocusReport(cap[0], results) : formatCapsReport(capsFile, results)}\n`);

  const markdownPath = join(ensureRunDir(), "fit-caps.md");
  writeFileSync(markdownPath, formatCapsMarkdown(capsFile, results));

  const failed = results.filter((result) => result.status === "error");
  if (failed.length > 0) {
    fitCliWarn(`${failed.length} of ${results.length} performers could not be queried — see the table above.`);
  }

  const answered = results.filter((result) => result.status === "ok").length;
  return {
    artifacts: [artifactFromPath(markdownPath, "Capability matrix, with Jira tickets and descriptions", ensureRunDir())],
    details: [
      { label: "Performers queried", value: String(results.length) },
      { label: "Performers that answered", value: String(answered) },
      { label: "Capability metadata", value: DEFAULT_CAPS_PATH },
    ],
  };
}

function cmdSync(argv: string[]): void {
  const [repoDir, ...extra] = argv;
  if (!repoDir || extra.length > 0) {
    console.error(`Usage: ${runScriptPrefix("caps")} sync <path-to-transactions-fit-performer>`);
    process.exit(2);
  }

  const existing = loadCapsFile();
  const { capsFile, added, removed } = syncCapsFile(repoDir, existing);
  writeFileSync(DEFAULT_CAPS_PATH, formatCapsFile(capsFile));

  console.log(`✓ Synced ${DEFAULT_CAPS_PATH} from the protos in ${repoDir}`);
  if (added.length > 0) {
    console.log(`\nNew capabilities (these need a Jira ticket adding in caps.json5):`);
    for (const name of added) console.log(`  + ${name}`);
  }
  if (removed.length > 0) {
    console.log(`\nNo longer defined in the protos (kept in caps.json5 so you can decide):`);
    for (const name of removed) console.log(`  - ${name}`);
  }
  if (added.length === 0 && removed.length === 0) {
    console.log("caps.json5 was already up to date.");
  }
}

export function runCapsMain(): void {
  const [subcommand, ...rest] = process.argv.slice(2);

  runCli(async () => {
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      console.log(helpText());
      if (!subcommand) process.exit(2);
      return;
    }

    if (subcommand === "table") {
      return await cmdTable(rest);
    }

    if (subcommand === "sync") {
      cmdSync(rest);
      return;
    }

    console.error(`Unknown subcommand: ${subcommand}\n`);
    console.error(helpText());
    process.exit(2);
  });
}

if (isMain(import.meta.url)) {
  runCapsMain();
}
