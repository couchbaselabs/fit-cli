/**
 * Step: build the cbdinocluster definition (a small YAML document) from the
 * answers gathered by ask-cluster-def. Reads version defaults from
 * environments.json5 (via loadEnvironments) but is otherwise pure transform
 * logic — no prompting — so it's easy to unit test (see tests/build-cluster-def.test.ts).
 *
 * The shape produced is, for example:
 *
 *   nodes:
 *     - count: 1
 *       version: '8.1.0'
 *       services: [kv, n1ql, index, fts]
 *
 * and, when CNG/Protostellar support is wanted, additionally:
 *
 *   cao:
 *     operator-version: "2.9.2"
 *     gateway-version: "1.1.0-135"
 *
 * Run on its own:
 *   bun src/cluster/cluster-create/build-cluster-def.ts
 *
 * Prints a sample def.
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { loadEnvironments } from "../../fit/util/environments.js";

/** GHCR image reference for a CNG server build: `ghcr.io/cb-rhcc/server:<version>`. */
export function cngServerImageRef(version: string): string {
  return `ghcr.io/cb-rhcc/server:${version}`;
}

/** The cloud providers Capella can deploy clusters on. */
export const CAPELLA_CLOUD_PROVIDERS = ["aws", "gcp", "azure"] as const;
export type CapellaCloudProvider = (typeof CAPELLA_CLOUD_PROVIDERS)[number];

/** The answers that describe the cluster to allocate. */
export interface ClusterDef {
  /** Number of nodes in the cluster. */
  nodeCount: number;
  /** Couchbase Server version, e.g. "8.0-stable" or a pinned build like "8.0.2-5322". Empty for cloud-allocated clusters where cbdinocluster picks the version. */
  version: string;
  /** Services to run on the node(s), e.g. ["kv", "n1ql", "index", "fts"]. */
  services: string[];
  /** Whether to add CNG/Protostellar (Cloud Native Gateway) support. */
  cng: boolean;
  /** Whether to build a self-managed Enterprise Analytics cluster (docker deployer + nginx load balancer). */
  enterpriseAnalytics?: boolean;
  /** Cloud provider for a Capella cluster; when set the `cloud` deployer is used. */
  capellaCloudProvider?: CapellaCloudProvider;
  /**
   * Enable the Capella Data API when the cluster is created. Off by default:
   * the Data API adds minutes to the allocation, so only runs that need it
   * should request it. Capella Server clusters only; Capella Analytics rejects it.
   */
  capellaDataApi?: boolean;
  /** Whether to build a Capella Analytics (cloud) cluster via cbdinocluster's cloud deployer. */
  capellaAnalytics?: boolean;
  /** Cloud provider for a Capella Analytics cluster. */
  cloudProvider?: "aws" | "gcp";
}

/**
 * The Analytics cluster products FIT can test. "Enterprise Analytics" is
 * self-managed (cbdinocluster `columnar: true` + a load balancer); "Capella
 * Analytics" is the managed cloud product (formerly "Columnar" / "Capella
 * Columnar"). Use these names — not "columnar" — everywhere except the cbdino
 * wire format. Names are current as of 2026 and may change.
 */
export const ANALYTICS_CLUSTER_PRODUCTS = ["enterprise-analytics", "capella-analytics"] as const;
export type AnalyticsClusterProduct = (typeof ANALYTICS_CLUSTER_PRODUCTS)[number];

/**
 * The single place that interprets cbdinocluster's `columnar: true` wire flag,
 * combined with the deployer, to identify which Analytics product a cbdino cluster is:
 *
 * - `columnar: true` + `deployer: cloud` → Capella Analytics (cloud-managed SaaS)
 * - `columnar: true` + docker deployer (or no deployer) → Enterprise Analytics (self-managed)
 * - no `columnar: true` → not an Analytics cluster (undefined)
 */
export function cbdinoAnalyticsClusterProduct(config: CbdinoclusterDef): AnalyticsClusterProduct | undefined {
  if (config.columnar !== true) return undefined;
  return config.deployer === "cloud" ? "capella-analytics" : "enterprise-analytics";
}

export interface CbdinoclusterDockerDef {
  "kv-memory"?: number;
  "index-memory"?: number;
  "fts-memory"?: number;
  "cbas-memory"?: number;
  "eventing-memory"?: number;
  /** Columnar docker deployer: front the cluster with an nginx load balancer. */
  "passive-load-balancer"?: boolean;
  /** Columnar docker deployer: use cbdinocluster-generated certs. */
  "use-dino-certs"?: boolean;
}

/**
 * Default per-service RAM quota (MB) we emit for the docker deployer. cbdinocluster's
 * own defaults are small — too small for FIT tests that create large buckets (e.g.
 * TenThousandCollectionsTest asks for a 2048 MB/node bucket, which on a 3-node
 * cluster fails the default quota). Matches the value fit-app-deployment uses on CI.
 */
export const DOCKER_SERVICE_MEMORY_MB = 4096;

/**
 * The docker RAM-quota block for a service list. Only kv and fts get a quota —
 * those are the services FIT's large-bucket tests exercise and the ones the CI
 * definitions raise; everything else keeps cbdinocluster's defaults. Returns
 * undefined when the cluster runs neither, so we don't emit an empty `docker`.
 */
