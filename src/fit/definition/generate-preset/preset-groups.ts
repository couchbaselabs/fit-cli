/**
 * `presets/groups.json5` — named groups of presets, so a single name (e.g.
 * `all-release`) can stand in for a comma-separated list of presets when
 * listing or running them. A group's members may be plain preset names or
 * other group names — `expandPresetGroupNames` resolves nesting recursively
 * down to concrete preset names.
 *
 *   bun src/fit/definition/generate-preset/preset-groups.ts all-release
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { isMain } from "../../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../../util/non-fit/fit-cli-log.js";
import { autoDescribeName, formatTaggedListing, isPresetType, presetDescriptions, type PresetType } from "./generate-preset.js";

const GROUPS_FILENAME = "groups.json5";

interface RawPresetGroup {
  /** Hand-authored description, if this group has one — see `autoDescribeName` for the fallback. */
  description?: string;
  tags: string[];
  order: number;
  /** Immediate members — plain preset names and/or other group names. */
  presets: string[];
  /** ISO date (YYYY-MM-DD) this group is slated for removal, for a back-compat alias
   * (e.g. `qe-set`). Drives the deprecation notice on its description and a warning
   * wherever it's expanded (`expandPresetGroupNames`, `fit run preset`). */
  removalDate?: string;
}

/** Throws if `name` (a group) transitively references itself. */
function checkNoCycle(name: string, groups: Record<string, RawPresetGroup>, visiting: Set<string>): void {
  const group = groups[name];
  if (!group) return; // a plain preset, not a group — nothing to recurse into.
  if (visiting.has(name)) {
    throw new Error(`presets/groups.json5: cycle detected: ${[...visiting, name].join(" -> ")}`);
  }
  visiting.add(name);
  for (const member of group.presets) {
    checkNoCycle(member, groups, visiting);
  }
  visiting.delete(name);
}

/**
 * Dev mode (bun run): reads `presets/groups.json5` from disk. Compiled binary
 * (/$bunfs/): embedded via a static import() call, same convention as
 * `presets/tags.json5` in generate-preset.ts's loadTagMeta.
 */
async function loadPresetGroups(): Promise<Record<string, RawPresetGroup>> {
  const raw = !import.meta.url.includes("/$bunfs/")
    ? readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../presets", GROUPS_FILENAME), "utf8")
    : ((await import("../../../../presets/groups.json5", { with: { type: "text" } })) as { default: string }).default;
  const parsed = JSON5.parse<Record<string, RawPresetGroup>>(raw);
  for (const [name, group] of Object.entries(parsed)) {
    for (const member of group.presets) {
      if (!isPresetType(member) && !(member in parsed)) {
        // `PresetType` is just `string`, so the `isPresetType` check above narrows `member`
        // to `never` here — the `String()` wrap is only to satisfy the linter.
        throw new Error(`presets/groups.json5: group "${name}" references unknown preset or group "${String(member)}"`);
      }
    }
  }
  for (const name of Object.keys(parsed)) {
    checkNoCycle(name, parsed, new Set());
  }
  return parsed;
}

const PRESET_GROUPS = await loadPresetGroups();

export function isPresetGroupName(value: string): boolean {
  return value in PRESET_GROUPS;
}

export interface PresetGroupDescription {
  name: string;
  description: string;
  tags: string[];
  order: number;
  /** Immediate members — plain preset names and/or other group names. */
  presets: string[];
  removalDate?: string;
}

/** The deprecation clause for a group with `removalDate` set, or undefined otherwise —
 * shared between the full `description` (below) and `listPresetsAndGroups`'s trimmed
 * group line, which drops the rest of the description but keeps this. */
function deprecationNotice(removalDate: string | undefined): string | undefined {
  return removalDate ? `DEPRECATED — will be removed after ${removalDate}.` : undefined;
}

function withDeprecationNotice(description: string, removalDate: string | undefined): string {
  const notice = deprecationNotice(removalDate);
  return notice ? `${description} ${notice}` : description;
}

export function presetGroupDescriptions(): PresetGroupDescription[] {
  return Object.entries(PRESET_GROUPS).map(([name, { description, tags, order, presets, removalDate }]) => ({
    name,
    description: withDeprecationNotice(description ?? autoDescribeName(name, tags), removalDate),
    tags,
    order,
    presets,
    removalDate,
  }));
}

/** Bare group names and their immediate members, for embedding in usage/error messages. */
export function formatKnownPresetGroups(): string {
  return presetGroupDescriptions()
    .map(({ name, presets }) => `  ${name}: ${presets.join(", ")}`)
    .join("\n");
}

