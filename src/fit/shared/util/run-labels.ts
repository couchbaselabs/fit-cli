import type { DefinitionRunPath } from "../../../util/non-fit/replay.js";

/**
 * Inputs for rendering a run's position as human-readable labels (e.g.
 * `aws1 / cbdino1 / java:main / functional`). Every field is optional: callers pass
 * whatever they know at the point of formatting, and each missing piece falls
 * back to an index-based word form (`instance1`, `cbdino1`, `s1`, `r1`) so the
 * label is always complete. The same segment builders feed both the
 * `[HH:MM:SS …]` log prefix and the path summaries, so the conventions stay
 * identical everywhere.
 */
export interface RunLabelParts {
  /** Execution target kind — distinguishes `aws1` / `gcp1` from `local`. */
  instanceKind?: "aws" | "gcp" | "localhost";
  /** Cluster provenance — `cbdino1` (allocated) vs `existing1` (connection/useExisting). */
  clusterMode?: "connection" | "useExisting" | "cbdinocluster";
  /**
   * Couchbase Server version of the cluster the run uses, e.g. `8.1.0`. When known it replaces the
   * `cbdino1` index form with the version itself, and it names the otherwise-unnamed cluster that a
   * situational run's test-driver creates. As configured, so an alias like `8.0-stable` stays as-is.
   */
  clusterVersion?: string;
  /** Lowercase SDK value, e.g. `java`. */
  sdkValue?: string;
  /** Performer image version / ref, e.g. `main`. */
  performerVersion?: string;
  type?: "functional" | "situational" | "analytics-functional";
  /** Named test presets for this run; a single preset names the run segment. */
  presets?: readonly string[];
  /** Whether this is a CNG (Cloud Native Gateway / Protostellar) run. */
  cng?: boolean;
  /** Whether the cluster is a self-managed Enterprise Analytics cluster (prefixes the cluster segment with `EA:`). */
  enterpriseAnalytics?: boolean;
  /** Whether the cluster is a real Capella cloud cluster (prefixes the cluster segment with `Capella:`). */
  capella?: boolean;
  /** Whether the cluster is a Capella Analytics cloud cluster (prefixes the cluster segment with `CA:`). */
  capellaAnalytics?: boolean;
  /** Whether this situational run connects to cbdino's Capella cluster over AWS PrivateLink. */
  privateEndpoint?: boolean;
}

/** `local` / `aws1` / `gcp1` / (fallback) `instance1`. */
export function instanceLabel(path: DefinitionRunPath, kind?: RunLabelParts["instanceKind"]): string {
  if (kind === "localhost") {
    return "local";
  }
  if (kind === "aws") {
    return `aws${path.instanceIndex + 1}`;
  }
  if (kind === "gcp") {
    return `gcp${path.instanceIndex + 1}`;
  }
  return `instance${path.instanceIndex + 1}`;
}

/**
 * `cbdino1` / `existing1`, or the cluster's version when we know it.
 *
 * For an allocated cbdino cluster whose version we know, prefer the more useful
 * version itself (e.g. `8.1.0`) over the bare `cbdino1` index.
 *
 * A clusterless (situational) session has no cluster in the definition — the
 * test-driver's own cbdino creates one per run — so there is no index to name and
 * the version is the only cluster identity available: `Capella:8.0` when we know
 * it, and no cluster segment at all when we don't.
 */
export function clusterLabel(
  path: DefinitionRunPath,
  mode?: RunLabelParts["clusterMode"],
  version?: string,
  enterpriseAnalytics = false,
  capella = false,
  capellaAnalytics = false,
): string | undefined {
  // A self-managed Enterprise Analytics cbdino cluster reads as e.g. `EA:2.2.0-1166`.
  // A real Capella cloud cluster reads as e.g. `Capella:cbdino1`.
  // A Capella Analytics cloud cluster reads as e.g. `CA:cbdino1`.
  const flavoured = (base: string): string => {
    if (enterpriseAnalytics) return `EA:${base}`;
    if (capella) return `Capella:${base}`;
    if (capellaAnalytics) return `CA:${base}`;
    return base;
  };
  if (path.clusterlessSession) {
    return version ? flavoured(version) : undefined;
  }
  const n = (path.clusterIndex ?? 0) + 1;
  if (mode === "connection" || mode === "useExisting") {
    return `existing${n}`;
  }
  return flavoured(version ? version : `cbdino${n}`);
}

/** The session, named by its performer: `java:main` (or just `java`), falling back to `s1`. */
export function performerLabel(path: DefinitionRunPath, sdkValue?: string, version?: string): string {
  if (sdkValue) {
    return version ? `${sdkValue}:${version}` : sdkValue;
  }
  return `s${(path.sessionIndex ?? 0) + 1}`;
}

/** The run type label: `functional` / `functional:cng` / `functional:analytics` / `situational` / `situational:cng`. */
function typeLabel(type: NonNullable<RunLabelParts["type"]>, cng?: boolean): string {
  if (type === "analytics-functional") return "functional:analytics";
  if (type === "functional") return cng ? "functional:cng" : "functional";
  return cng ? "situational:cng" : "situational";
}

/**
 * The run, named by its single preset (qualified by type, e.g. `situational:standard-qe`),
 * else its type (`functional`/`functional:cng`/`situational`/`situational:cng`), else `r1`. A preset without a known type falls
 * back to the bare preset name.
 */
export function runLabel(
  path: DefinitionRunPath,
  type?: RunLabelParts["type"],
  presets?: readonly string[],
  cng?: boolean,
  privateEndpoint?: boolean,
): string | undefined {
  const peSuffix = privateEndpoint ? "+PE" : "";
  if (presets && presets.length === 1) {
    return type ? `${typeLabel(type, cng)}:${presets[0]}${peSuffix}` : `${presets[0]}${peSuffix}`;
  }
  if (type) {
    return `${typeLabel(type, cng)}${peSuffix}`;
  }
  return path.runIndex !== undefined ? `r${path.runIndex + 1}` : undefined;
}

/** Join the four segments with ` / `, dropping any that don't apply. */
export function formatRunLabel(path: DefinitionRunPath, parts: RunLabelParts = {}): string {
  return [
    instanceLabel(path, parts.instanceKind),
    clusterLabel(path, parts.clusterMode, parts.clusterVersion, parts.enterpriseAnalytics, parts.capella, parts.capellaAnalytics),
    performerLabel(path, parts.sdkValue, parts.performerVersion),
    runLabel(path, parts.type, parts.presets, parts.cng, parts.privateEndpoint),
  ]
    .filter((segment): segment is string => Boolean(segment))
    .join(" / ");
}