function dockerMemoryForServices(services: string[]): CbdinoclusterDockerDef | undefined {
  const docker: CbdinoclusterDockerDef = {};
  if (services.includes("kv")) docker["kv-memory"] = DOCKER_SERVICE_MEMORY_MB;
  if (services.includes("fts")) docker["fts-memory"] = DOCKER_SERVICE_MEMORY_MB;
  return Object.keys(docker).length > 0 ? docker : undefined;
}

/**
 * The cbdinocluster definition as a structured object (what goes under `config`).
 *
 * This block is passed through to the `cbdinocluster` CLI verbatim — fit-cli does
 * not strip or reshape it — so any cbdinocluster cluster-def key is accepted, even
 * ones fit-cli doesn't model (hence the open index signature). The fields named
 * below are the ones fit-cli itself reads: `nodes`/`cao` to describe the cluster
 * and pick the default deployer, `docker` for the generated RAM quotas.
 */
export interface CbdinoclusterDef {
  nodes: { count: number; version?: string; services?: string[] }[];
  /** Present only when CNG/Protostellar support is wanted. */
  cao?: { "operator-version": string; "gateway-version": string };
  /** Present only for an Analytics cluster (Enterprise Analytics or Capella Analytics). */
  columnar?: boolean;
  /** cbdinocluster deployer: "cloud" for Capella Analytics; "docker" (or absent) for Enterprise Analytics. */
  deployer?: string;
  /** Cloud configuration for Capella clusters. `data-api` is valid for Capella Server only. */
  cloud?: { "cloud-provider": string; region?: string; "data-api"?: boolean };
  /** Per-service RAM quotas for the docker deployer; omitted for other deployers. */
  docker?: CbdinoclusterDockerDef;
  /** Pass-through: any other cbdinocluster cluster-def keys are forwarded as-is. */
  [key: string]: unknown;
}

/**
 * Build the cbdinocluster definition as a structured object, rather than the YAML
 * string {@link buildClusterDef} produces. Used when the def is embedded in a
 * larger document (e.g. a fit definition file's
 * `setup.cluster.cbdinocluster.config`) rather than written out on its own.
 *
 * For the docker deployer (everything but CNG, which uses cao) we also emit
 * sensible per-service RAM quotas so generated definitions don't hit "RAM quota
 * specified is too large to be provisioned into this cluster" on large-bucket
 * tests. Hand-edit the `docker` block to tune them.
 */
export function buildClusterDefObject(def: ClusterDef): CbdinoclusterDef {
  if (def.enterpriseAnalytics) {
    // A self-managed Enterprise Analytics cluster. On the cbdino wire this is the
    // `columnar: true` flag (cbdino's historical name); nodes carry no service
    // list (cbdino derives the Analytics topology from it), and the docker
    // deployer fronts it with an nginx load balancer using dino certs.
    return {
      columnar: true,
      nodes: [{ count: def.nodeCount, version: def.version }],
      docker: { "passive-load-balancer": true, "use-dino-certs": true },
    };
  }
  if (def.capellaCloudProvider) {
    // A Capella cloud cluster: cbdinocluster allocates it via the Capella control-plane
    // API (the `cloud` deployer). The `cloud.cloud-provider` field tells Capella which
    // underlying infrastructure to use. No `docker` block — Capella manages resources.
    return {
      nodes: [{ count: def.nodeCount, version: def.version }],
      cloud: {
        "cloud-provider": def.capellaCloudProvider,
        ...(def.capellaDataApi ? { "data-api": true } : {}),
      },
    };
  }
  if (def.capellaAnalytics) {
    // A Capella Analytics (cloud) cluster. cbdinocluster uses the cloud deployer
    // to create it in the Capella cloud; no version or service list is needed —
    // cbdinocluster picks the latest and derives the Analytics topology.
    return {
      columnar: true,
      nodes: [{ count: def.nodeCount }],
      deployer: "cloud",
      cloud: { "cloud-provider": def.cloudProvider ?? "aws" },
    };
  }
  const docker = def.cng ? undefined : dockerMemoryForServices(def.services);
  const { caoOperatorVersion, cngVersion } = loadEnvironments().defaults;
  return {
    nodes: [{ count: def.nodeCount, version: def.version, services: def.services }],
    ...(def.cng
      ? { cao: { "operator-version": caoOperatorVersion, "gateway-version": cngVersion } }
      : {}),
    ...(docker ? { docker } : {}),
  };
}

/** Render `def` as the cbdinocluster YAML definition document. */
export function buildClusterDef(def: ClusterDef): string {
  const lines = [
    "nodes:",
    `  - count: ${def.nodeCount}`,
    `    version: '${def.version}'`,
    `    services: [${def.services.join(", ")}]`,
  ];

  if (def.cng) {
    const { caoOperatorVersion, cngVersion } = loadEnvironments().defaults;
    lines.push(
      "cao:",
      `  operator-version: "${caoOperatorVersion}"`,
      `  gateway-version: "${cngVersion}"`,
    );
  }

  return lines.join("\n") + "\n";
}

if (isMain(import.meta.url)) {
  runCli(() => {
    console.log(
      buildClusterDef({
        nodeCount: 1,
        version: loadEnvironments().defaults.cngClusterVersion,
        services: ["kv", "n1ql", "index", "fts"],
        cng: true,
      }),
    );
    return Promise.resolve();
  });
}
