/**
 * Env-var control of which Capella environment a run targets. This is what makes a sandbox usable
 * from a preset, which pins its own environment (`capellaEnvironment: 'prod'`):
 *
 *   CAPELLA_ENVIRONMENT=sandbox CAPELLA_V4_ENDPOINT=https://cloudapi.... CAPELLA_OID=... \
 *   CAPELLA_API_KEY=... CAPELLA_API_SECRET=... fit run preset op-capella-sit-sanity --performer java-fit-performer:main
 *
 * The sandbox's control plane and accounts aren't applied here: they are read from the env when the
 * run resolves its Capella config (see resolveCapellaConfig).
 *
 * Run on its own:
 *   CAPELLA_ENVIRONMENT=sandbox bun src/fit/shared/definition/capella-environment.ts examples/documented.json5
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { isSandboxCapellaEnvironment, loadEnvironments, type EnvironmentsFile } from "../../util/environments.js";
import { buildExecutionGroups, resolveDefinition, usesCapella } from "./resolve-definition.js";
import type { CbdinoclusterSetup, FitDefinition } from "./types.js";

/** The environment named by CAPELLA_ENVIRONMENT, or undefined when it isn't set. */
export function capellaEnvironmentFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CAPELLA_ENVIRONMENT?.trim() || undefined;
}

/** Whether any group in `definition` allocates on a sandbox Capella environment, as the run resolves it. */
export function definitionTargetsSandbox(
  definition: FitDefinition,
  environments: EnvironmentsFile = loadEnvironments(),
): boolean {
  return buildExecutionGroups(resolveDefinition(definition).instances)
    .some((group) => usesCapella(group) && isSandboxCapellaEnvironment(group.capellaEnvironment, environments));
}

/** An inline cluster or a cluster config with any `capella.environment` pin repointed at `name`. */
function withPinnedEnvironment<T extends { cbdinocluster?: CbdinoclusterSetup }>(holder: T, name: string): T {
  if (!holder.cbdinocluster?.capella) return holder;
  return {
    ...holder,
    cbdinocluster: { ...holder.cbdinocluster, capella: { ...holder.cbdinocluster.capella, environment: name } },
  };
}

/**
 * `definition` with every Capella environment selector repointed at `name` — the instance-level
 * one every run reads, and any per-cluster `capella.environment` pin (inline or via clusterConfigs),
 * which would otherwise win over it. Returns a copy; the input is untouched.
 */
export function withCapellaEnvironment(definition: FitDefinition, name: string): FitDefinition {
  return {
    ...definition,
    instances: definition.instances.map((instance) => ({
      ...instance,
      setup: { ...instance.setup, capellaEnvironment: name },
      clusters: instance.clusters.map((cluster) => withPinnedEnvironment(cluster, name)),
    })),
    ...(definition.clusterConfigs
      ? { clusterConfigs: definition.clusterConfigs.map((config) => withPinnedEnvironment(config, name)) }
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
    const loaded = loadDefinition(path);
    const definition = name ? withCapellaEnvironment(loaded, name) : loaded;
    console.log(JSON.stringify({
      selected: name ?? "(CAPELLA_ENVIRONMENT not set)",
      instances: definition.instances.map((i) => i.setup?.capellaEnvironment),
      targetsSandbox: definitionTargetsSandbox(definition),
    }, null, 2));
  });
}
