/**
 * Build and write reusable `fit` definition files (JSON5 by default, YAML optional).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import YAML from "yaml";
import { artifactFromPath, type Artifact, type RunOutput } from "../../../util/non-fit/artifacts.js";
import { printWithoutTimestamps } from "../../../util/non-fit/fit-cli-log.js";
import { ensureRunDir } from "../../../util/non-fit/replay.js";
import { recordRecentDefinition } from "./recent-definitions.js";
import type { Sdk } from "../../../util/sdk/sdks.js";
import { buildClusterDefObject, type ClusterDef } from "../../../cluster/cluster-create/build-cluster-def.js";
import type { ClusterExistsPolicy } from "../../../cluster/cluster-create/cluster-exists-policy.js";
import type { SelectedCluster } from "../../../cluster/cluster-select/cluster-select.js";
import type { PortInUsePolicy } from "../../performers/util/performer-port.js";
import { performerImageShortName, sdkDefaultPerformerTag } from "../../performers/util/performer-image.js";
import type { FitTestSelection } from "../select-fit-tests/select-fit-tests.js";
import {
  CURRENT_FIT_DEFINITION_VERSION,
  FIT_DEFINITION_TYPE,
  type ClusterConfigRef,
  type FitConfigRef,
  type FitDefinition,
  type InstanceLifetime,
  type InstanceMode,
  type SessionLifetime,
  type TestsSection,
} from "./types.js";
import { describeDefinition } from "./generate-desc.js";

const CLUSTER_CONFIG_ID = "cluster-0";
const FIT_CONFIG_ID = "fit-config-0";

export type DefinitionFormat = "json5" | "yaml";

export function fitDefinitionPath(runDir: string = ensureRunDir(), format: DefinitionFormat = "json5"): string {
  return join(runDir, format === "yaml" ? "fit.yaml" : "fit.json5");
}

export const fitFunctionalDefinitionPath = fitDefinitionPath;

export type DefinitionCluster =
  | { kind: "connection"; cluster: SelectedCluster }
  | { kind: "cbdinocluster"; def: ClusterDef };

export interface DefinitionInputs {
  cluster: DefinitionCluster;
  sdk: Sdk;
  version?: string;
  gerritRef?: string;
  onClusterExists?: ClusterExistsPolicy;
  onPortInUse?: PortInUsePolicy;
  selection: FitTestSelection;
  instance?: InstanceMode;
  /**
   * Build an `analytics-functional` run (Analytics tests via the columnar-test-driver)
   * rather than a plain operational `functional` run. The run gets a starter
   * Analytics connection fitConfig (load balancer + the SDK's analytics endpoint),
   * which the user can tune; see the enterprise-analytics-functional preset.
   */
  analytics?: boolean;
  /**
   * Capella environment to create this cluster in (a key under `capella` in
   * environments.json5 — e.g. "dev"). Only meaningful when the cluster is a
   * Capella cloud cluster (i.e. `cluster.def.capellaCloudProvider` is set).
   */
  capellaEnvironment?: string;
  /**
   * Set up a private endpoint connection (AWS PrivateLink or GCP PSC) to this
   * Capella cluster. Only meaningful for an AWS/GCP Capella cloud cluster; the
   * instance must also have `aws.privateEndpoint: {}` / `gcp.privateEndpoint: {}`
   * matching `cluster.def.capellaCloudProvider`.
   */
  capellaPrivateEndpoint?: boolean;
}

export interface SituationalDefinitionInputs {
  sdk: Sdk;
  version?: string;
  gerritRef?: string;
  onPortInUse?: PortInUsePolicy;
  selection: FitTestSelection;
  /** Capella environment to create clusters in (key under `capella` in environments.json5). Omitted ⇒ "dev". */
  capellaEnvironment?: string;
  instance?: InstanceMode;
  /**
   * Set up a private endpoint connection (AWS PrivateLink or GCP PSC, matching
   * `instance`) to the Capella cluster cbdino creates for this run. The instance
   * must also be a fixed aws/gcp + `privateEndpoint` instance.
   */
  privateEndpoint?: boolean;
}

