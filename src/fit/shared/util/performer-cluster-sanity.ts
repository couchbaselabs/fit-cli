/**
 * Workflow: sanity-check whether a running performer container can plausibly
 * reach the selected cluster.
 *
 * Run on its own:
 *   bun src/fit/shared/util/performer-cluster-sanity.ts <connection-string> <performer-container-id>
 *   bun src/fit/shared/util/performer-cluster-sanity.ts --help
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliError, fitCliWarn } from "../../../util/non-fit/fit-cli-log.js";
import { type Detail, type RunOutput } from "../../../util/non-fit/artifacts.js";
import { capture } from "../../../util/non-fit/proc.js";
import type { SelectedCluster } from "../../../cluster/cluster-select/cluster-select.js";
import { classifyConnectionString } from "../../../cluster/cluster-select/classify-connection-string.js";

export interface DockerNetworkAttachment {
  name: string;
  ipAddress: string;
  aliases: string[];
}

export interface DockerContainerInspection {
  id: string;
  name: string;
  hostname: string;
  networkMode: string;
  networks: DockerNetworkAttachment[];
}

export interface ClusterDockerEnvironment {
  clusterHost: string;
  containerNames: string[];
  networkNames: string[];
}

export interface PerformerClusterSanityAssessment extends RunOutput {
  ok: boolean;
}

export type CaptureCommand = (command: string, args: string[]) => Promise<string>;

export interface PerformerClusterSanityOptions {
  captureCommand?: CaptureCommand;
  dockerCommand?: string;
}

export type PerformerClusterSanityCliArgs =
  | { kind: "help"; exitCode: number }
  | {
      kind: "run";
      connectionString: string;
      performerContainerId: string;
      dockerCommand: string;
    };

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Pull the first host out of a Couchbase connection string hostname list. */
export function clusterHost(defaultHostname: string): string {
  const firstHost = defaultHostname.split(",")[0]?.trim() ?? defaultHostname.trim();
  if (firstHost.startsWith("[")) {
    const bracket = firstHost.indexOf("]");
    return normalizeHost(bracket === -1 ? firstHost : firstHost.slice(0, bracket + 1));
  }

  const colon = firstHost.indexOf(":");
  return normalizeHost(colon === -1 ? firstHost : firstHost.slice(0, colon));
}

export function dockerPsIdsArgs(): string[] {
  return ["ps", "-q"];
}

