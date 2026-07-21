/**
 * Step: list the prebuilt performer container images published to GHCR for an
 * SDK (or, with no SDK, for every SDK that publishes one).
 *
 * Run on its own:
 *   bun src/fit/performer/list/list-performer.ts scala
 *   bun src/fit/performer/list/list-performer.ts scala --limit 10
 *   bun src/fit/performer/list/list-performer.ts            # every SDK
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliWarn, runScriptPrefix } from "../../../util/non-fit/fit-cli-log.js";
import type { RunOutput, Detail } from "../../../util/non-fit/artifacts.js";
import { resolveGithubToken } from "../../util/config.js";
import {
  SDKS,
  sdkByPerformerImageBasename,
  sdkByValue,
  type Sdk,
} from "../../../util/sdk/sdks.js";
import {
  collectContainerTags,
  fetchGhcrPackageVersions,
} from "../../performers/list-docker-containers/list-docker-containers.js";
import {
  performerImageShortName,
  performerPackageUrl,
} from "../../performers/util/performer-image.js";

/** Default number of tags shown per SDK — GHCR keeps every build, so cap the dump. */
const DEFAULT_TAG_LIMIT = 30;

/**
 * A GHCR version object can carry zero or several tags, so fetch a generous
 * multiple of the requested tag count before flattening and slicing to `limit`.
 * This bounds the paged API work while still filling the limit in the common case.
 */
const VERSIONS_PER_TAG_FETCH_MULTIPLIER = 4;

/**
 * Resolve the `list` positional into the SDKs to list. No argument means every
 * SDK that publishes a performer image; an argument selects a single SDK by its
 * value (e.g. `scala`) or its image basename (e.g. `cxx`).
 */
export function resolvePerformerListSdks(arg?: string): Sdk[] | { error: string } {
  const trimmed = arg?.trim();
  if (!trimmed) {
    return [...SDKS];
  }

  const sdk = sdkByValue(trimmed) ?? sdkByPerformerImageBasename(trimmed);
  if (!sdk) {
    const supported = SDKS.map((s) => s.value).join(", ");
    return { error: `Unknown SDK "${trimmed}". Supported SDKs: ${supported}.` };
  }
  return [sdk];
}

/**
 * Fetch up to `limit` container tags for one SDK's performer image. Tags come in
 * GHCR's returned order (newest first in practice, though GHCR's sort is
 * undocumented — so `limit` drops whatever falls at the end of that order).
 */
async function listSdkTags(sdk: Sdk, token: string, limit: number): Promise<string[]> {
  const versions = await fetchGhcrPackageVersions(
    performerPackageUrl(sdk),
    token,
    limit * VERSIONS_PER_TAG_FETCH_MULTIPLIER,
  );
  return collectContainerTags(versions).slice(0, limit);
}

/** List prebuilt performer containers for one or all SDKs and report the tags. */
export async function listPerformerContainers(arg: string | undefined, limit: number): Promise<RunOutput> {
  const resolved = resolvePerformerListSdks(arg);
  if ("error" in resolved) {
    throw new Error(resolved.error);
  }
  const sdks = resolved;

  const token = await resolveGithubToken();
  if (!token) {
    throw new Error(
      "A GitHub token is required to list performer containers from GHCR. Set GITHUB_TOKEN or GH_TOKEN," +
        " or add one via `fit config edit`.",
    );
  }

  const details: Detail[] = [];
  const single = sdks.length === 1;

  for (const sdk of sdks) {
    let tags: string[];
    try {
      tags = await listSdkTags(sdk, token, limit);
    } catch (err) {
      fitCliWarn(`Could not list ${sdk.name} performer containers from ${performerPackageUrl(sdk)}: ${(err as Error).message}`);
      details.push({ label: sdk.name, value: `(could not list — ${(err as Error).message})` });
      continue;
    }

    console.log(`\n${sdk.name} (${performerPackageUrl(sdk)}):`);
    if (tags.length === 0) {
      console.log("  (no tagged containers found)");
      details.push({ label: sdk.name, value: "(no tagged containers)" });
      continue;
    }

    for (const tag of tags) {
      console.log(`  ${performerImageShortName(sdk, tag)}`);
    }

    if (single) {
      // One SDK: each tag is a row, so the summary table is the deliverable itself.
      for (const tag of tags) {
        details.push({ label: sdk.name, value: performerImageShortName(sdk, tag) });
      }
    } else {
      // Many SDKs: one row each keeps the summary table readable.
      details.push({ label: sdk.name, value: `${tags.length} container${tags.length === 1 ? "" : "s"} (latest: ${tags[0]})` });
    }
  }

  return { artifacts: [], details };
}

function helpText(): string {
  const sdks = SDKS.map((s) => s.value).join(", ");
  return `List the prebuilt performer container images published to GHCR for an SDK.

Usage:
  ${runScriptPrefix("performer")} list [<sdk>] [--limit N]
  ${runScriptPrefix("performer")} list --help

  sdk      SDK to list containers for (${sdks}). Omit to list every SDK.
  --limit  Show up to this many most-recent tags per SDK (default ${DEFAULT_TAG_LIMIT}).

Example:
  ${runScriptPrefix("performer")} list scala`;
}

export async function runPerformerListMain(argv: string[]): Promise<RunOutput | void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(helpText());
    return;
  }

  let limit = DEFAULT_TAG_LIMIT;
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") {
      const value = argv[i + 1];
      const parsed = value === undefined ? NaN : Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        console.error(`--limit must be a positive integer; got ${JSON.stringify(value ?? "")}.\n`);
        console.error(helpText());
        process.exit(2);
      }
      limit = parsed;
      i++;
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}\n`);
      console.error(helpText());
      process.exit(2);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length > 1) {
    console.error(`Expected at most one SDK argument; got ${positionals.join(" ")}.\n`);
    console.error(helpText());
    process.exit(2);
  }

  return listPerformerContainers(positionals[0], limit);
}

if (isMain(import.meta.url)) {
  runCli(() => runPerformerListMain(process.argv.slice(2)));
}
