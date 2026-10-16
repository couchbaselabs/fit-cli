/**
 * Env-var control of which Capella environment a run targets, and (for a sandbox) where its
 * control plane lives. This is what makes a sandbox usable from a preset:
 *
 *   CAPELLA_ENVIRONMENT=sandbox CAPELLA_ENDPOINT=... CAPELLA_OID=... \
 *   CAPELLA_USER=... CAPELLA_PASS=... fit run preset op-capella-sit-sanity --performer java-fit-performer:main
 *
 * Presets pin their environment (`capellaEnvironment: 'prod'`) and cannot carry a sandbox's
 * per-run coordinates, so both come from the environment instead and are applied to the
 * generated definition before it is resolved.
 *
 * Run on its own:
 *   CAPELLA_ENVIRONMENT=sandbox bun src/fit/shared/definition/capella-environment.ts examples/documented.json5
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { deriveCapellaSandboxEndpoints, type CapellaEnvironmentOverride } from "../../util/environments.js";
import type { ClusterConfigRef, ClusterLifetime, FitDefinition } from "./types.js";

/** The environment named by CAPELLA_ENVIRONMENT, or undefined when it isn't set. */
export function capellaEnvironmentFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CAPELLA_ENVIRONMENT?.trim() || undefined;
}

/**
 * A sandbox's control plane from CAPELLA_ENDPOINT/CAPELLA_OID (v4 derived when CAPELLA_V4_ENDPOINT
 * is absent), keyed by the environment CAPELLA_ENVIRONMENT names. Undefined unless all of the
 * environment name, endpoint and org id are set — a partial set is reported by the caller rather
 * than silently half-applied.
 */
export function capellaEnvironmentOverridesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, CapellaEnvironmentOverride> | undefined {
  const name = capellaEnvironmentFromEnv(env);
  const endpoint = env.CAPELLA_ENDPOINT?.trim();
  const oid = env.CAPELLA_OID?.trim();
  if (!name || !endpoint || !oid) return undefined;
  const v4Endpoint = env.CAPELLA_V4_ENDPOINT?.trim() || deriveCapellaSandboxEndpoints(endpoint).v4Endpoint;
  return { [name]: { endpoint: deriveCapellaSandboxEndpoints(endpoint).endpoint, v4Endpoint, oid } };
}

function clusterWithEnvironment(cluster: ClusterLifetime, name: string): ClusterLifetime {
  if (!cluster.cbdinocluster?.capella) return cluster;
  return {
    ...cluster,
    cbdinocluster: { ...cluster.cbdinocluster, capella: { ...cluster.cbdinocluster.capella, environment: name } },
  };
}

function clusterConfigWithEnvironment(config: ClusterConfigRef, name: string): ClusterConfigRef {
  if (!config.cbdinocluster?.capella) return config;
  return {
    ...config,
    cbdinocluster: { ...config.cbdinocluster, capella: { ...config.cbdinocluster.capella, environment: name } },
  };
}

/**
 * `definition` with every Capella environment selector repointed at `name` — the instance-level
 * one each situational and Capella Analytics run reads, and the cluster-level one a Capella
 * functional cluster carries (inline or via clusterConfigs). Returns a copy; the input is untouched.
 */
export function withCapellaEnvironment(definition: FitDefinition, name: string): FitDefinition {
  return {
    ...definition,
    instances: definition.instances.map((instance) => ({
      ...instance,
      setup: { ...instance.setup, capellaEnvironment: name },
      clusters: instance.clusters.map((cluster) => clusterWithEnvironment(cluster, name)),
    })),
    ...(definition.clusterConfigs
      ? { clusterConfigs: definition.clusterConfigs.map((config) => clusterConfigWithEnvironment(config, name)) }
      : {}),
  };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const [path] = process.argv.slice(2);
    if (!path) {
      console.error("Usage: CAPELLA_ENVIRONMENT=<name> bun src/fit/shared/definition/capella-environment.ts <definition file>");
      process.exit(2);
    }
    const { loadDefinition } = await import("./parse-definition.js");
    const name = capellaEnvironmentFromEnv();
    const definition = loadDefinition(path);
    console.log(JSON.stringify({
      selected: name ?? "(CAPELLA_ENVIRONMENT not set)",
      overridesFromEnv: capellaEnvironmentOverridesFromEnv() ?? "(none)",
      instances: (name ? withCapellaEnvironment(definition, name) : definition).instances.map((i) => i.setup?.capellaEnvironment),
    }, null, 2));
  });
}