function buildTests(selection: FitTestSelection): TestsSection {
  if (selection.presets?.length) {
    return {
      presets: selection.presets,
      ...(selection.extraClasses?.length ? { classes: selection.extraClasses } : {}),
    };
  }
  if (selection.selectedPackages?.length) {
    return { packages: selection.selectedPackages };
  }
  if (selection.mavenTestSelector !== undefined && selection.selectedTests.length > 0) {
    return { classes: selection.selectedTests.map((test) => test.className) };
  }
  return { presets: ["all"] };
}

/**
 * The performer (SDK) connection block for an Analytics run, chosen by SDK family —
 * the two SDK families speak different schemes and the cluster rejects a mismatch:
 *
 *  - **Enterprise Analytics SDK** (`enterprise-analytics`): an http(s) URL to the
 *    load balancer's Analytics query port. It only accepts `http`/`https` (it throws
 *    "Expected URL scheme 'http' or 'https' but was 'couchbases'" otherwise). We use
 *    plain `http://${defaultHostname}:8095`, matching FITConfiguration.analytics.loadbalancer.example.json.
 *  - **Columnar SDK** (`columnar`): a `couchbase(s)://` connection string with TLS.
 *    It rejects http(s) and NonTls, so we use `couchbases://` + insecure TLS (trusting
 *    the cbdinocluster "dino" certs), matching FITConfiguration.columnar.example.json.
 */
export function analyticsPerformerConnection(sdk: Sdk): { connectionString: string; tls: { insecure: true } | null } {
  if (sdk.family === "columnar") {
    return { connectionString: "couchbases://${defaultHostname}", tls: { insecure: true } };
  }
  // Enterprise Analytics SDK (the standard for the self-managed clusters we allocate).
  return { connectionString: "http://${defaultHostname}:8095", tls: null };
}

/**
 * A starter Analytics connection fitConfig for an `analytics-functional` run.
 * The performer scheme depends on the SDK family (see {@link analyticsPerformerConnection}).
 * For self-managed Enterprise Analytics the driver needs `clusterParams.loadBalancedCluster.ports`
 * so it discovers the Analytics query port via the nginx load balancer; for Capella Analytics
 * (cloud) there is no load balancer and the endpoint is the SaaS connection string directly.
 * Returned as a top-level {@link FitConfigRef} (relocated out of the run and referenced by id)
 * so the generated file stays readable.
 */
function analyticsFitConfigRef(sdk: Sdk, capellaAnalytics: boolean): FitConfigRef {
  if (capellaAnalytics) {
    return {
      id: FIT_CONFIG_ID,
      config: {
        clusterAccess: {
          performer: analyticsPerformerConnection(sdk),
        },
      },
    };
  }
  return {
    id: FIT_CONFIG_ID,
    config: {
      clusterAccess: {
        clusterParams: { loadBalancedCluster: { ports: [8095, 18095] } },
        performer: analyticsPerformerConnection(sdk),
      },
    },
  };
}

function buildPerformerSession(
  sdk: Sdk,
  version: string | undefined,
  onPortInUse: PortInUsePolicy | undefined,
): Omit<SessionLifetime, "runs"> {
  return {
    performer: {
      image: performerImageShortName(sdk, version ?? sdkDefaultPerformerTag(sdk)),
      ...(onPortInUse ? { onPortInUse } : {}),
    },
  };
}

interface BuiltFunctionalInstance {
  instance: InstanceLifetime;
  clusterConfigRef: ClusterConfigRef;
  /** Present for analytics runs: the relocated, id-referenced connection fitConfig. */
  fitConfigRef?: FitConfigRef;
}