export function parseDockerPsIds(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

const DOCKER_INSPECT_FORMAT =
  '{"Id":{{json .Id}},"Name":{{json .Name}},' +
  '"Config":{"Hostname":{{json .Config.Hostname}}},' +
  '"HostConfig":{"NetworkMode":{{json .HostConfig.NetworkMode}}},' +
  '"NetworkSettings":{"Networks":{{json .NetworkSettings.Networks}}}}';

export function dockerInspectArgs(containerIds: readonly string[]): string[] {
  return ["inspect", `--format=${DOCKER_INSPECT_FORMAT}`, ...containerIds];
}

/** Parse CLI args for the standalone performer-cluster sanity mini CLI. */
export function parsePerformerClusterSanityCliArgs(
  args: readonly string[],
): PerformerClusterSanityCliArgs {
  if (args.length === 0) {
    return { kind: "help", exitCode: 2 };
  }

  let dockerCommand = "docker";
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      return { kind: "help", exitCode: 0 };
    }
    if (arg === "--docker") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("Usage: performer-cluster-sanity.ts <connection-string> <performer-container-id> [--docker <command>]");
      }
      dockerCommand = value;
      i++;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    positionals.push(arg);
  }

  if (positionals.length !== 2) {
    throw new Error("Usage: performer-cluster-sanity.ts <connection-string> <performer-container-id> [--docker <command>]");
  }

  return {
    kind: "run",
    connectionString: positionals[0],
    performerContainerId: positionals[1],
    dockerCommand,
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Parse the subset of `docker inspect` output used by the sanity check. */
export function parseDockerInspect(output: string): DockerContainerInspection[] {
  const trimmed = output.trim();
  const parsed: unknown = trimmed.startsWith("[")
    ? JSON.parse(trimmed)
    : trimmed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => {
      const networkSettings =
        typeof item.NetworkSettings === "object" && item.NetworkSettings !== null
          ? (item.NetworkSettings as Record<string, unknown>)
          : {};
      const networksRecord =
        typeof networkSettings.Networks === "object" && networkSettings.Networks !== null
          ? (networkSettings.Networks as Record<string, unknown>)
          : {};
      const hostConfig =
        typeof item.HostConfig === "object" && item.HostConfig !== null
          ? (item.HostConfig as Record<string, unknown>)
          : {};
      const config =
        typeof item.Config === "object" && item.Config !== null
          ? (item.Config as Record<string, unknown>)
          : {};

      const networks = Object.entries(networksRecord).flatMap(([name, value]) => {
        if (typeof value !== "object" || value === null) {
          return [];
        }

        const network = value as Record<string, unknown>;
        return [{
          name,
          ipAddress: stringValue(network.IPAddress),
          aliases: stringArray(network.Aliases),
        }];
      });

      return {
        id: stringValue(item.Id),
        name: stringValue(item.Name).replace(/^\//, ""),
        hostname: stringValue(config.Hostname),
        networkMode: stringValue(hostConfig.NetworkMode),
        networks,
      };
    });
}

function containerAddresses(container: DockerContainerInspection): Set<string> {
  return new Set([
    normalizeHost(container.name),
    normalizeHost(container.hostname),
    ...container.networks.flatMap((network) => [
      normalizeHost(network.ipAddress),
      ...network.aliases.map((alias) => normalizeHost(alias)),
    ]),
  ].filter(Boolean));
}

function clusterContainersForHost(
  clusterHostname: string,
  performerId: string,
  containers: readonly DockerContainerInspection[],
): DockerContainerInspection[] {
  const normalizedClusterHost = normalizeHost(clusterHostname);
  return containers.filter((container) => {
    if (container.id === performerId) {
      return false;
    }
    return containerAddresses(container).has(normalizedClusterHost);
  });
}

function summarizeNetworks(containers: readonly DockerContainerInspection[]): string {
  const names = new Set(containers.flatMap((container) => container.networks.map((network) => network.name)));
  return [...names].sort().join(", ") || "(none)";
}

function summarizeNetworkNames(networkNames: readonly string[]): string {
  return [...new Set(networkNames)].sort().join(", ") || "(none)";
}

function performerClusterSanityDetails(
  ok: boolean,
  summary: string,
  extraDetails: readonly Detail[] = [],
): PerformerClusterSanityAssessment {
  return {
    ok,
    artifacts: [],
    details: [{ label: "Performer-cluster sanity", value: summary }, ...extraDetails],
  };
}

/** Describe the Docker containers and networks backing the selected cluster host, if any. */
export function describeClusterDockerEnvironment(
  cluster: SelectedCluster,
  containers: readonly DockerContainerInspection[],
): ClusterDockerEnvironment | undefined {
  const matchedClusterContainers = clusterContainersForHost(clusterHost(cluster.defaultHostname), "", containers);
  if (matchedClusterContainers.length === 0) {
    return undefined;
  }

  return {
    clusterHost: clusterHost(cluster.defaultHostname),
    containerNames: matchedClusterContainers.map((container) => container.name).filter(Boolean).sort(),
    networkNames: summarizeNetworks(matchedClusterContainers).split(", ").filter((name) => name !== "(none)"),
  };
}

export function clusterDockerEnvironmentDetails(environment: ClusterDockerEnvironment): Detail[] {
  return [
    { label: "Cluster Docker host", value: environment.clusterHost },
    { label: "Cluster Docker containers", value: environment.containerNames.join(", ") || "(none)" },
    { label: "Cluster Docker networks", value: summarizeNetworkNames(environment.networkNames) },
  ];
}

/** Inspect local Docker metadata to find the networks used by the selected cluster host. */
export async function detectClusterDockerEnvironment(
  cluster: SelectedCluster,
  options: PerformerClusterSanityOptions = {},
): Promise<ClusterDockerEnvironment | undefined> {
  const captureCommand = options.captureCommand ?? capture;
  const dockerCommand = options.dockerCommand ?? "docker";

  try {
    const runningContainerIds = parseDockerPsIds(await captureCommand(dockerCommand, dockerPsIdsArgs()));
    if (runningContainerIds.length === 0) {
      return undefined;
    }
    const containers = parseDockerInspect(await captureCommand(dockerCommand, dockerInspectArgs(runningContainerIds)));
    return describeClusterDockerEnvironment(cluster, containers);
  } catch (err) {
    fitCliWarn(
      `Couldn't inspect the local Docker containers, so the performer can't be placed on the cluster's Docker ` +
        `network. Expect the SDK to fail to reach ${clusterHost(cluster.defaultHostname)}. Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/** Build the minimum SelectedCluster shape needed by the sanity check CLI. */
export function buildSanityCluster(connectionString: string): SelectedCluster {
  const classified = classifyConnectionString(connectionString);
  if (classified.kind !== "supported") {
    throw new Error("The connection string must use couchbase:// or couchbases://.");
  }

  return {
    scheme: classified.scheme,
    defaultHostname: classified.defaultHostname,
    flavour: classified.flavour,
    credentials: { username: "", password: "" },
    tls: classified.scheme === "couchbases" ? { insecure: true } : null,
  };
}

/** Assess whether the performer container can plausibly reach the selected cluster. */
export function assessPerformerClusterSanity(
  cluster: SelectedCluster,
  performer: DockerContainerInspection,
  containers: readonly DockerContainerInspection[],
): PerformerClusterSanityAssessment {
  const targetClusterHost = clusterHost(cluster.defaultHostname);

  if (LOCALHOST_HOSTS.has(targetClusterHost)) {
    const ok = performer.networkMode === "host";
    return performerClusterSanityDetails(
      ok,
      ok
        ? `cluster host ${targetClusterHost} is reachable because the performer uses Docker host networking`
        : `cluster host ${targetClusterHost} points at loopback, which resolves inside the performer container instead of to the host cluster`,
      [
        { label: "Cluster host", value: targetClusterHost },
        { label: "Performer network mode", value: performer.networkMode || "(default)" },
      ],
    );
  }

  const clusterEnvironment = describeClusterDockerEnvironment(cluster, containers.filter((container) => container.id !== performer.id));
  if (!clusterEnvironment) {
    return performerClusterSanityDetails(
      true,
      `cluster host ${targetClusterHost} does not look like a Docker container on this machine`,
      [{ label: "Cluster host", value: targetClusterHost }],
    );
  }

  const performerNetworks = new Set(performer.networks.map((network) => network.name));
  const sharedNetworks = new Set(
    clusterEnvironment.networkNames.filter((name) => performerNetworks.has(name)),
  );

  const sharedNetworkList = [...sharedNetworks].sort();
  const ok = sharedNetworkList.length > 0;
  const performerNetworkSummary = summarizeNetworks([performer]);
  const clusterNetworkSummary = summarizeNetworkNames(clusterEnvironment.networkNames);
  return performerClusterSanityDetails(
    ok,
    ok
      ? `performer and cluster share Docker network${sharedNetworkList.length === 1 ? "" : "s"} ${sharedNetworkList.join(", ")}`
      : `cluster host ${targetClusterHost} is running in Docker, but the performer container is not on the same Docker network (performer: ${performerNetworkSummary}; cluster: ${clusterNetworkSummary})`,
    [
      { label: "Cluster host", value: targetClusterHost },
      { label: "Performer networks", value: performerNetworkSummary },
      { label: "Cluster networks", value: clusterNetworkSummary },
      { label: "Cluster containers", value: clusterEnvironment.containerNames.join(", ") || "(none)" },
    ],
  );
}

/** Run the performer/cluster sanity check using Docker metadata from the current execution target. */
export async function runPerformerClusterSanityCheck(
  cluster: SelectedCluster,
  performerContainerId: string | undefined,
  options: PerformerClusterSanityOptions = {},
): Promise<PerformerClusterSanityAssessment> {
  if (!performerContainerId) {
    fitCliWarn("\nSkipping performer/cluster sanity check because fit-cli is not managing a performer container.");
    return performerClusterSanityDetails(true, "skipped: performer container is externally managed");
  }

  // CNG performers connect to the gateway over couchbase2 (often via an exposed
  // node port), not to the classic cluster host on a shared Docker network — so
  // the Docker-network heuristic below doesn't apply and would false-negative.
  if (cluster.cng) {
    fitCliWarn("\nSkipping performer/cluster sanity check for CNG (performer reaches the gateway over couchbase2).");
    return performerClusterSanityDetails(true, "skipped: CNG performer connects to the gateway over couchbase2");
  }

  const captureCommand = options.captureCommand ?? capture;
  const dockerCommand = options.dockerCommand ?? "docker";

  try {
    const runningContainerIds = parseDockerPsIds(await captureCommand(dockerCommand, dockerPsIdsArgs()));
    const containerIds = [...new Set([performerContainerId, ...runningContainerIds])];
    const containers = parseDockerInspect(await captureCommand(dockerCommand, dockerInspectArgs(containerIds)));
    const performer = containers.find((container) => container.id === performerContainerId);
    if (!performer) {
      fitCliWarn(`\nSkipping performer/cluster sanity check because ${performerContainerId} is no longer running.`);
      return performerClusterSanityDetails(true, `skipped: performer container ${performerContainerId} is no longer running`);
    }

    const result = assessPerformerClusterSanity(cluster, performer, containers);
    if (result.ok) {
      console.log(`\n✓ Performer/cluster sanity check passed: ${result.details[0]?.value}`);
    } else {
      fitCliError(`\nPerformer/cluster sanity check failed: ${result.details[0]?.value}`);
      for (const detail of result.details.slice(1)) {
        fitCliError(`  ${detail.label}: ${detail.value}`);
      }
    }
    return result;
  } catch (err) {
    fitCliWarn(`\nSkipping performer/cluster sanity check: ${(err as Error).message}`);
    return performerClusterSanityDetails(true, `skipped: ${(err as Error).message}`);
  }
}

const HELP = `Check whether a running performer container can plausibly reach a Couchbase cluster.

Usage:
  bun src/fit/shared/util/performer-cluster-sanity.ts <connection-string> <performer-container-id>
  bun src/fit/shared/util/performer-cluster-sanity.ts <connection-string> <performer-container-id> --docker <command>
  bun src/fit/shared/util/performer-cluster-sanity.ts --help

Examples:
  bun src/fit/shared/util/performer-cluster-sanity.ts couchbase://172.18.0.2 abc123
  bun src/fit/shared/util/performer-cluster-sanity.ts couchbase://localhost abc123 --docker /usr/bin/docker

Exits 0 when the sanity check passes or is skipped, and 1 when it fails.`;

if (isMain(import.meta.url)) {
  runCli(async () => {
    const parsed = parsePerformerClusterSanityCliArgs(process.argv.slice(2));
    if (parsed.kind === "help") {
      console.log(HELP);
      if (parsed.exitCode !== 0) {
        process.exit(parsed.exitCode);
      }
      return;
    }

    const cluster = buildSanityCluster(parsed.connectionString);
    console.log(
      `\nChecking whether performer container ${parsed.performerContainerId} can plausibly reach ` +
        `${cluster.scheme}://${cluster.defaultHostname}...\n`,
    );
    const result = await runPerformerClusterSanityCheck(cluster, parsed.performerContainerId, {
      dockerCommand: parsed.dockerCommand,
    });
    if (!result.ok) {
      process.exitCode = 1;
    }
    return result;
  });
}
