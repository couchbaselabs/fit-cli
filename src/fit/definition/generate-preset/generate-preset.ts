/**
 * `bun run preset generate` — emit a ready-to-run definition file from a named
 * preset template, parameterised by performer image.
 *
 * Usage:
 *   bun run preset generate op-onprem-func-lite --performer java-fit-performer:refs-changes-67-246067-3
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { printFileContent } from "../../../util/non-fit/fit-cli-log.js";
import { resolveOutputFormat } from "../../util/config.js";
import { analysePerformerImage, performerImageShortName } from "../../performers/util/performer-image.js";
import {
  formatFitDefinition,
  writeFitDefinition,
  type DefinitionFormat,
} from "../../shared/definition/generate-definition.js";
import { describeDefinition } from "../../shared/definition/generate-desc.js";
import type { FitDefinition } from "../../shared/definition/types.js";
import { printDefinitionRunGuidance } from "../../shared/definition/run-guidance.js";
import { pushGist, type GistVisibility } from "../../shared/definition/push-gist.js";
import { loadEnvironments } from "../../util/environments.js";

/** `presets/tags.json5` holds tag metadata, not a preset — never treat it as one. */
const TAGS_FILENAME = "tags.json5";
/** `presets/groups.json5` holds preset-group definitions (see preset-groups.ts), not a preset. */
const GROUPS_FILENAME = "groups.json5";
const NON_PRESET_FILENAMES = new Set([TAGS_FILENAME, GROUPS_FILENAME]);

/**
 * Returns a map of { "<name>": "<contents>" } for every preset in `presets/`.
 *
 * Dev mode (bun run): reads `presets/` from disk — any .json5 file (other than
 * `tags.json5` / `groups.json5`) is picked up automatically.
 *
 * Compiled binary (/$bunfs/): `bun build --compile` embeds files referenced by static import()
 * calls at bundle time; import.meta.glob is not supported in compiled binaries. Add one line
 * here per preset so the compiler knows to include it.
 */