function buildFunctionalInstance(inputs: DefinitionInputs): BuiltFunctionalInstance {
  const clusterConfigRef: ClusterConfigRef = inputs.cluster.kind === "connection"
    ? {
        id: CLUSTER_CONFIG_ID,
        connection: {
          connectionString: `${inputs.cluster.cluster.scheme}://${inputs.cluster.cluster.defaultHostname}`,
          username: inputs.cluster.cluster.credentials.username,
          password: inputs.cluster.cluster.credentials.password,
          tls: inputs.cluster.cluster.tls,
        },
      }
    : (() => {
        const capellaCloudProvider = inputs.cluster.def.capellaCloudProvider;
        return {
          id: CLUSTER_CONFIG_ID,
          cbdinocluster: {
            config: buildClusterDefObject(inputs.cluster.def),
            ...(inputs.onClusterExists ? { onClusterExists: inputs.onClusterExists } : {}),
            // Capella block records the intent declaratively; init args and deployer
            // are derived from this at runtime (never baked into the definition file).
            ...(capellaCloudProvider ? {
              capella: {
                cloudProvider: capellaCloudProvider,
                ...(inputs.capellaEnvironment ? { environment: inputs.capellaEnvironment } : {}),
                ...(inputs.capellaPrivateEndpoint ? { privateEndpoint: {} } : {}),
              },
            } : {}),
          },
        };
      })();
  const instance: InstanceLifetime = {
    ...(inputs.instance ?? { localhost: {} }),
    clusters: [
      {
        clusterConfig: CLUSTER_CONFIG_ID,
        sessions: [
          {
            ...buildPerformerSession(inputs.sdk, inputs.version, inputs.onPortInUse),
            runs: [
              inputs.analytics
                ? {
                    type: "analytics-functional",
                    // Referenced by id; the config itself is relocated to top-level fitConfigs.
                    fitConfig: FIT_CONFIG_ID,
                    tests: buildTests(inputs.selection),
                  }
                : {
                    type: "functional",
                    tests: buildTests(inputs.selection),
                  },
            ],
          },
        ],
      },
    ],
  };
  const capellaAnalytics = (inputs.analytics ?? false) && inputs.cluster.kind === "cbdinocluster" && (inputs.cluster.def.capellaAnalytics ?? false);
  return { instance, clusterConfigRef, ...(inputs.analytics ? { fitConfigRef: analyticsFitConfigRef(inputs.sdk, capellaAnalytics) } : {}) };
}

function buildSituationalInstance(inputs: SituationalDefinitionInputs): InstanceLifetime {
  // Emit whatever was explicitly chosen (the builder always asks now), so the file
  // records the selection even when it's the default.
  const includeCapellaEnv = inputs.capellaEnvironment !== undefined;
  return {
    ...(inputs.instance ?? { localhost: {} }),
    // cbdinocluster init args are generated at runtime (situationalCbdinoclusterInitArgs),
    // nothing to bake into the definition. The Capella environment lives here so it's
    // recorded alongside the instance that uses it.
    ...(includeCapellaEnv ? { setup: { capellaEnvironment: inputs.capellaEnvironment } } : {}),
    clusters: [],
    clusterlessSessions: [
      {
        ...buildPerformerSession(inputs.sdk, inputs.version, inputs.onPortInUse),
        runs: [
          {
            type: "situational",
            tests: buildTests(inputs.selection),
            situational: {
              database: { mode: "files" },
              ...(inputs.privateEndpoint ? { privateEndpoint: {} } : {}),
            },
          },
        ],
      },
    ],
  };
}

export function buildFitDefinition(inputs: {
  gerritRef?: string;
  instances: InstanceLifetime[];
  clusterConfigs?: ClusterConfigRef[];
  fitConfigs?: FitConfigRef[];
}): FitDefinition {
  const setup = inputs.gerritRef
    ? { repos: { "transactions-fit-performer": { gerritRef: inputs.gerritRef } } }
    : undefined;
  const base: FitDefinition = {
    version: CURRENT_FIT_DEFINITION_VERSION,
    type: FIT_DEFINITION_TYPE,
    ...(setup ? { setup } : {}),
    instances: [...inputs.instances],
    ...(inputs.clusterConfigs?.length ? { clusterConfigs: inputs.clusterConfigs } : {}),
    ...(inputs.fitConfigs?.length ? { fitConfigs: inputs.fitConfigs } : {}),
  };
  return {
    version: base.version,
    type: base.type,
    description: describeDefinition(base),
    ...(base.setup ? { setup: base.setup } : {}),
    instances: base.instances,
    ...(base.clusterConfigs ? { clusterConfigs: base.clusterConfigs } : {}),
    ...(base.fitConfigs ? { fitConfigs: base.fitConfigs } : {}),
  };
}

export function buildFitFunctionalDefinitionFrom(inputs: DefinitionInputs): FitDefinition {
  const { instance, clusterConfigRef, fitConfigRef } = buildFunctionalInstance(inputs);
  return buildFitDefinition({
    ...(inputs.gerritRef ? { gerritRef: inputs.gerritRef } : {}),
    instances: [instance],
    clusterConfigs: [clusterConfigRef],
    ...(fitConfigRef ? { fitConfigs: [fitConfigRef] } : {}),
  });
}