/**
 * Render every known preset and preset group, intermingled and grouped by tag.
 * Presets show their description; groups only show their immediate members
 * (which may themselves be group names) plus a deprecation notice if they have
 * one — group descriptions get long fast once a group has several members, so
 * they're dropped here (see the `--verbose` hint printed once at the end) rather
 * than shown per-entry.
 *
 * Shared by `listPresetsAndGroups` (`fit preset list`) and `unknownNameError`,
 * so a typo'd preset/group name gets exactly the same listing a user would see
 * by running `fit preset list` themselves.
 */
export function formatPresetsAndGroupsListing(): string {
  const entries = [
    ...presetDescriptions().map((p) => ({ type: p.type, tags: p.tags, description: p.description })),
    ...presetGroupDescriptions().map((g) => {
      const notice = deprecationNotice(g.removalDate);
      return {
        type: g.name,
        tags: g.tags,
        description: `[groups: ${g.presets.join(", ")}]${notice ? ` ${notice}` : ""}`,
        isGroup: true,
      };
    }),
  ];
  return (
    `\nAvailable presets and preset groups:\n\n` +
    "Naming convention: <SDK type>-<cluster type>[-<modifier>]-<test type>-<test effort>\n" +
    "  Examples: op-onprem-func-lite, op-capella-pe-sit-release\n" +
    '  SDK type      — "op" for operational; may be omitted for some cases, such as Analytics.\n' +
    '  Cluster type  — "onprem", "capella", "enterprise-analytics", "columnar", "insights", and "multi" for multiple types.\n' +
    '  Modifiers     — optional; e.g. "pe" for Private Endpoint.\n' +
    '  Test type     — "func"tional or "sit"uational.\n' +
    "  Test effort   — lite | release | sanity.\n\n" +
    formatTaggedListing(entries) +
    `\nPreset groups above don't show a description — run \`${runScriptPrefix("preset")} expand <name> --verbose\` to see each preset it expands to, listed with its own description.\n`
  );
}

/** Print every known preset and preset group — see `formatPresetsAndGroupsListing`. */
export function listPresetsAndGroups(): void {
  console.log(formatPresetsAndGroupsListing());
}

/** Throws with the same listing `fit preset list` shows, so a typo'd name is easy to correct. */
function unknownNameError(name: string): Error {
  return new Error(`Unknown preset or preset group: ${name}\n${formatPresetsAndGroupsListing()}`);
}

function expandName(name: string, visiting: Set<string>, out: string[]): void {
  if (isPresetType(name)) {
    out.push(name);
    return;
  }
  if (isPresetGroupName(name)) {
    // `PresetType` is just `string`, so the `isPresetType` check above narrows `name`
    // to `never` from here on — `String(name)` below is only to satisfy the linter.
    // checkNoCycle at load time already guarantees no cycles reachable from a
    // top-level group, so `visiting` here is just defensive.
    if (visiting.has(name)) {
      throw new Error(`Cycle detected in preset groups: ${[...visiting, name].join(" -> ")}`);
    }
    const removalDate = PRESET_GROUPS[name].removalDate;
    if (removalDate) {
      process.stderr.write(`Warning: preset group "${String(name)}" is deprecated and will be removed after ${removalDate}.\n`);
    }
    visiting.add(name);
    for (const member of PRESET_GROUPS[name].presets) {
      expandName(member, visiting, out);
    }
    visiting.delete(name);
    return;
  }
  throw unknownNameError(name);
}

/**
 * Expand a comma-separated list of preset and/or preset-group names into a
 * flat list of concrete preset names, in order — group names (including
 * nested groups) are resolved recursively; plain preset names pass through
 * unchanged. Throws on any name that is neither a known preset nor a known group.
 */
export function expandPresetGroupNames(namesCsv: string): PresetType[] {
  const names = namesCsv.split(",").map((name) => name.trim());
  const out: PresetType[] = [];
  for (const name of names) {
    expandName(name, new Set(), out);
  }
  return out;
}

if (isMain(import.meta.url)) {
  const [namesCsv] = process.argv.slice(2);
  if (!namesCsv || namesCsv === "-h" || namesCsv === "--help") {
    console.log("Usage: bun src/fit/definition/generate-preset/preset-groups.ts <preset-or-group>[,<preset-or-group>...]");
    process.exit(namesCsv ? 0 : 2);
  }
  console.log(expandPresetGroupNames(namesCsv).join(","));
}