async function loadPresetMap(): Promise<Record<string, string>> {
  if (!import.meta.url.includes("/$bunfs/")) {
    const presetsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../presets");
    return Object.fromEntries(
      readdirSync(presetsDir)
        .filter(f => f.endsWith(".json5") && !NON_PRESET_FILENAMES.has(f))
        .map(f => [f.replace(/\.json5$/, ""), readFileSync(join(presetsDir, f), "utf8")]),
    );
  }
  // Path AND import options must be literals — bun build --compile only embeds modules it can
  // see as static references; passing either through a variable hides them from the bundler.
  return {
    "op-onprem-func-sanity":       ((await import("../../../../presets/op-onprem-func-sanity.json5",       { with: { type: "text" } })) as { default: string }).default,
    "op-onprem-func-lite":         ((await import("../../../../presets/op-onprem-func-lite.json5",         { with: { type: "text" } })) as { default: string }).default,
    "op-onprem-func-release":      ((await import("../../../../presets/op-onprem-func-release.json5",      { with: { type: "text" } })) as { default: string }).default,
    "op-cng-func-sanity":          ((await import("../../../../presets/op-cng-func-sanity.json5",          { with: { type: "text" } })) as { default: string }).default,
    "op-cng-func-lite":            ((await import("../../../../presets/op-cng-func-lite.json5",            { with: { type: "text" } })) as { default: string }).default,
    "op-cng-func-release":         ((await import("../../../../presets/op-cng-func-release.json5",         { with: { type: "text" } })) as { default: string }).default,
    "op-cng-sit-sanity":           ((await import("../../../../presets/op-cng-sit-sanity.json5",           { with: { type: "text" } })) as { default: string }).default,
    "op-cng-sit-lite":             ((await import("../../../../presets/op-cng-sit-lite.json5",             { with: { type: "text" } })) as { default: string }).default,
    "op-cng-sit-release":          ((await import("../../../../presets/op-cng-sit-release.json5",          { with: { type: "text" } })) as { default: string }).default,
    "op-capella-func-sanity":      ((await import("../../../../presets/op-capella-func-sanity.json5",      { with: { type: "text" } })) as { default: string }).default,
    "op-capella-func-lite":        ((await import("../../../../presets/op-capella-func-lite.json5",        { with: { type: "text" } })) as { default: string }).default,
    "op-capella-func-release":     ((await import("../../../../presets/op-capella-func-release.json5",     { with: { type: "text" } })) as { default: string }).default,
    "op-capella-sit-sanity":       ((await import("../../../../presets/op-capella-sit-sanity.json5",       { with: { type: "text" } })) as { default: string }).default,
    "op-capella-sit-lite":         ((await import("../../../../presets/op-capella-sit-lite.json5",         { with: { type: "text" } })) as { default: string }).default,
    "op-capella-sit-release":      ((await import("../../../../presets/op-capella-sit-release.json5",      { with: { type: "text" } })) as { default: string }).default,
    "op-capella-pe-func-sanity":   ((await import("../../../../presets/op-capella-pe-func-sanity.json5",   { with: { type: "text" } })) as { default: string }).default,
    "op-capella-pe-func-lite":     ((await import("../../../../presets/op-capella-pe-func-lite.json5",     { with: { type: "text" } })) as { default: string }).default,
    "op-capella-pe-func-release":  ((await import("../../../../presets/op-capella-pe-func-release.json5",  { with: { type: "text" } })) as { default: string }).default,
    "op-capella-pe-sit-sanity":    ((await import("../../../../presets/op-capella-pe-sit-sanity.json5",    { with: { type: "text" } })) as { default: string }).default,
    "op-capella-pe-sit-lite":      ((await import("../../../../presets/op-capella-pe-sit-lite.json5",      { with: { type: "text" } })) as { default: string }).default,
    "op-capella-pe-sit-release":   ((await import("../../../../presets/op-capella-pe-sit-release.json5",   { with: { type: "text" } })) as { default: string }).default,
    "enterprise-analytics-func-sanity":  ((await import("../../../../presets/enterprise-analytics-func-sanity.json5",  { with: { type: "text" } })) as { default: string }).default,
    "enterprise-analytics-func-lite":    ((await import("../../../../presets/enterprise-analytics-func-lite.json5",    { with: { type: "text" } })) as { default: string }).default,
    "enterprise-analytics-func-release": ((await import("../../../../presets/enterprise-analytics-func-release.json5", { with: { type: "text" } })) as { default: string }).default,
    "columnar-func-sanity":              ((await import("../../../../presets/columnar-func-sanity.json5",              { with: { type: "text" } })) as { default: string }).default,
    "columnar-func-lite":                ((await import("../../../../presets/columnar-func-lite.json5",                { with: { type: "text" } })) as { default: string }).default,
    "columnar-func-release":             ((await import("../../../../presets/columnar-func-release.json5",             { with: { type: "text" } })) as { default: string }).default,
  };
}

const PRESET_MAP = await loadPresetMap();

interface TagMeta {
  order: number;
  description: string;
  /** When true, this tag's heading is suppressed from `list-presets` (e.g. `functional`/
   * `situational` — every entry already carries a more specific axis tag too). Items with
   * only hidden tags still show under an `(untagged)` fallback; the terse `--help` listing
   * (`formatKnownPresetsByTag`) ignores this and shows everything. */
  hiddenFromList?: boolean;
}

/**
 * Returns { "<tag>": { order, description, hiddenFromList } } from `presets/tags.json5` —
 * metadata for the tags referenced by presets' `preset.tags`. A tag used by a preset but
 * missing here simply displays without a description and sorts after every tag that is listed.
 */
async function loadTagMeta(): Promise<Record<string, TagMeta>> {
  const raw = !import.meta.url.includes("/$bunfs/")
    ? readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../presets", TAGS_FILENAME), "utf8")
    : ((await import("../../../../presets/tags.json5", { with: { type: "text" } })) as { default: string }).default;
  return JSON5.parse<Record<string, TagMeta>>(raw);
}

const TAG_META = await loadTagMeta();

/** Tags without an `order` in `presets/tags.json5` sort after every tag that has one. */
const UNKNOWN_TAG_ORDER = Number.MAX_SAFE_INTEGER;