export function buildFitSituationalDefinitionFrom(inputs: SituationalDefinitionInputs): FitDefinition {
  return buildFitDefinition({
    ...(inputs.gerritRef ? { gerritRef: inputs.gerritRef } : {}),
    instances: [buildSituationalInstance(inputs)],
  });
}

export function buildFitFunctionalDefinition(
  sdk: Sdk,
  cluster: SelectedCluster,
  selection: FitTestSelection,
): FitDefinition {
  return buildFitFunctionalDefinitionFrom({ cluster: { kind: "connection", cluster }, sdk, selection });
}

// ── Comment injection ────────────────────────────────────────────────────────
// Rather than splice comments into the rendered text with line-anchored regexes
// (brittle, and blind to shape changes), we decorate a copy of the definition
// with marker keys — "//<6 chars>": "comment text" — placed immediately before
// the field they annotate, render it, then turn each marker line into a real
// comment. Keying off field names instead of line patterns keeps the comments
// attached to the right fields no matter how the serializer lays them out.

let commentMarkerSeq = 0;

/** A unique six-character marker key; renders just before its sibling field. */
function commentMarkerKey(): string {
  const id = (commentMarkerSeq++).toString(36).padStart(6, "0").slice(-6);
  return `//${id}`;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The short comment line(s) to splice in immediately before `key`, given its
 * value and the key of the object it sits in. As a general rule, anything fit-cli
 * fills in at runtime gets a one-line note so a reader knows it'll be provided
 * later rather than being missing.
 */
function commentLinesFor(key: string, value: unknown, parentKey: string | undefined): string[] {
  switch (key) {
    case "config":
      return parentKey === "init"
        ? ["This file will be uploaded verbatim into clean environments as ~/.cbdinocluster"]
        : [];
    case "args":
      return parentKey === "init"
        ? [
            "Passed to `cbdinocluster init` on clean environments to set up ~/.cbdinocluster.  Added at runtime: GitHub creds",
            "On localhost, init is skipped and your existing ~/.cbdinocluster is used as-is.",
          ]
        : [];
    case "configPatch":
      return parentKey === "init"
        ? ["Merged onto ~/.cbdinocluster after `cbdinocluster init` runs — for config init can't set via flags."]
        : [];
    case "bucketConfig":
      return ["numReplicas >= 1 is required for FTS tests to pass."];
    case "fitConfigs":
      return [
      ];
    case "setup":
      return [];
    case "clusters":
      return parentKey === "instances" && Array.isArray(value) && value.length === 0
        ? ["FIT/SIT creates its own clusters, so none are set up here."]
        : [];
    case "clusterlessSessions":
      return ["Sessions not tied to any particular cluster (the name distinguishes these from sessions nested under clusters:)"];
    case "clusterAccess":
      if (isJsonObject(value) && JSON.stringify(value).includes("${defaultHostname}")) {
        return ["fit-cli fills ${defaultHostname} (and rest.hostname) in at runtime once the cluster is up."];
      }
      if (isJsonObject(value) && "defaultHostname" in value) {
        return ["Ignored for situational-only runs — cbdino creates and manages the cluster."];
      }
      return [];
    case "excludeTests":
      return [];
    default:
      return [];
  }
}

/** Deep-copy a definition, inserting comment markers before annotated fields. */
function decorateWithCommentMarkers(node: unknown, parentKey?: string): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => decorateWithCommentMarkers(item, parentKey));
  }
  if (!isJsonObject(node)) {
    return node;
  }
  const result: JsonObject = {};
  for (const [key, rawValue] of Object.entries(node)) {
    for (const line of commentLinesFor(key, rawValue, parentKey)) {
      result[commentMarkerKey()] = line;
    }
    result[key] = decorateWithCommentMarkers(rawValue, key);
  }
  return result;
}

// A marker key, single- or double-quoted (JSON5 may use either).
const MARKER_KEY = `(?:"\\/\\/[0-9a-z]{6}"|'\\/\\/[0-9a-z]{6}')`;
// A single- or double-quoted string value.
const QUOTED_VALUE = `(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`;

/** Turn `'//xxxxxx': 'text'` marker lines into `// text` comments (JSON5). */
function renderCommentMarkersJson5(text: string): string {
  const pattern = new RegExp(`^([ \\t]*)${MARKER_KEY}:[ \\t]*(${QUOTED_VALUE}),?[ \\t]*$`, "gm");
  return text.replace(pattern, (_match, indent: string, quoted: string) => `${indent}// ${String(JSON5.parse(quoted))}`);
}

