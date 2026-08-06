/**
 * Step: build debug links (Capella UI, Fleet Manager, DataDog logs) for a
 * Capella cloud cluster, keyed off its Couchbase cluster UUID (see
 * allocate-cluster.ts). These are printed right after that UUID whenever a
 * `cloud` cluster is allocated or reused (see allocate-cluster.ts /
 * setup-declarative-cluster.ts).
 *
 * The Capella UI host is derived by stripping the "api." prefix off the
 * control-plane endpoint (verified against both prod ->
 * https://cloud.couchbase.com and dev -> https://dev.nonprod-project-avengers.com);
 * the org id reuses environments.capella[env].oid, the same org the shared
 * sdk_qe@couchbase.com account uses for API calls.
 *
 * The Fleet Manager host is *not* independently confirmed for every environment
 * — only "dev" is verified (https://api.dev.nonprod-project-avengers.com ->
 * https://fm.dev.nonprod-project-avengers.com). Other environments (notably
 * "prod") get the same api.->fm. substitution applied on the assumption it
 * follows the same pattern, so the link may 404. It likely also needs VPN
 * access to load at all. Callers should say so when printing it.
 *
 * Run on its own:
 *   bun src/cluster/cluster-create/capella-debug-links.ts dev b0652a58-45d4-4cf7-afff-343ca735c6c6
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { loadEnvironments, type EnvironmentsFile } from "../../fit/util/environments.js";

export interface CapellaDebugLinks {
  /** The org's databases list in the Capella UI — absent if the environment has no oid configured. */
  capellaUiUrl?: string;
  /** Best-guess Fleet Manager cluster page — see the caveat above. */
  fleetManagerUrl: string;
  /** DataDog logs, filtered by env and clusterId. */
  datadogLogsUrl: string;
}

/**
 * The org's databases list in the Capella UI for `environment`, or undefined if
 * the environment isn't configured or has no oid. Doesn't need a cluster UUID —
 * usable even when allocation failed before cbdinocluster logged one, so the
 * user can browse to the cluster manually (the way this feature was motivated).
 */
export function capellaUiUrl(
  environment: string,
  environments: EnvironmentsFile = loadEnvironments(),
): string | undefined {
  const capellaEnv = environments.capella[environment];
  if (!capellaEnv?.endpoint || !capellaEnv.oid) {
    return undefined;
  }
  const uiHost = capellaEnv.endpoint.replace(/^https:\/\/api\./, "https://");
  return `${uiHost}/databases?oid=${capellaEnv.oid}`;
}

/**
 * Build the Capella UI, Fleet Manager and DataDog links for a Capella cluster,
 * or undefined if `environment` isn't configured in environments.json5 (so
 * there's no control-plane endpoint to derive the other hosts from).
 */
export function capellaDebugLinks(
  environment: string,
  couchbaseClusterUuid: string,
  environments: EnvironmentsFile = loadEnvironments(),
): CapellaDebugLinks | undefined {
  const endpoint = environments.capella[environment]?.endpoint;
  if (!endpoint) {
    return undefined;
  }
  const fleetManagerHost = endpoint.replace(/^https:\/\/api\./, "https://fm.");
  const datadogQuery = `env:${environment} @clusterId:${couchbaseClusterUuid}`;
  const uiUrl = capellaUiUrl(environment, environments);
  return {
    ...(uiUrl ? { capellaUiUrl: uiUrl } : {}),
    fleetManagerUrl: `${fleetManagerHost}/clusters/${couchbaseClusterUuid}`,
    datadogLogsUrl: `https://app.datadoghq.com/logs?query=${encodeURIComponent(datadogQuery)}`,
  };
}

/** One entry in run.json5's `forDatabase.debug.items[]` array. */
export interface DebugLink {
  /** Rendered verbatim. */
  label: string;
  url?: string;
  description?: string;
  /** A shell command shown with a copy button, e.g. an archive-fetch command. */
  command?: string;
  imageUrl?: string;
}

/**
 * Build the `forDatabase.debug.items[]` entries for a Capella cluster from
 * {@link capellaDebugLinks}, plus (when `archiveZipKey` is given) a link to fetch
 * the run's archived artifacts. Returns an empty array when `environment` isn't
 * configured in environments.json5.
 */
export function buildDebugLinks(
  environment: string,
  couchbaseClusterUuid: string,
  archiveZipKey?: string,
  environments: EnvironmentsFile = loadEnvironments(),
): DebugLink[] {
  const links = capellaDebugLinks(environment, couchbaseClusterUuid, environments);
  const result: DebugLink[] = [];
  if (links?.capellaUiUrl) {
    result.push({ label: "Capella UI", url: links.capellaUiUrl });
  }
  if (links) {
    result.push({
      label: "Fleet Manager",
      url: links.fleetManagerUrl,
      description: "Needs VPN access.",
    });
    result.push({ label: "DataDog logs", url: links.datadogLogsUrl });
  }
  if (archiveZipKey) {
    result.push({
      label: "Run archive",
      url: `https://s3.console.aws.amazon.com/s3/object/${archiveZipKey.replace(/^s3:\/\//, "")}`,
      description: "Zipped run artifacts (logs, JUnit reports, etc.), uploaded to S3.",
      command: `fit archive fetch ${archiveZipKey}`,
    });
  }
  return result;
}

/** Print the debug links (if any) for a Capella cluster, with the Fleet Manager caveat. */
export function printCapellaDebugLinks(environment: string, couchbaseClusterUuid: string): void {
  const links = capellaDebugLinks(environment, couchbaseClusterUuid);
  if (!links) {
    return;
  }
  if (links.capellaUiUrl) {
    console.log(`  Capella UI (${environment}): ${links.capellaUiUrl}`);
  }
  console.log(
    `  Fleet Manager (needs VPN): ${links.fleetManagerUrl}`,
  );
  console.log(`  DataDog logs: ${links.datadogLogsUrl}`);
}

/**
 * Print just the Capella UI link (no UUID needed) — for allocation failures,
 * where cbdinocluster never got far enough to log a Couchbase cluster UUID, so
 * the user has to find the cluster manually to investigate or clean it up.
 */
export function printCapellaUiLink(environment: string): void {
  const url = capellaUiUrl(environment);
  if (url) {
    console.log(`  Capella UI (${environment} — find the cluster here since no UUID was logged): ${url}`);
  }
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const [environment, uuid] = process.argv.slice(2);
    if (!environment || !uuid) {
      console.error(
        "Usage: bun src/cluster/cluster-create/capella-debug-links.ts <environment> <couchbaseClusterUuid>",
      );
      process.exit(2);
    }
    const links = capellaDebugLinks(environment, uuid);
    if (!links) {
      console.error(`No Capella environment "${environment}" configured in environments.json5.`);
      process.exit(1);
    }
    console.log(JSON.stringify(links, null, 2));
    return Promise.resolve();
  });
}
