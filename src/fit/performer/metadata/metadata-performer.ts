/**
 * Step: show all metadata available for a performer image — the Docker image
 * labels baked in at build time, plus everything the performer itself reports
 * over performerCapsFetch (user agent, library version, transactions protocol,
 * and every capability it claims).
 *
 * Run on its own:
 *   bun src/fit/performer/metadata/metadata-performer.ts scala
 *   bun src/fit/performer/metadata/metadata-performer.ts scala 1.2.3
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../../util/non-fit/fit-cli-log.js";
import type { Detail, RunOutput } from "../../../util/non-fit/artifacts.js";
import {
  SDKS,
  sdkByPerformerImageBasename,
  sdkByValue,
  type Sdk,
} from "../../../util/sdk/sdks.js";
import { performerImageName, validatePerformerVersion } from "../../performers/util/performer-image.js";
import { performerImageLabelsArgs, USEFUL_IMAGE_LABELS } from "../../performers/check-performer/check-performer.js";
import { createLocalFitExecutionContext } from "../../shared/util/remote-fit-run.js";
import { ensurePerformerImage, fetchCapsForSdk } from "../../caps/fetch-caps/fetch-caps.js";
import { CAP_GROUPS, capDisplayName, capsByNumber, loadCapsFile, type CapGroup, type CapsFile } from "../../caps/util/caps-metadata.js";
import { reportedNumbers } from "../../caps/util/caps-table.js";
import type { PerformerCaps } from "../../caps/util/performer-caps-rpc.js";

function helpText(): string {
  const sdks = SDKS.map((s) => s.value).join(", ");
  return `Show all metadata available for a performer image: the Docker image labels
baked in at build time, plus everything the performer reports over
performerCapsFetch (user agent, library version, transactions protocol, and
every capability it claims).

Usage:
  ${runScriptPrefix("performer")} metadata <sdk> [version]
  ${runScriptPrefix("performer")} metadata --help

  sdk      SDK performer to inspect (${sdks}).
  version  Performer image tag to inspect. Omit for the SDK's default (usually "main").

The image is pulled from GHCR if it isn't already local. The performer is then
started on a throwaway port to answer performerCapsFetch, and stopped again.

Example:
  ${runScriptPrefix("performer")} metadata scala`;
}

/** Resolve the SDK argument, accepting either its value or its performer image basename. */
export function resolveMetadataSdk(sdkValue: string): Sdk | { error: string } {
  const sdk = sdkByValue(sdkValue) ?? sdkByPerformerImageBasename(sdkValue);
  if (!sdk) {
    const supported = SDKS.map((s) => s.value).join(", ");
    return { error: `Unknown SDK "${sdkValue}". Supported SDKs: ${supported}.` };
  }
  return sdk;
}

/** Render the useful OCI/Couchbase labels baked into a performer image, alongside their raw label key. */
export function formatImageLabels(labels: Record<string, string> | null): string {
  if (!labels) return "  (image has no labels)";
  const entries = USEFUL_IMAGE_LABELS.map(({ key, label }) => ({ key, label, value: labels[key] })).filter(({ value }) => value);
  if (entries.length === 0) return "  (image has no labels fit-cli recognises)";
  const labelPadTo = Math.max(...entries.map((e) => e.label.length));
  const keyPadTo = Math.max(...entries.map((e) => e.key.length));
  return entries.map(({ key, label, value }) => `  ${label.padEnd(labelPadTo)}  ${key.padEnd(keyPadTo)}  ${value}`).join("\n");
}

const GROUP_NAMES: Record<CapGroup, string> = {
  sdk: "SDK capabilities",
  transactions: "Transactions capabilities",
  performer: "Performer capabilities",
};

/** Render every capability a performer reported over performerCapsFetch, by group. */
export function formatPerformerCaps(capsFile: CapsFile, caps: PerformerCaps): string {
  const lines: string[] = [
    `  User agent:            ${caps.userAgent ?? "(none)"}`,
    `  Library version:       ${caps.libraryVersion ?? "(none)"}`,
    `  Transactions protocol: ${caps.transactionsProtocolVersion ?? "(none)"}`,
    `  Supported APIs:        ${caps.supportedApis.length > 0 ? caps.supportedApis.join(", ") : "DEFAULT only"}`,
    "",
  ];

  for (const group of CAP_GROUPS) {
    const byNumber = capsByNumber(capsFile, group);
    const names = [...reportedNumbers(caps, group)].sort((a, b) => a - b).map((number) => capDisplayName(byNumber, number));
    lines.push(`  ${GROUP_NAMES[group]} (${names.length}):`);
    lines.push(names.length > 0 ? names.map((name) => `    ${name}`).join("\n") : "    (none reported)");
  }

  return lines.join("\n");
}

export async function runPerformerMetadataMain(argv: string[]): Promise<RunOutput | void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(helpText());
    return;
  }

  const [sdkValue, version, ...extra] = argv;
  if (!sdkValue || extra.length > 0) {
    console.error(helpText());
    process.exit(2);
  }

  const resolved = resolveMetadataSdk(sdkValue);
  if ("error" in resolved) {
    console.error(`${resolved.error}\n`);
    console.error(helpText());
    process.exit(2);
  }
  const sdk = resolved;

  if (version !== undefined) {
    const error = validatePerformerVersion(version);
    if (error !== true) {
      console.error(`${error}\n`);
      console.error(helpText());
      process.exit(2);
    }
  }

  const execution = createLocalFitExecutionContext();
  const imageName = performerImageName(sdk, version);

  console.log(`Pulling ${imageName} if it isn't already local...`);
  await ensurePerformerImage(sdk, version);

  console.log(`\nReading image labels from ${imageName}...`);
  const rawLabels = await execution.capture(execution.dockerCommand, performerImageLabelsArgs(imageName));
  const labels = JSON.parse(rawLabels.trim()) as Record<string, string> | null;

  console.log(`Starting the ${sdk.name} performer to ask what it reports over performerCapsFetch...`);
  const capsResult = await fetchCapsForSdk(sdk, { tag: version });

  console.log(`\nPerformer metadata for ${sdk.name} (${imageName})\n`);
  console.log("Image labels:");
  console.log(formatImageLabels(labels));
  console.log();

  const details: Detail[] = [{ label: "Performer image", value: imageName }];

  if (capsResult.status === "ok") {
    console.log("Capabilities (from performerCapsFetch):");
    console.log(formatPerformerCaps(loadCapsFile(), capsResult.caps));
    if (capsResult.caps.userAgent) details.push({ label: "User agent", value: capsResult.caps.userAgent });
    if (capsResult.caps.libraryVersion) details.push({ label: "Library version", value: capsResult.caps.libraryVersion });
  } else if (capsResult.status === "unimplemented") {
    console.log("Capabilities: this performer does not implement performerCapsFetch.");
  } else {
    console.log(`Capabilities: could not be fetched — ${capsResult.error}`);
    process.exitCode = 1;
  }

  return { artifacts: [], details };
}

if (isMain(import.meta.url)) {
  runCli(() => runPerformerMetadataMain(process.argv.slice(2)));
}