/** Long-form description of a tag from `presets/tags.json5`, if one is defined. */
export function describeTag(tag: string): string | undefined {
  return TAG_META[tag]?.description;
}

/** Display order of a tag from `presets/tags.json5`; unlisted tags sort last. */
function tagOrder(tag: string): number {
  return TAG_META[tag]?.order ?? UNKNOWN_TAG_ORDER;
}

function isTagHiddenFromList(tag: string): boolean {
  return TAG_META[tag]?.hiddenFromList ?? false;
}

// `preset.order` (and a group's `order` in groups.json5) is currently unused for
// sorting — display order is alphabetical everywhere now, since with the
// axis/type/tier naming convention alphabetical already reads cleanly (unlike
// the old hand-picked preset names, where order carried real meaning). The field
// stays in the schema/files rather than being ripped out, in case fine-grained
// ordering is worth reintroducing later; `tags.json5`'s `order` is a *different*
// field and is still very much live — it's the only thing controlling heading order.
export const PRESET_TYPES: string[] = Object.keys(PRESET_MAP).sort();

export type PresetType = string;

export function isPresetType(value: string): value is PresetType {
  return PRESET_TYPES.includes(value);
}

interface PresetMeta {
  order: number;
  /** Hand-authored description, if the preset template has one — see `autoDescribeName` for the fallback. */
  description?: string;
  tags: string[];
}

/** Extract metadata from a preset template's `preset` block. */
function extractPresetMeta(raw: string): PresetMeta {
  try {
    const filled = raw.replace(/\{\{PERFORMER_IMAGE\}\}/g, "placeholder");
    const parsed = JSON5.parse<{
      preset?: { order?: number; description?: string; tags?: string[] };
    }>(filled);
    return {
      order: parsed.preset?.order ?? 50,
      description: parsed.preset?.description,
      tags: parsed.preset?.tags ?? [],
    };
  } catch {
    return { order: 50, tags: [] };
  }
}

const TIER_PHRASES: Record<string, string> = {
  sanity: "quick sanity testing",
  lite: "lite-tier testing",
  release: "release sign-off testing",
};
const AXIS_PHRASES: Record<string, string> = {
  "op-onprem": "an on-prem cluster",
  "op-cng": "a CNG cluster",
  "op-capella": "a real Capella cluster",
  "enterprise-analytics": "a self-managed Enterprise Analytics cluster",
  columnar: "a Capella Analytics (cloud) cluster",
};