/** Turn `//xxxxxx: text` marker lines into `# text` comments (YAML). */
function renderCommentMarkersYaml(text: string): string {
  const pattern = new RegExp(`^([ \\t]*)(?:${MARKER_KEY}|\\/\\/[0-9a-z]{6}):[ \\t]*(.*)$`, "gm");
  return text.replace(pattern, (_match, indent: string, rawValue: string) => {
    let comment = rawValue;
    try {
      const parsed = YAML.parse(rawValue) as unknown;
      if (typeof parsed === "string") comment = parsed;
    } catch {
      // Keep the raw value if it doesn't parse as a scalar.
    }
    return `${indent}# ${comment}`;
  });
}

/**
 * Append an inline comment on any `version:` line whose value is a CBS alias
 * (e.g. "8.1-stable") so readers know it will be resolved at runtime and is
 * not passed verbatim to cbdinocluster.
 */
function annotateAliasVersions(text: string, format: DefinitionFormat): string {
  const comment = format === "yaml" ? "# resolved by fit-cli at runtime" : "// resolved by fit-cli at runtime";
  return text.replace(
    /^(\s+version:\s*['"]?(\d+\.\d+-(stable|release))['"]?,?)\s*$/gm,
    (_, before) => `${before}  ${comment}`,
  );
}

export function formatFitDefinition(definition: FitDefinition, format: DefinitionFormat = "json5"): string {
  const decorated = decorateWithCommentMarkers(definition);
  if (format === "yaml") {
    // lineWidth: 0 disables scalar wrapping so each comment marker stays on one line.
    const text = renderCommentMarkersYaml(YAML.stringify(decorated, { lineWidth: 0 }));
    return annotateAliasVersions(text, "yaml");
  }
  let text = renderCommentMarkersJson5(JSON5.stringify(decorated, null, 2));
  if (!text.endsWith("\n")) text += "\n";
  return annotateAliasVersions(text, "json5");
}

/** Situational definitions render through the same key-driven comment logic. */
export function formatFitSituationalDefinition(definition: FitDefinition, format: DefinitionFormat = "json5"): string {
  return formatFitDefinition(definition, format);
}

export function formatFitFunctionalDefinition(definition: FitDefinition, format: DefinitionFormat = "json5"): string {
  return formatFitDefinition(definition, format);
}

export interface WriteFitFunctionalDefinitionResult {
  path: string;
  artifact: Artifact;
}

export function writeFitDefinition(
  definition: FitDefinition,
  runDir: string = ensureRunDir(),
  format: DefinitionFormat = "json5",
): WriteFitFunctionalDefinitionResult {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const path = fitDefinitionPath(runDir, format);
  writeFileSync(path, formatFitDefinition(definition, format));
  recordRecentDefinition(path, definition.description || describeDefinition(definition));
  return {
    path,
    artifact: artifactFromPath(path, "Generated fit definition file for reruns", runDir),
  };
}

export const writeFitFunctionalDefinition = writeFitDefinition;

export function writeFitSituationalDefinition(
  definition: FitDefinition,
  runDir: string = ensureRunDir(),
  format: DefinitionFormat = "json5",
): WriteFitFunctionalDefinitionResult {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const path = fitDefinitionPath(runDir, format);
  writeFileSync(path, formatFitSituationalDefinition(definition, format));
  recordRecentDefinition(path, definition.description || describeDefinition(definition));
  return {
    path,
    artifact: artifactFromPath(path, "Generated fit definition file for reruns", runDir),
  };
}

export function generateFitFunctionalDefinition(
  sdk: Sdk,
  cluster: SelectedCluster,
  selection: FitTestSelection,
  format: DefinitionFormat = "json5",
): RunOutput & { path: string; definition: FitDefinition } {
  const definition = buildFitFunctionalDefinition(sdk, cluster, selection);

  console.log("\nGenerating a fit definition file so you can rerun this flow non-interactively or tweak it.");
  const result = writeFitDefinition(definition, undefined, format);

  console.log(`\nWriting ${result.path}:\n`);
  printWithoutTimestamps(formatFitDefinition(definition, format));
  console.log(`\n✓ Wrote ${result.path}`);

  return { path: result.path, definition, artifacts: [result.artifact], details: [] };
}