/** Capitalizes the first letter — used to make a mid-sentence phrase (like an SDK-family
 * name) read correctly when it opens the sentence instead. */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Which performer image family (and so which `--performer` a preset/group needs)
 * each axis token belongs to. `op-onprem`/`op-cng`/`op-capella` all use the same
 * operational SDK performer (PrivateLink doesn't change that); `enterprise-analytics`
 * and `columnar` each need their own Analytics-driver performer image — see
 * `presetUsesAnalyticsDriver`. This is why the `<family>-multi-*` groups (below) are
 * scoped per family rather than one universal group: mixing families would mean
 * a single `--performer` value is wrong for some of the group's members.
 *
 * The bare `op` entry is for the `op-multi-*` cross-cluster groups specifically —
 * their name has no cluster token at all (e.g. `op-multi-func-sanity`), so once
 * `multi` is popped in `autoDescribeName`, the remaining axis is just `op`.
 */
const SDK_FAMILY_PHRASES: Record<string, string> = {
  op: "operational SDK",
  "op-onprem": "operational SDK",
  "op-cng": "operational SDK",
  "op-capella": "operational SDK",
  "enterprise-analytics": "Enterprise Analytics SDK",
  columnar: "Columnar SDK",
};

/**
 * Generate a human-readable description from a preset/group name, for entries that
 * don't hand-author a `description` — the `<axis>[-pe]-<func|sit>-<tier>` naming
 * convention, and its `<family>-multi-<func|sit>-<tier>` / `<family>-multi-<tier>`
 * cross-axis variant (see presets/groups.json5's header comment), are regular
 * enough to describe automatically. Whether it reads as functional, situational,
 * or both comes from `tags` (the entry's real composition), not from parsing the
 * name's func/sit token — that matters for groups, where the name alone can't
 * tell you what's inside.
 */
export function autoDescribeName(name: string, tags: string[]): string {
  const tokens = name.split("-");
  const tier = tokens.pop();
  if (!tier || !(tier in TIER_PHRASES)) return name;
  // Strip the func/sit token (closest to the tier) before the `pe` sub-axis token
  // (closer to the axis) — matches the `<axis>-pe-<func|sit>-<tier>` naming order.
  if (tokens.at(-1) === "func" || tokens.at(-1) === "sit") tokens.pop();
  let isPe = false;
  if (tokens.at(-1) === "pe") {
    isPe = true;
    tokens.pop();
  }
  let crossAxis = false;
  if (tokens.at(-1) === "multi") {
    crossAxis = true;
    tokens.pop();
  }
  const axis = tokens.join("-");
  const hasFunc = tags.includes("functional");
  const hasSit = tags.includes("situational");
  const typeWord = hasFunc && hasSit ? "functional and situational" : hasFunc ? "functional" : hasSit ? "situational" : "general";
  const peSuffix = isPe ? " via Private Endpoint (PrivateLink)" : "";
  const tierPhrase = TIER_PHRASES[tier];
  const familyPhrase = capitalize(SDK_FAMILY_PHRASES[axis] ?? axis);
  if (crossAxis) {
    return `${familyPhrase} ${typeWord} testing across every axis (${tierPhrase}).`;
  }
  return `${familyPhrase} ${typeWord} testing against ${AXIS_PHRASES[axis] ?? axis}${peSuffix} (${tierPhrase}).`;
}

/**
 * Whether a preset has any `analytics-functional` run (Analytics tests via the
 * Analytics test-driver). Such presets need an Analytics SDK performer image
 * (Columnar SDK or Enterprise Analytics SDK), so the interactive flow offers
 * those rather than the operational SDKs.
 */
export function presetUsesAnalyticsDriver(type: PresetType): boolean {
  try {
    const filled = loadPresetTemplate(type).replace(/\{\{PERFORMER_IMAGE\}\}/g, "placeholder");
    const parsed = JSON5.parse<FitDefinition>(filled);
    return (parsed.instances ?? []).some((instance) =>
      [...(instance.clusterlessSessions ?? []), ...(instance.clusters ?? []).flatMap((c) => c.sessions)]
        .flatMap((s) => s.runs)
        .some((run) => run.type === "analytics-functional"),
    );
  } catch {
    return false;
  }
}

/**
 * Alphabetical by name (see the comment on `PRESET_TYPES` for why `order` isn't
 * used here) — but plain presets always sort before groups, so a tag heading reads
 * as "here are the presets, here are the groups that combine them" rather than
 * interleaving the two by name.
 */
function sortedPresetItems<T extends { type: PresetType; isGroup?: boolean }>(items: T[]): T[] {
  return [...items].sort((a, b) => Number(a.isGroup ?? false) - Number(b.isGroup ?? false) || a.type.localeCompare(b.type));
}

const UNTAGGED = "(untagged)";

/**
 * Group presets by tag for display. A preset with multiple tags (e.g. a
 * private-endpoint preset that's also functional) appears under each of its
 * tags' groups, since tags here represent cross-cutting concerns rather than
 * a strict single category.
 *
 * `showHidden` (default false) controls whether tags marked `hiddenFromList` in
 * presets/tags.json5 get their own heading — off for the curated `list-presets`
 * view, on for "unknown preset" error text, which should show everything.
 */
export function groupPresetsByTag<T extends { type: PresetType; tags: string[]; isGroup?: boolean }>(
  items: T[],
  { showHidden = false }: { showHidden?: boolean } = {},
): { tag: string; items: T[] }[] {
  const byTag = new Map<string, T[]>();
  for (const item of items) {
    const tags = showHidden ? item.tags : item.tags.filter((t) => !isTagHiddenFromList(t));
    for (const tag of tags.length > 0 ? tags : [UNTAGGED]) {
      const list = byTag.get(tag) ?? [];
      list.push(item);
      byTag.set(tag, list);
    }
  }
  // Groups are ordered by each tag's `order` in presets/tags.json5 (ties broken
  // alphabetically); tags with no metadata there sort after every known tag, and
  // the untagged bucket always sorts last.
  return [...byTag.entries()]
    .map(([tag, tagItems]) => ({ tag, items: sortedPresetItems(tagItems) }))
    .sort((a, b) => {
      if (a.tag === UNTAGGED) return 1;
      if (b.tag === UNTAGGED) return -1;
      return tagOrder(a.tag) - tagOrder(b.tag) || a.tag.localeCompare(b.tag);
    });
}

interface PresetDescription {
  type: PresetType;
  description: string;
  tags: string[];
  order: number;
}

function allPresetDescriptions(): PresetDescription[] {
  const items = PRESET_TYPES.map((type) => {
    const { order, description, tags } = extractPresetMeta(loadPresetTemplate(type));
    return { type, description: description ?? autoDescribeName(type, tags), tags, order };
  });
  return sortedPresetItems(items);
}

/** Available preset types paired with their descriptions and tags, for menus. */
export function presetDescriptions(): PresetDescription[] {
  return allPresetDescriptions();
}

/**
 * Render a set of tag-grouped items as `fit preset list` does: one heading per
 * tag (with its description, if any), then each item indented with its own
 * description, padded to a common column. Shared by `formatKnownPresetsWithDescriptions`
 * below and `preset-groups.ts`'s `formatPresetsAndGroupsListing`, which adds
 * preset groups into the same item list before calling this.
 */
export function formatTaggedListing<T extends { type: PresetType; tags: string[]; description: string; isGroup?: boolean }>(
  items: T[],
  { showHidden = false }: { showHidden?: boolean } = {},
): string {
  const groups = groupPresetsByTag(items, { showHidden });
  const col = groups.reduce((max, { items: groupItems }) => groupItems.reduce((m, { type }) => Math.max(m, type.length), max), 0);
  const lines: string[] = [];
  for (const { tag, items: groupItems } of groups) {
    const tagDescription = describeTag(tag);
    lines.push(tagDescription ? `${tag}: ${tagDescription}` : `${tag}:`);
    for (const { type, description } of groupItems) {
      lines.push(`  ${type.padEnd(col)}  ${description}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Bare preset names grouped by tag (no descriptions) — for the terse `--help`
 * text, which already points readers at `fit preset list` for full detail.
 */
export function formatKnownPresetsByTag(): string {
  const groups = groupPresetsByTag(allPresetDescriptions(), { showHidden: true });
  return groups.map(({ tag, items }) => `  ${tag}: ${items.map(({ type }) => type).join(", ")}`).join("\n");
}

/**
 * Every known preset, grouped by tag with its description — for embedding in
 * "unknown preset" error messages, matching `fit preset list`'s format.
 */
export function formatKnownPresetsWithDescriptions(): string {
  return formatTaggedListing(allPresetDescriptions());
}

function resolvePresetOutputFormat(outputPath: string | undefined, format: DefinitionFormat | undefined): DefinitionFormat {
  if (format) {
    return format;
  }
  const extension = outputPath ? extname(outputPath).toLowerCase() : "";
  if (extension === ".yaml" || extension === ".yml") {
    return "yaml";
  }
  if (extension === ".json5") {
    return "json5";
  }
  return resolveOutputFormat();
}

function loadPresetTemplate(type: string): string {
  const content = PRESET_MAP[type];
  if (content === undefined) throw new Error(`Unknown preset: ${type}\nKnown presets:\n${formatKnownPresetsWithDescriptions()}`);
  return content;
}

/**
 * Look up a dot-path in `environments.json5`, e.g. `defaults.clusterVersion`.
 * Returns undefined if any segment is missing.
 */
function lookupEnvironmentsPath(dotPath: string): unknown {
  let cursor: unknown = loadEnvironments();
  for (const key of dotPath.split(".")) {
    if (cursor === null || typeof cursor !== "object" || !(key in cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * Validate `--env-override` dot-paths against `environments.json5`, so a typo
 * (`defualts.clusterVersion`) fails loudly rather than silently doing nothing.
 *
 * A path only has to exist — it does NOT have to be referenced by the preset(s)
 * being generated. A group run deliberately applies one override across presets
 * that use different keys (`defaults.clusterVersion` on-prem vs
 * `defaults.capellaClusterVersion` on Capella), so an override that no-ops for
 * some members of the group is expected, not an error.
 */
export function validateEnvOverrides(envOverrides: Record<string, string>): void {
  for (const dotPath of Object.keys(envOverrides)) {
    const existing = lookupEnvironmentsPath(dotPath);
    if (existing === undefined) {
      throw new Error(
        `--env-override "${dotPath}" is not a path in environments.json5. ` +
          `Expected something like: defaults.clusterVersion, defaults.capellaClusterVersion, defaults.cngClusterVersion.`,
      );
    }
    if (typeof existing !== "string" && typeof existing !== "number") {
      throw new Error(
        `--env-override "${dotPath}" must target a string or number in environments.json5, but it is: ${JSON.stringify(existing)}.`,
      );
    }
  }
}

/** Every `{{environments.<dot.path>}}` path the given presets template in. */
export function envPlaceholderPaths(types: PresetType[]): Set<string> {
  const paths = new Set<string>();
  for (const type of types) {
    for (const [, dotPath] of loadPresetTemplate(type).matchAll(/\{\{environments\.([\w.]+)\}\}/g)) {
      paths.add(dotPath);
    }
  }
  return paths;
}

/**
 * Reject an `--env-override` that no preset in this run actually templates in — it
 * would otherwise be a silent no-op, which is the worst possible outcome for a flag
 * whose whole job is to change the cluster under test. The classic trap: passing
 * `defaults.clusterVersion` (the on-prem key, and a perfectly valid path in
 * environments.json5, so `validateEnvOverrides` is happy) to a Capella preset, which
 * templates `defaults.capellaClusterVersion` instead.
 *
 * Checked against the whole expanded preset set, and satisfied by ANY one of them: a
 * group legitimately spans presets keyed on different versions, so an override that
 * applies to only some members is fine — one that applies to none is not.
 */
export function assertEnvOverridesUsed(types: PresetType[], envOverrides: Record<string, string>): void {
  const used = envPlaceholderPaths(types);
  const unused = Object.keys(envOverrides).filter((dotPath) => !used.has(dotPath));
  if (unused.length === 0) {
    return;
  }
  const target = types.length === 1 ? `preset "${types[0]}"` : `presets: ${types.join(", ")}`;
  throw new Error(
    `--env-override ${unused.map((p) => `"${p}"`).join(", ")} would have no effect: not templated by the ${target}.\n` +
      `That ${target.startsWith("preset") ? "preset templates" : "set templates"} in: ${[...used].sort().join(", ") || "(nothing)"}.`,
  );
}

/**
 * Resolve every `{{environments.<dot.path>}}` placeholder in a preset template
 * against `environments.json5`, e.g. `{{environments.defaults.clusterVersion}}`
 * → `8.0-stable`. This is the single source of truth for cluster/tool versions —
 * bumping a version in `environments.json5` updates every preset that references it.
 *
 * `envOverrides` (from `--env-override <dot.path>=<value>`) takes precedence for
 * the paths it names, letting a run pin e.g. a different cluster version without
 * editing `environments.json5`. The resolved value is baked into the generated
 * definition file, so the run stays reproducible from that file alone.
 *
 * Override values are substituted as raw strings, never JSON-parsed: version
 * strings like `8.0` must stay `"8.0"` rather than becoming the number 8.
 */
export function resolveEnvironmentsPlaceholders(template: string, envOverrides: Record<string, string> = {}): string {
  return template.replace(/\{\{environments\.([\w.]+)\}\}/g, (match, dotPath: string) => {
    const override = envOverrides[dotPath];
    if (override !== undefined) {
      return override;
    }
    const value = lookupEnvironmentsPath(dotPath);
    if (value === undefined) {
      throw new Error(`Unknown environments.json5 path in preset placeholder: ${match}`);
    }
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`Preset placeholder ${match} must resolve to a string or number, got: ${JSON.stringify(value)}`);
    }
    return String(value);
  });
}

/**
 * Fill the `{{PERFORMER_IMAGE}}` and `{{environments.*}}` placeholders and
 * return a parsed FitDefinition. `image` is the short-form `<sdk>-fit-performer:<tag>`.
 */
function applyPresetParams(template: string, image: string, envOverrides: Record<string, string> = {}): FitDefinition {
  const filled = resolveEnvironmentsPlaceholders(template.replace(/\{\{PERFORMER_IMAGE\}\}/g, image), envOverrides);
  const definition = JSON5.parse<FitDefinition & { preset?: unknown }>(filled);
  delete definition.preset;
  // `preset.description` above is menu-only and already stripped; this is the separate,
  // optional file-level `description`. Synthesize one if the template didn't hand-author it.
  definition.description ??= describeDefinition(definition);
  return definition;
}

export interface GeneratePresetArgs {
  type: PresetType;
  /** Short-form performer image written into every session, e.g. java-fit-performer:main. */
  image: string;
  outputPath?: string;
  format?: DefinitionFormat;
  pushGistVisibility?: GistVisibility;
  /** When true, skip printing the "Run it later with…" guidance (used by `fit run <preset>` which runs it immediately). */
  skipGuidance?: boolean;
  /**
   * Dot-path overrides applied after template substitution, e.g.
   * `{ "setup.repos.transactions-fit-performer.gerritRef": "refs/changes/32/247532/1" }`.
   * Values are JSON-parsed where possible so booleans and numbers work naturally.
   */
  overrides?: Record<string, string>;
  /**
   * `environments.json5` overrides applied *during* template substitution, keyed by
   * the same dot-path the preset's `{{environments.<dot.path>}}` placeholder uses, e.g.
   * `{ "defaults.clusterVersion": "7.6-stable" }`. Unlike `overrides`, values are used
   * verbatim (a version like `8.0` must not be JSON-parsed into a number).
   */
  envOverrides?: Record<string, string>;
}

/**
 * Apply a dot-path override to an object in place.
 * `"setup.repos.transactions-fit-performer.gerritRef"` splits on `.` and creates
 * any missing intermediate objects. The value string is JSON-parsed where possible
 * so `true`/`false` and numbers work naturally; falls back to a raw string.
 */
export function applyDotPathOverride(obj: Record<string, unknown>, dotPath: string, rawValue: string): void {
  const parts = dotPath.split(".");
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (cursor[key] === undefined || cursor[key] === null || typeof cursor[key] !== "object") {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  let value: unknown;
  try {
    value = JSON.parse(rawValue);
  } catch {
    value = rawValue;
  }
  cursor[leaf] = value;
}

export async function generatePreset(args: GeneratePresetArgs): Promise<{ path: string }> {
  const { type, image, outputPath, format, pushGistVisibility, skipGuidance, overrides, envOverrides } = args;

  const template = loadPresetTemplate(type);
  if (envOverrides && Object.keys(envOverrides).length > 0) {
    validateEnvOverrides(envOverrides);
    for (const [dotPath, value] of Object.entries(envOverrides)) {
      console.log(`Overriding environments.${dotPath} = ${value}`);
    }
  }
  const definition = applyPresetParams(template, image, envOverrides ?? {});
  if (overrides) {
    for (const [dotPath, rawValue] of Object.entries(overrides)) {
      applyDotPathOverride(definition as unknown as Record<string, unknown>, dotPath, rawValue);
    }
  }
  const outputFormat = resolvePresetOutputFormat(outputPath, format);
  const formatted = formatFitDefinition(definition, outputFormat);
  const result = outputPath
    ? (() => {
        const path = resolve(outputPath);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, formatted);
        return { path };
      })()
    : writeFitDefinition(definition, undefined, outputFormat);

  console.log(`\nWriting ${result.path}:\n`);
  printFileContent(formatted);
  console.log(`\n✓ Wrote ${result.path}`);

  if (pushGistVisibility) {
    console.log(`\nPushing ${pushGistVisibility} gist…`);
    const gist = await pushGist(result.path, formatted, pushGistVisibility);
    console.log(`✓ Gist created: ${gist.url}`);
  }

  if (!skipGuidance) {
    printDefinitionRunGuidance(result.path, Object.keys(definition.setup?.capellaEnvironments ?? {}).length > 0);
  }

  return { path: result.path };
}

/** Split a `key=value` flag value, e.g. `defaults.clusterVersion=7.6-stable`. */
export function parseKeyValueFlag(flag: string, kv: string): [key: string, value: string] {
  const eq = kv.indexOf("=");
  if (eq === -1) throw new Error(`${flag} value must be in key=value form, got: ${kv}`);
  return [kv.slice(0, eq), kv.slice(eq + 1)];
}

/** Parse `generate-preset` flags out of a positional-free argv slice. */
export function parseGeneratePresetArgs(argv: string[]): GeneratePresetArgs {
  let type: string | undefined;
  let performerImageName: string | undefined;
  let outputPath: string | undefined;
  let pushGistVisibility: GistVisibility | undefined;
  const overrides: Record<string, string> = {};
  const envOverrides: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--env-override") {
      const [key, value] = parseKeyValueFlag("--env-override", argv[++i]);
      envOverrides[key] = value;
    } else if (arg.startsWith("--env-override=")) {
      const [key, value] = parseKeyValueFlag("--env-override", arg.slice("--env-override=".length));
      envOverrides[key] = value;
    } else if (arg === "--type") {
      type = argv[++i];
    } else if (arg.startsWith("--type=")) {
      type = arg.slice("--type=".length);
    } else if (arg === "--performer-image-name") {
      performerImageName = argv[++i];
    } else if (arg.startsWith("--performer-image-name=")) {
      performerImageName = arg.slice("--performer-image-name=".length);
    } else if (arg === "--output") {
      outputPath = argv[++i];
    } else if (arg.startsWith("--output=")) {
      outputPath = arg.slice("--output=".length);
    } else if (arg === "--override") {
      const kv = argv[++i];
      const eq = kv.indexOf("=");
      if (eq === -1) throw new Error(`--override value must be in key=value form, got: ${kv}`);
      overrides[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (arg.startsWith("--override=")) {
      const kv = arg.slice("--override=".length);
      const eq = kv.indexOf("=");
      if (eq === -1) throw new Error(`--override value must be in key=value form, got: ${kv}`);
      overrides[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (arg === "--push-gist") {
      // Optional value: --push-gist [public|private]; default public.
      const next = argv[i + 1];
      if (next === "public" || next === "private") {
        pushGistVisibility = next;
        i++;
      } else {
        pushGistVisibility = "public";
      }
    } else if (arg.startsWith("--push-gist=")) {
      const val = arg.slice("--push-gist=".length);
      if (val !== "public" && val !== "private") {
        throw new Error(`--push-gist value must be "public" or "private", got: ${val}`);
      }
      pushGistVisibility = val;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!type) throw new Error(`--type is required.\nAvailable presets:\n${formatKnownPresetsWithDescriptions()}`);
  if (!isPresetType(type)) {
    // `PresetType` is just `string`, so this branch narrows `type` to `never` — the `String()`
    // wrap is only to satisfy the linter, `type` is still a plain string here.
    throw new Error(`Unknown preset type: ${String(type)}\nKnown types:\n${formatKnownPresetsWithDescriptions()}`);
  }
  if (!performerImageName) {
    throw new Error("--performer-image-name is required, e.g. java-fit-performer:main");
  }
  const parsed = analysePerformerImage(performerImageName);
  if ("error" in parsed) {
    throw new Error(`--performer-image-name: ${parsed.error}`);
  }
  validateEnvOverrides(envOverrides);
  assertEnvOverridesUsed([type], envOverrides);

  return {
    type,
    image: performerImageShortName(parsed.sdk, parsed.tag),
    outputPath,
    pushGistVisibility,
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
  };
}
