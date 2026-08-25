/**
 * Step: stand up the cluster a definition file asked for with its `cbdinocluster`
 * block — the non-interactive, definition-driven counterpart to the guided
 * cluster-create workflow. It's what the run-from-definition flow's setup-cluster
 * step calls.
 *
 * The shape mirrors the performer's "check and run" logic: look at what's already
 * there, apply the file's {@link ClusterExistsPolicy} (rather than prompting),
 * then allocate as needed and resolve the result into a {@link SelectedCluster}
 * the rest of the run can test against. Like the performer, it does *not* check
 * that an existing cluster matches the desired spec — `useExisting` trusts it.
 *
 * Run on its own (this can really allocate/remove clusters, so mean it):
 *   bun src/cluster/cluster-create/setup-declarative-cluster.ts
 */
import YAML from "yaml";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type RunOutput } from "../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import type { PieceData } from "../../util/non-fit/config-pieces.js";
import { ensureRunDir } from "../../util/non-fit/replay.js";
import { posixQuote } from "../../util/non-fit/remote-target.js";
import { findOnPath } from "../../util/non-fit/which.js";
import { CAPELLA_DEFAULT_CREDENTIALS, DEFAULT_CREDENTIALS } from "../cluster-select/ask-credentials.js";
import { classifyConnectionString } from "../cluster-select/classify-connection-string.js";
import type { SelectedCluster } from "../cluster-select/cluster-select.js";
import { parseClusterIds, type CbdinoCluster } from "../cluster-select/parse-cluster-ids.js";
import { parseConnstr } from "../cluster-select/parse-connstr.js";
import {
  allocateCluster,
  localClusterCommandExecutor,
  type ClusterCommandExecutor,
} from "./allocate-cluster.js";
import { CBDINOCLUSTER_URL, DEFAULT_CAPELLA_ENV } from "../../fit/util/config.js";
import { printCapellaDebugLinks } from "./capella-debug-links.js";
import { buildCbdinoclusterFromPr, installCbdinoclusterRemote } from "./install-cbdinocluster.js";
import { installCaoCrdsAndAdmission } from "./install-cao-tools.js";
import { enableIngresses } from "./cao-ingress.js";
import { type ClusterExistsPolicy } from "./cluster-exists-policy.js";
import { loadEnvironments } from "../../fit/util/environments.js";
import { cngServerImageRef, type CbdinoclusterDef } from "./build-cluster-def.js";
import { isAlias, resolveAlias } from "./cb-alias.js";
import type { CapellaClusterSetup, CbdinoclusterInitSetup, CbdinoclusterSource } from "../../fit/shared/definition/types.js";
import { capellaKeyPoolInitArgs, defaultCbdinoclusterInitArgs, situationalCbdinoclusterInitArgs } from "./default-cbdinocluster-init-config.js";
import { allocatePurpose } from "./allocate-purpose.js";
import { throwFatalToCluster } from "../../fit/shared/failure-classification.js";
import { deleteVpcEndpointsForCluster } from "../../cloud/util/aws/delete-vpc-endpoints.js";
import { fitCliWarn } from "../../util/non-fit/fit-cli-log.js";

/** The bare command name we look for on the PATH. */
const CBDINOCLUSTER = "cbdinocluster";
const CBDINOCLUSTER_INIT_REQUIRED = "you must run the `init` command first";
const CBDINOCLUSTER_CONFIG_FILENAME = ".cbdinocluster";
const CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH = `~/${CBDINOCLUSTER_CONFIG_FILENAME}`;

async function resolveCbdinoclusterCommand(
  execution: ClusterCommandExecutor,
  source?: CbdinoclusterSource,
): Promise<string | undefined> {
  // When a git source (PR or branch) is specified, always build from it on the
  // remote box — even if some other cbdinocluster binary happens to be on PATH already.
  if (source?.git !== undefined) {
    if (execution.description === "this machine") {
      console.error(
        `\n✗ setup-cluster: cbdinocluster.source.git is only supported on remote (AWS) instances, not on this machine.`,
      );
      return undefined;
    }
    return buildCbdinoclusterFromPr(execution, source.git);
  }

  if (await execution.commandAvailable(CBDINOCLUSTER)) {
    return CBDINOCLUSTER;
  }

  // On this machine we don't auto-install — the caller points the operator at
  // where to get it. On a remote box we install the matching binary straight
  // from the cbdinocluster releases instead of staging up whatever (if anything)
  // is on this machine.
  if (execution.description === "this machine") {
    return findOnPath(CBDINOCLUSTER) ?? undefined;
  }

  console.log(`→ setup-cluster: cbdinocluster isn't on ${execution.description} — installing the latest release.`);
  return installCbdinoclusterRemote(execution);
}

export function cbdinoclusterNeedsInit(message: string): boolean {
  return message.includes(CBDINOCLUSTER_INIT_REQUIRED);
}

/** Whether the executor runs on a remote box (vs. this machine). */
function isRemoteExecution(execution: ClusterCommandExecutor): boolean {
  return "kind" in execution && (execution as { kind?: string }).kind === "remote";
}

/**
 * Warn (but continue) if `~/.cbdinocluster` doesn't have the docker deployer enabled.
 * Only checks on local execution — remote boxes get their config written by cbdinocluster init.
 */
function warnIfDockerNotEnabled(execution: ClusterCommandExecutor): void {
  if (isRemoteExecution(execution)) {
    return;
  }
  const configPath = join(homedir(), CBDINOCLUSTER_CONFIG_FILENAME);
  let config: unknown;
  try {
    config = YAML.parse(readFileSync(configPath, "utf8"));
  } catch {
    return;
  }
  const dockerEnabled =
    config !== null &&
    typeof config === "object" &&
    "docker" in config &&
    typeof (config as Record<string, unknown>).docker === "object" &&
    (config as Record<string, unknown>).docker !== null &&
    (config as { docker: Record<string, unknown> }).docker.enabled === "true";
  if (!dockerEnabled) {
    console.warn(
      `⚠ setup-cluster: ${configPath} does not have docker enabled (docker.enabled: "true"). ` +
        `The docker deployer may fail — run \`cbdinocluster init\` to configure it.`,
    );
  }
}

function dockerNetworkFromInitConfig(config: PieceData): string | undefined {
  const docker = config.docker;
  if (!docker || typeof docker !== "object" || Array.isArray(docker) || docker === null) {
    return undefined;
  }
  return typeof docker.network === "string" && docker.network.trim() ? docker.network.trim() : undefined;
}

async function uploadCbdinoclusterConfig(execution: ClusterCommandExecutor, config: PieceData, cycleDir: string): Promise<void> {
  mkdirSync(cycleDir, { recursive: true, mode: 0o700 });
  const localConfigPath = join(cycleDir, "cbdinocluster-init.yaml");
  writeFileSync(localConfigPath, YAML.stringify(config));
  const stagedConfigPath = await execution.stageFile(localConfigPath, execution.targetFilePath(localConfigPath));
  await execution.run("sh", [
    "-lc",
    `cp ${posixQuote(stagedConfigPath)} ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH} && chmod 600 ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH}`,
  ], undefined, { display: `install cbdinocluster config to ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH}` });
}

async function ensureDockerNetwork(execution: ClusterCommandExecutor, network: string): Promise<void> {
  if (["bridge", "host", "none"].includes(network)) {
    return;
  }
  // Probe silently (we only need the exit code), then create only if absent so
  // the creation output flows through run() and into session.debug.log.
  const exists = await execution.capture("sh", [
    "-lc",
    `docker network inspect ${posixQuote(network)} >/dev/null 2>&1 && printf yes || printf no`,
  ], undefined, { quiet: true }).then((out) => out.trim() === "yes").catch(() => false);
  if (!exists) {
    await execution.run("docker", ["network", "create", network], undefined, {
      display: `docker network create ${network}`,
    });
  }
}

/**
 * Log Docker into GHCR so the pre-flight pull (and cbdinocluster itself) can access
 * private images.  Writes the token to a temp file so it never appears on argv,
 * matching the display-override pattern used elsewhere for credentials.
 */
async function loginToGhcr(
  execution: ClusterCommandExecutor,
  githubCredentials: { user: string; token: string },
  cycleDir: string,
): Promise<void> {
  const localTokenPath = join(cycleDir, "ghcr-token.txt");
  writeFileSync(localTokenPath, `${githubCredentials.token}\n`, { mode: 0o600 });
  const targetTokenPath = await execution.stageFile(localTokenPath);
  rmSync(localTokenPath, { force: true });
  await execution.run(
    "sh",
    ["-lc", `cat ${posixQuote(targetTokenPath)} | docker login ghcr.io --username x-access-token --password-stdin && rm -f ${posixQuote(targetTokenPath)}`],
    undefined,
    { display: "docker login ghcr.io" },
  );
}

/** Parse `--docker-network <name>` (or `--docker-network=<name>`) out of an init args string. */
export function dockerNetworkFromInitArgs(args: string): string | undefined {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--docker-network" && tokens[i + 1]) {
      return tokens[i + 1];
    }
    const inline = tokens[i].match(/^--docker-network=(.+)$/);
    if (inline) {
      return inline[1];
    }
  }
  return undefined;
}

/**
 * Prepare `~/.cbdinocluster` on a clean box by running `cbdinocluster init <args>`,
 * letting cbdinocluster self-install its config (the docker path). `args` is the
 * editable string from the definition; the GitHub credentials are appended here so
 * they never live in the definition file — with creds we pass
 * `--github-user/--github-token` (which enables GitHub), without them
 * `--disable-github`. The run's own Capella API key pool flags are appended the
 * same way (see {@link capellaKeyPoolInitArgs}), and the returned
 * `capellaKeyPool` tells teardown whether there is a pool to remove. Afterwards
 * the docker network the args name is created if it isn't a built-in
 * (cbdinocluster init records the network but doesn't create it).
 *
 * Only runs on a remote box; on this machine we leave the operator's own
 * `~/.cbdinocluster` (and its clusters) alone, mirroring
 * {@link prepareCbdinoclusterConfig}.
 */
export async function runCbdinoclusterInit(
  execution: ClusterCommandExecutor,
  cbdinocluster: string,
  args: string,
  githubCredentials?: { user: string; token: string },
  configPatch?: PieceData,
  cycleDir: string = ensureRunDir(),
): Promise<{ capellaKeyPool: boolean }> {
  if (!("kind" in execution) || execution.kind !== "remote") {
    return { capellaKeyPool: false };
  }
  const initArgs = args.trim().split(/\s+/).filter(Boolean);
  const credArgs = githubCredentials
    ? ["--github-user", githubCredentials.user, "--github-token", githubCredentials.token]
    : ["--disable-github"];
  const poolArgs = capellaKeyPoolInitArgs(initArgs, allocatePurpose());
  console.log(
    `→ setup-cluster: initializing cbdinocluster on ${execution.description} with \`cbdinocluster init ${args}\``,
  );
  // Start from a clean slate: an instance with several execution groups runs init
  // once per group against the same `~/.cbdinocluster`. `init --auto` takes its
  // "enable Capella?" default from any existing config, so a docker-only group's
  // init (`--disable-capella`) would otherwise poison a later situational group's
  // init into leaving Capella disabled — no `cloud` deployer, and `allocate
  // --deployer cloud` later fatals with "no deployers". Removing the file first
  // makes `--auto` key off the forwarded env/flags, not the previous group's run.
  // Only the config (deployers/creds) is removed; cluster state lives in Docker.
  // The Capella API key pool survives this. A later group's init finds the run's
  // keys by the pool name prefix and rotates them, so the run keeps one pool and
  // only the final teardown removes it.
  await execution.run("sh", ["-lc", `rm -f ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH}`], undefined, {
    display: `rm -f ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH}`,
  });
  // Run via a login shell so `~/.profile` is sourced and `init --auto` inherits the
  // forwarded CAPELLA_*/AWS_* env vars (without them it silently leaves the capella
  // block disabled and `cbdinocluster allocate --deployer cloud` later fatals with
  // "no deployers"). `execution.run` would otherwise ssh in non-login. The
  // credentials are kept out of the echoed command via `display`.
  // Hidden unless it fails: the SSH transport itself can print unrelated
  // diagnostics on stderr (e.g. a cloud provider's OS Login banner naming the
  // account), which we don't want streamed live for every init.
  const initCmdline = [cbdinocluster, "init", ...initArgs, ...credArgs, ...poolArgs].map(posixQuote).join(" ");
  await execution.runHiddenUntilFailure("bash", ["-lc", initCmdline], undefined, {
    display: `cbdinocluster init ${args}`,
  });
  const network = dockerNetworkFromInitArgs(args);
  if (network) {
    console.log(`→ setup-cluster: ensuring Docker network ${network} exists on ${execution.description}`);
    await ensureDockerNetwork(execution, network);
  }
  // Layer on config `cbdinocluster init` can't set via flags (e.g. situational's
  // capella/aws blocks — `--auto` leaves those disabled regardless of flags).
  if (configPatch) {
    await mergeRemoteCbdinoclusterConfig(execution, configPatch, cycleDir);
  }
  return { capellaKeyPool: poolArgs.length > 0 };
}

/**
 * Merge extra top-level blocks onto the `~/.cbdinocluster` that `cbdinocluster
 * init` just wrote, for config init can't express via flags (situational's
 * `capella`/`aws`). Reads the file init produced, shallow-merges the patch's
 * top-level keys over it, and writes it back. Remote-only, mirroring
 * {@link runCbdinoclusterInit}: on this machine we leave the operator's own
 * `~/.cbdinocluster` alone.
 */
export async function mergeRemoteCbdinoclusterConfig(
  execution: ClusterCommandExecutor,
  patch: PieceData,
  cycleDir: string = ensureRunDir(),
): Promise<void> {
  if (!("kind" in execution) || execution.kind !== "remote") {
    return;
  }
  const existing = await execution.capture(
    "sh",
    ["-lc", `cat ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH}`],
    undefined,
    { quiet: true },
  );
  const base = (YAML.parse(existing) ?? {}) as PieceData;
  const merged: PieceData = { ...base, ...patch };
  console.log(
    `→ setup-cluster: merging capella/aws config into ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH} on ${execution.description}`,
  );
  await uploadCbdinoclusterConfig(execution, merged, cycleDir);
}

/**
 * Verify `cbdinocluster init` actually enabled the Capella (cloud) deployer, by
 * confirming the forwarded control-plane `endpoint` made it into the written
 * `~/.cbdinocluster`. Situational runs need the cloud deployer; without it every
 * test later fatals at `allocate --deployer cloud` with "no deployers", so a
 * fail-fast check here surfaces the real cause. Schema-agnostic on purpose — we
 * look for the endpoint string rather than cbdinocluster's internal YAML keys.
 * Remote-only, and skipped when there's no endpoint to look for (returns true).
 */
export async function remoteCbdinoclusterCloudEnabled(
  execution: ClusterCommandExecutor,
  capellaEndpoint: string | undefined,
): Promise<boolean> {
  if (!("kind" in execution) || execution.kind !== "remote" || !capellaEndpoint) {
    return true;
  }
  const config = await execution.capture(
    "sh",
    ["-lc", `cat ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH}`],
    undefined,
    { quiet: true },
  );
  return config.includes(capellaEndpoint);
}

/**
 * Prepare `~/.cbdinocluster` from a definition's init setup, picking the right
 * path: the `args` path runs `cbdinocluster init <args>` (and merges any
 * `configPatch`); the legacy `config` path uploads a config object verbatim (CNG).
 * Used by the situational flow, which sets up its own cluster outside
 * {@link setupDeclarativeCluster}. Reports whether init created the run's Capella
 * API key pool, so teardown knows there is one to remove, and the cbdinocluster
 * command it resolved, so teardown can run the removal.
 */
export async function prepareCbdinoclusterInit(
  execution: ClusterCommandExecutor,
  init: CbdinoclusterInitSetup | undefined,
  githubCredentials?: { user: string; token: string },
  cycleDir: string = ensureRunDir(),
  source?: CbdinoclusterSource,
): Promise<{ capellaKeyPool: boolean; cbdinocluster?: string }> {
  if (init?.config !== undefined) {
    await prepareCbdinoclusterConfig(execution, init.config, githubCredentials, cycleDir);
  } else if (init !== undefined) {
    // Situational path: run cbdinocluster init with explicit args if present, or
    // generate the standard situational defaults.
    const args = init.args ?? situationalCbdinoclusterInitArgs();
    const cbdinocluster = await resolveCbdinoclusterCommand(execution, source);
    if (!cbdinocluster) {
      console.error(
        `\n✗ setup-cluster: cbdinocluster isn't on the PATH for ${execution.description}. ` +
          `Get it from ${CBDINOCLUSTER_URL}.`,
      );
      return { capellaKeyPool: false };
    }
    const result = await runCbdinoclusterInit(execution, cbdinocluster, args, githubCredentials, init.configPatch, cycleDir);
    return { ...result, cbdinocluster };
  }
  return { capellaKeyPool: false };
}

export async function prepareCbdinoclusterConfig(
  execution: ClusterCommandExecutor,
  config: PieceData | undefined,
  githubCredentials?: { user: string; token: string },
  cycleDir: string = ensureRunDir(),
): Promise<void> {
  if (!config || !("kind" in execution) || execution.kind !== "remote") {
    return;
  }
  const configToUpload: PieceData = githubCredentials
    ? { ...config, github: { enabled: "true", user: githubCredentials.user, token: githubCredentials.token } }
    : config;
  console.log(
    `→ setup-cluster: uploading cbdinocluster config to ${execution.description} as ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH}`,
  );
  await uploadCbdinoclusterConfig(execution, configToUpload, cycleDir);
  const network = dockerNetworkFromInitConfig(config);
  if (network) {
    console.log(`→ setup-cluster: ensuring Docker network ${network} exists on ${execution.description}`);
    await ensureDockerNetwork(execution, network);
  }
}

async function listExistingClusters(
  cbdinocluster: string,
  execution: ClusterCommandExecutor,
): Promise<CbdinoCluster[] | undefined> {
  try {
    return parseClusterIds(await execution.capture(cbdinocluster, ["ps"]));
  } catch (err) {
    const message = (err as Error).message;
    if (!cbdinoclusterNeedsInit(message)) {
      console.error(`\n✗ setup-cluster: couldn't list clusters (cbdinocluster ps): ${message}`);
      return undefined;
    }

    console.log(
      `→ setup-cluster: ${execution.description} has no cbdinocluster config yet — ` +
        `initializing a default one with \`${cbdinocluster} init --auto\`.`,
    );
    try {
      await execution.runHiddenUntilFailure(cbdinocluster, ["init", "--auto"]);
    } catch (initErr) {
      console.error(`\n✗ setup-cluster: couldn't initialize cbdinocluster: ${(initErr as Error).message}`);
      return undefined;
    }

    try {
      return parseClusterIds(await execution.capture(cbdinocluster, ["ps"]));
    } catch (retryErr) {
      console.error(
        `\n✗ setup-cluster: couldn't list clusters (cbdinocluster ps) after init: ${(retryErr as Error).message}`,
      );
      return undefined;
    }
  }
}

/** What setup-declarative-cluster decided to do about existing clusters (pure). */
export type ClusterExistsDecision =
  /** Nothing relevant is running (or none to reuse) — allocate a fresh cluster. */
  | { action: "allocate" }
  /** Trust the cluster already running and test against it. */
  | { action: "useExisting"; cluster: CbdinoCluster }
  /** Remove these clusters, then allocate a fresh one. */
  | { action: "recreate"; remove: CbdinoCluster[] }
  /** Stop the run without touching anything. */
  | { action: "abort"; reason: string };

/**
 * Decide what to do given the clusters cbdinocluster currently has running and
 * the file's policy. Pure logic — no IO — so it's easy to unit test. With no
 * existing clusters every policy allocates; `useExisting` trusts the first one.
 */
export function decideClusterExists(
  existing: CbdinoCluster[],
  policy: ClusterExistsPolicy,
): ClusterExistsDecision {
  if (existing.length === 0) {
    return { action: "allocate" };
  }
  switch (policy) {
    case "fail":
      return {
        action: "abort",
        reason:
          `${existing.length} cbdinocluster cluster(s) already running and onClusterExists is "fail". ` +
          `Remove them (cbdinocluster rm <id>) or change onClusterExists.`,
      };
    case "useExisting":
      return { action: "useExisting", cluster: existing[0] };
    case "destroyAndRecreate":
      return { action: "recreate", remove: existing };
  }
}

/** The outcome of standing up (or reusing) the cluster for a definition run. */
export interface SetupDeclarativeClusterResult extends RunOutput {
  /** The cluster to test against; undefined if setup failed. */
  cluster?: SelectedCluster;
  /** Whether this run allocated the cluster (and so should tear it down). */
  allocated: boolean;
  /** The allocated cluster's id, present when {@link allocated} is true. */
  clusterId?: string;
  /** The resolved cbdinocluster command, present when one was found — for teardown. */
  cbdinocluster?: string;
  /**
   * The Couchbase cluster's own UUID (distinct from cbdinocluster's own tracking
   * id, `clusterId`) — a generic concept that applies beyond Capella/PE. Populated
   * for any `cloud` (Capella) cluster, PE or not — cbdinocluster's `--verbose
   * allocate` logs it on every cloud allocation (see allocate-cluster.ts).
   */
  couchbaseClusterUuid?: string;
  /**
   * True only when private endpoint setup actually succeeded this run — gates
   * whether teardown should also delete a VPC endpoint. Not implied by
   * `couchbaseClusterUuid` alone, since that's now set for every cloud cluster.
   */
  privateEndpointEnabled?: boolean;
  /**
   * The Capella environment this cluster was allocated against, present alongside
   * `couchbaseClusterUuid` for `cloud`-deployer clusters. Lets teardown check
   * whether cbcollect is supported for this environment before attempting it.
   */
  capellaEnvironment?: string;
  /**
   * True when this run's `cbdinocluster init` created the ephemeral Capella API
   * key pool on the box. Teardown removes it, whatever became of the cluster.
   */
  capellaKeyPool?: boolean;
}

const FAILED = (extra: Partial<SetupDeclarativeClusterResult> = {}): SetupDeclarativeClusterResult => ({
  allocated: false,
  artifacts: [],
  details: [],
  ...extra,
});

/**
 * Turn a cbdinocluster connection string into a {@link SelectedCluster}, using
 * the default self-managed credentials (what a freshly allocated cluster uses).
 * Returns undefined and explains if the connection string isn't one we can use.
 */
export function buildSelectedClusterFromConnstr(connectionString: string): SelectedCluster | undefined {
  const classification = classifyConnectionString(connectionString);
  if (classification.kind !== "supported") {
    console.error(
      `✗ setup-cluster: cbdinocluster returned ${connectionString}, which fit-cli can't use ` +
        `(${classification.kind}).`,
    );
    return undefined;
  }
  const isCapella = classification.flavour === "internal-capella" || classification.flavour === "production-capella";
  return {
    scheme: classification.scheme,
    defaultHostname: classification.defaultHostname,
    flavour: classification.flavour,
    credentials: isCapella ? { ...CAPELLA_DEFAULT_CREDENTIALS } : { ...DEFAULT_CREDENTIALS },
    // A cbdino couchbases:// cluster uses a self-signed cert; trust it insecurely.
    tls: classification.scheme === "couchbases" ? { insecure: true } : null,
  };
}

/**
 * Pull a cluster id's connection string out of cbdinocluster. For CNG we ask for
 * the performer's couchbase2 string with `--couchbase2`; otherwise we take the
 * classic one. Returns null (after explaining) if there isn't a usable string.
 */
async function connstrFor(
  cbdinocluster: string,
  id: string,
  execution: ClusterCommandExecutor,
  couchbase2: boolean,
): Promise<string | null> {
  const args = couchbase2 ? ["connstr", "--couchbase2", id] : ["connstr", id];
  let connectionString: string | null;
  try {
    connectionString = parseConnstr(await execution.capture(cbdinocluster, args));
  } catch (err) {
    console.error(`✗ setup-cluster: couldn't get the connection string for ${id}: ${(err as Error).message}`);
    return null;
  }
  if (!connectionString) {
    console.error(`✗ setup-cluster: cbdinocluster didn't return a connection string for ${id}.`);
    return null;
  }
  return connectionString;
}

/**
 * Resolve a cluster id's connection string into a {@link SelectedCluster}. For a
 * CNG cluster the classic string drives the test-driver (admin) while a second
 * `--couchbase2` string drives the performer, so both are fetched and combined.
 *
 * For CAO/OpenShift CNG clusters `cbdinocluster connstr` does not return
 * endpoints; we use the `caoHosts` parsed from the allocate output instead.
 */
/**
 * Fetch the nginx load-balancer host for a load-balanced Enterprise Analytics
 * cluster via `cbdinocluster mgmt <id>` (e.g. "http://172.18.0.3:8091" →
 * "172.18.0.3"). The Analytics SDK performer must reach the cluster through this
 * single host; the driver's multi-seed node list isn't a valid HTTP/SDK host.
 * Returns undefined if it can't be read.
 */
async function analyticsLoadBalancerHostFor(
  cbdinocluster: string,
  id: string,
  execution: ClusterCommandExecutor,
): Promise<string | undefined> {
  try {
    const mgmtUrl = await execution.capture(cbdinocluster, ["mgmt", id], undefined, {
      display: "cbdinocluster mgmt (get Analytics load-balancer host)",
    });
    const host = mgmtUrl.trim().replace(/^https?:\/\//, "").replace(/:\d+$/, "");
    return host || undefined;
  } catch {
    return undefined;
  }
}

async function selectedClusterFor(
  cbdinocluster: string,
  id: string,
  execution: ClusterCommandExecutor,
  cng = false,
  caoHosts?: { uiHost: string; cngHost: string },
  loadBalanced = false,
  privateEndpoint = false,
  privateConnectionString?: string,
): Promise<SelectedCluster | undefined> {
  // CAO/OpenShift clusters: build connstrs from the parsed route hostnames
  // instead of calling `cbdinocluster connstr` (which returns "no endpoint available").
  if (cng && caoHosts) {
    // OpenShift TLS-passthrough routes expose external port 443 (not the native Couchbase
    // management port 18091).  Include :443 so the SDK bootstraps on the correct port.
    const managementConnstr = `couchbases://${caoHosts.uiHost}:443`;
    // cngHost comes from `cbdinocluster connstr --couchbase2` with port already included.
    const performerConnectionString = `couchbase2://${caoHosts.cngHost}`;
    console.log(`→ setup-cluster: CNG cluster ${id} management at ${managementConnstr}`);
    console.log(`→ setup-cluster: CNG performer connects over ${performerConnectionString}`);
    const cluster = buildSelectedClusterFromConnstr(managementConnstr);
    if (!cluster) {
      return undefined;
    }
    return { ...cluster, cng: { performerConnectionString, tls: { insecure: true } } };
  }

  // Private endpoint mode: connect over the PrivateLink connection string instead of
  // the cluster's normal (public) one. If PE was requested but setup didn't produce a
  // connection string, fail outright rather than silently falling back to the public
  // endpoint — a silent fallback would make the run "pass" without testing PE at all.
  if (privateEndpoint && !privateConnectionString) {
    console.error(`✗ setup-cluster: private endpoint was requested for cluster ${id} but setup didn't succeed; refusing to fall back to the public connection.`);
    return undefined;
  }
  const connectionString = privateConnectionString ?? (await connstrFor(cbdinocluster, id, execution, false));
  if (!connectionString) {
    return undefined;
  }
  console.log(`→ setup-cluster: cluster ${id} is at ${connectionString}`);
  const builtCluster = buildSelectedClusterFromConnstr(connectionString);
  if (!builtCluster) {
    return undefined;
  }
  // Tag PrivateLink connections so build-fit-configuration knows not to rely on
  // Capella's public-DNS SRV record (the private DNS hostname has no SRV record).
  const cluster = connectionString === privateConnectionString ? { ...builtCluster, privateEndpoint: true } : builtCluster;
  if (!cng) {
    // A load-balanced Enterprise Analytics cluster: the Analytics SDK performer
    // connects through the nginx load balancer (a single host), not the driver's
    // multi-seed node list. Capture that host so build-fit-configuration can point
    // the performer at it.
    if (loadBalanced) {
      const lbHost = await analyticsLoadBalancerHostFor(cbdinocluster, id, execution);
      if (lbHost) {
        console.log(`→ setup-cluster: Analytics performer connects via load balancer ${lbHost}`);
        return { ...cluster, analyticsLoadBalancerHost: lbHost };
      }
      console.error(
        `⚠ setup-cluster: couldn't determine the Analytics load-balancer host for ${id}; ` +
          `the performer will fall back to the node list and likely fail to connect.`,
      );
    }
    return cluster;
  }

  const performerConnectionString = await connstrFor(cbdinocluster, id, execution, true);
  if (!performerConnectionString) {
    console.error(`✗ setup-cluster: CNG cluster ${id} has no couchbase2 connection string for the performer.`);
    return undefined;
  }
  console.log(`→ setup-cluster: CNG performer connects over ${performerConnectionString}`);
  return {
    ...cluster,
    cng: { performerConnectionString, tls: { insecure: true } },
  };
}

/** Build the `cbdinocluster rm <id>` args. */
export function removeClusterArgs(id: string): string[] {
  return ["remove", id];
}

/** Remove a cbdinocluster cluster, streaming progress. Resolves whether it worked. */
export async function removeCluster(
  cbdinocluster: string,
  id: string,
  execution: ClusterCommandExecutor,
): Promise<boolean> {
  console.log(`\nRemoving cluster ${id}...`);
  try {
    await execution.run(cbdinocluster, removeClusterArgs(id));
    console.log(`\n✓ Removed cluster ${id}`);
    return true;
  } catch (err) {
    console.error(`\n✗ Failed to remove cluster ${id}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Delete the Capella API key pool this run created on the box. The command reads
 * the pool name from the box's own `~/.cbdinocluster`, so nothing has to be passed
 * to it. cbdinocluster only deletes keys carrying that pool's prefix, and never
 * the primary key, so this cannot disturb another run or the shared credentials.
 *
 * Best effort like {@link removeCluster}. A failure never fails teardown,
 * because the keys carry an expiry that catches whatever is left behind.
 */
export async function removeCapellaApiKeyPool(
  cbdinocluster: string,
  execution: ClusterCommandExecutor,
): Promise<boolean> {
  console.log(`\nRemoving this run's Capella API key pool...`);
  try {
    await execution.run(cbdinocluster, ["cloud", "apikeys", "remove"]);
    console.log(`\n✓ Removed this run's Capella API key pool`);
    return true;
  } catch (err) {
    fitCliWarn(`\n⚠ Failed to remove this run's Capella API key pool: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Create the default bucket on a CAO/OpenShift CNG cluster via the management REST API.
 *
 * CAO clusters use `buckets.managed: false` so no bucket is auto-created, and there is no
 * external KV port for the test-driver's classic SDK to use.  Retries for up to 120 s to
 * survive the "Cannot create bucket during rebalance" window after the cluster first comes up.
 */
async function createCaoDefaultBucket(
  uiHost: string,
  username: string,
  password: string,
  execution: ClusterCommandExecutor,
): Promise<void> {
  await createDefaultBucketAt(`https://${uiHost}:443/pools/default/buckets`, username, password, execution);
}

async function createDefaultBucketAt(
  bucketUrl: string,
  username: string,
  password: string,
  execution: ClusterCommandExecutor,
): Promise<void> {
  console.log(`→ setup-cluster: creating default bucket via ${bucketUrl}`);
  const createScript = [
    "set -e",
    "deadline=$(($(date +%s) + 120))",
    "while true; do",
    "  tmpout=$(mktemp)",
    // ramQuota=100 matches the GHA workflow — small enough to leave headroom for test buckets.
    `  status=$(curl --silent --show-error --insecure -w '%{http_code}' -o "$tmpout" -X POST '${bucketUrl}' -u '${username}:${password}' -d name=default -d bucketType=couchbase -d ramQuota=100 2>&1 || echo 000)`,
    "  body=$(cat \"$tmpout\"); rm -f \"$tmpout\"",
    '  if [ "$status" = "202" ]; then echo "  ✓ Default bucket created (HTTP $status)"; exit 0; fi',
    '  if [ "$status" = "400" ] && echo "$body" | grep -q "already exists"; then echo "  ✓ Default bucket already exists"; exit 0; fi',
    '  if [ $(date +%s) -ge $deadline ]; then echo "  ✗ Timed out creating default bucket (HTTP $status): $body" >&2; exit 1; fi',
    '  echo "  Management API not ready yet (HTTP $status, fit-cli is waiting not hung): $body"',
    "  sleep 5",
    "done",
  ].join("\n");
  try {
    await execution.run("sh", ["-lc", createScript], undefined, { display: "create default bucket" });
  } catch (err) {
    console.error(`  ✗ Failed to create default bucket: ${(err as Error).message}`);
  }
}

/**
 * Add the execution host's public IP to a Capella cloud cluster's allow list so
 * the SDK performer can reach the cluster. Both Capella Server and Capella
 * Analytics clusters start with an empty allow list — without this step every
 * connection times out.
 *
 * Discovers the public IP via the AWS IMDS (fast, works on EC2 without extra
 * network egress) and falls back to ifconfig.me. Logs a warning and continues
 * rather than failing if the IP can't be determined or the add fails, because the
 * run will surface a clearer "connection timed out" error than a hard failure here.
 */
async function allowHostIpOnCapellaCluster(
  cbdinocluster: string,
  clusterId: string,
  execution: ClusterCommandExecutor,
): Promise<void> {
  let publicIp: string | undefined;
  for (const url of ["http://169.254.169.254/latest/meta-data/public-ipv4", "https://ifconfig.me"]) {
    try {
      const out = (await execution.capture("curl", ["-sf", "--max-time", "3", url], undefined, { quiet: true })).trim();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(out)) {
        publicIp = out;
        break;
      }
    } catch {
      // Try next URL
    }
  }
  if (!publicIp) {
    console.warn(
      `\n⚠ setup-cluster: couldn't determine public IP — skipping Capella allow-list update.\n` +
        `  If the performer can't connect, add your IP manually:\n` +
        `  cbdinocluster allow-list add ${clusterId} <your-ip>/32`,
    );
    return;
  }
  const cidr = `${publicIp}/32`;
  console.log(`\n→ setup-cluster: adding ${cidr} to Capella cluster allow list…`);
  try {
    await execution.run(cbdinocluster, ["allow-list", "add", clusterId, cidr]);
    console.log(`  ✓ ${cidr} added to allow list.`);
  } catch (err) {
    console.warn(`\n⚠ setup-cluster: failed to add ${cidr} to allow list: ${(err as Error).message}`);
  }
}

/**
 * `cbdinocluster cloud get-cloud-id <id>` prints the Couchbase cluster's own UUID
 * via Go's plain `log.Printf` — which, unlike cbdinocluster's other machine-readable
 * output (allocate/connstr, printed via fmt so it lands on stdout), goes to the
 * default logger's stderr and is timestamp-prefixed
 * (e.g. "2026/06/29 12:00:00 8fb3a708-1234-4567-89ab-cdef01234567"). We merge
 * stderr into the captured stream via a shell redirect and pull the trailing UUID
 * off the last non-empty line.
 */
const COUCHBASE_CLUSTER_UUID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/i;

function parseCouchbaseClusterUuid(output: string): string | null {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = COUCHBASE_CLUSTER_UUID_PATTERN.exec(lines[i]);
    if (match) return match[1];
  }
  return null;
}

/**
 * The Couchbase cluster's own UUID for a cbdinocluster-tracked cluster. This is
 * *not* the same id used for `connstr`/`remove`/etc — cbdinocluster tracks its
 * own `ClusterID` internally, separate from Capella's own `CloudClusterID`. The
 * VPC endpoint `setup-link` creates is tagged with the latter (see
 * CreateVPCEndpoint in cbdinocluster's awscontrol package), so cleanup needs this
 * id, not the cbdinocluster one.
 */
async function couchbaseClusterUuidFor(
  cbdinocluster: string,
  id: string,
  execution: ClusterCommandExecutor,
): Promise<string | undefined> {
  try {
    const output = await execution.capture(
      "sh",
      ["-lc", `${posixQuote(cbdinocluster)} cloud get-cloud-id ${posixQuote(id)} 2>&1`],
      undefined,
      { display: "cbdinocluster cloud get-cloud-id" },
    );
    return parseCouchbaseClusterUuid(output) ?? undefined;
  } catch (err) {
    console.error(`✗ setup-cluster: couldn't resolve the Couchbase cluster UUID for ${id}: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Fetch a Capella cluster's already-configured PrivateLink connection string.
 * Split out from {@link setupPrivateEndpoint} so a reused (`useExisting`)
 * cluster can re-fetch it without redoing `enable`/`setup-link` — the VPC
 * endpoint created for the fit-cli VPC is reachable from any instance in that
 * VPC, not just the one that created it, so it only needs to be created once.
 */
async function fetchPrivateEndpointConnstr(
  cbdinocluster: string,
  id: string,
  execution: ClusterCommandExecutor,
): Promise<string | undefined> {
  try {
    console.log(`→ setup-cluster: waiting for the private endpoint's DNS to become visible`);
    const output = await execution.capture(
      cbdinocluster,
      ["private-endpoints", "connstr", id, "--wait-visible"],
      undefined,
      { display: "cbdinocluster private-endpoints connstr --wait-visible" },
    );
    const connectionString = parseConnstr(output);
    if (!connectionString) {
      console.error(`✗ setup-cluster: private-endpoints connstr didn't return a connection string for ${id}.`);
      return undefined;
    }
    console.log(`→ setup-cluster: private endpoint ready — cluster ${id} reachable at ${connectionString}`);
    return connectionString;
  } catch (err) {
    console.error(`✗ setup-cluster: couldn't fetch the private endpoint connection string for ${id}: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Create the default FIT database user on a newly-allocated Capella cloud
 * cluster (Capella Server or Capella Analytics). cbdinocluster's cloud deployer
 * doesn't auto-create one the way the docker deployer does — without this,
 * connections fail with "Unauthorized user" (code 20000).
 *
 * Uses {@link CAPELLA_DEFAULT_CREDENTIALS}, matching what `buildSelectedClusterFromConnstr`
 * assigns for a Capella-flavoured connection string, so no further plumbing is needed.
 */
async function createCloudDeployerUser(
  cbdinocluster: string,
  clusterId: string,
  execution: ClusterCommandExecutor,
): Promise<void> {
  const { username, password } = CAPELLA_DEFAULT_CREDENTIALS;
  console.log(`\n→ setup-cluster: creating SDK user ${username} for Capella cluster ${clusterId}…`);
  try {
    await execution.run(
      cbdinocluster,
      ["users", "add", clusterId, username, `--password=${password}`, "--can-read", "--can-write"],
      undefined,
      { display: `cbdinocluster users add ${username}` },
    );
    console.log(`  ✓ Database user "${username}" ready.`);
  } catch (err) {
    console.warn(`\n⚠ setup-cluster: failed to create database user "${username}": ${(err as Error).message}`);
  }
}

/**
 * Create the "default" bucket FIT tests expect on a newly-allocated Capella
 * Server cluster. Capella doesn't auto-create one, and skipBucketCreation=true
 * in FITConfiguration means the test-driver won't either. Not needed for Capella
 * Analytics, which has no KV service to hold a bucket.
 *
 * flush-enabled is set so ObservabilityTest.bucketFlush (and any other test that
 * flushes the default bucket) can run — Capella buckets default to flush disabled.
 */
async function createCapellaDefaultBucket(
  cbdinocluster: string,
  clusterId: string,
  execution: ClusterCommandExecutor,
): Promise<void> {
  console.log(`\n→ setup-cluster: creating default bucket on Capella cluster ${clusterId}…`);
  try {
    await execution.run(
      cbdinocluster,
      ["buckets", "add", clusterId, "default", "--ram-quota-mb=100", "--flush-enabled"],
      undefined,
      { display: "cbdinocluster buckets add default" },
    );
  } catch (err) {
    console.warn(`\n⚠ setup-cluster: failed to create default bucket for Capella cluster — tests will fail: ${(err as Error).message}`);
  }
}

/**
 * Set up a private endpoint connection (AWS PrivateLink or GCP PSC) to a Capella
 * cluster via cbdinocluster's `private-endpoints` commands — CSP-agnostic:
 * `setup-link --auto` auto-identifies both the instance and its cloud from
 * where it's run. Returns the private `couchbases://` connection string to
 * connect over, plus the Couchbase cluster's own UUID (needed later to delete
 * the AWS-side VPC endpoint on teardown — see {@link couchbaseClusterUuidFor}).
 * `knownUuid` is passed in when the caller already has it (from `allocate`'s own
 * output — see allocate-cluster.ts) so we skip the extra `cloud get-cloud-id`
 * round-trip; otherwise it's fetched here as a fallback.
 * Best-effort: on failure, explains and returns an empty result so the caller
 * falls back to the cluster's normal (public) connection string.
 */
async function setupPrivateEndpoint(
  cbdinocluster: string,
  id: string,
  execution: ClusterCommandExecutor,
  knownUuid?: string,
): Promise<{ connectionString?: string; couchbaseClusterUuid?: string }> {
  try {
    console.log(`→ setup-cluster: enabling private endpoints on Capella cluster ${id}`);
    await execution.run(cbdinocluster, ["private-endpoints", "enable", id], undefined, {
      display: "cbdinocluster private-endpoints enable",
    });
    const couchbaseClusterUuid = knownUuid ?? (await couchbaseClusterUuidFor(cbdinocluster, id, execution));
    console.log(`→ setup-cluster: setting up the PrivateLink connection to ${id} (auto-identifying this instance)`);
    await execution.run(cbdinocluster, ["private-endpoints", "setup-link", id, "--auto"], undefined, {
      display: "cbdinocluster private-endpoints setup-link --auto",
    });
    const connectionString = await fetchPrivateEndpointConnstr(cbdinocluster, id, execution);
    return { ...(connectionString ? { connectionString } : {}), ...(couchbaseClusterUuid ? { couchbaseClusterUuid } : {}) };
  } catch (err) {
    console.error(`✗ setup-cluster: failed to set up the private endpoint for ${id}: ${(err as Error).message}`);
    return {};
  }
}

/** Allocate a fresh cluster from the resolved plan and resolve it for the run. */
async function allocate(
  cbdinocluster: string,
  config: CbdinoclusterDef,
  deployer: string | undefined,
  execution: ClusterCommandExecutor,
  cycleDir: string,
  cng: boolean,
  loadBalanced: boolean,
  privateEndpoint = false,
  capellaEnvironment?: string,
): Promise<SetupDeclarativeClusterResult> {
  const resolvedConfig = {
    ...config,
    nodes: await Promise.all(
      config.nodes.map(async (node) => ({
        ...node,
        version: node.version !== undefined && isAlias(node.version) ? await resolveAlias(node.version) : node.version,
      })),
    ),
  };

  let allocated;
  try {
    allocated = await allocateCluster(
      cbdinocluster,
      YAML.stringify(resolvedConfig),
      deployer,
      execution,
      cycleDir,
      cng,
      capellaEnvironment,
    );
    console.log("\n✓ setup-cluster: cbdinocluster allocated the cluster");
  } catch (err) {
    console.error(`\n✗ setup-cluster: cbdinocluster failed to allocate the cluster: ${(err as Error).message}`);
    return FAILED({ cbdinocluster });
  }

  // Capella cloud clusters (Capella Server or Capella Analytics) start with an
  // empty allow list and no database user — cbdinocluster's cloud deployer
  // doesn't auto-create either the way the docker deployer does. Without the
  // allow-list entry connections time out; without the user they fail with
  // "Unauthorized user".
  if (deployer === "cloud") {
    await allowHostIpOnCapellaCluster(cbdinocluster, allocated.clusterId, execution);
    await createCloudDeployerUser(cbdinocluster, allocated.clusterId, execution);
    // Capella Analytics has no KV service, so there's no bucket to create — and
    // no bucket to expect, since skipBucketCreation only matters for KV-backed tests.
    if (!config.columnar) {
      await createCapellaDefaultBucket(cbdinocluster, allocated.clusterId, execution);
    }
  }

  // cao (CNG) clusters need their ingresses enabled before the data/REST planes —
  // and so the performer's couchbase2 connection string — become reachable.
  if (cng) {
    await enableIngresses(cbdinocluster, allocated.clusterId, execution);
  }

  const privateEndpointResult =
    deployer === "cloud" && privateEndpoint
      ? await setupPrivateEndpoint(cbdinocluster, allocated.clusterId, execution, allocated.couchbaseClusterUuid)
      : undefined;
  // Prefer the UUID `allocate` already logged (no extra round-trip); only cloud
  // clusters have one at all, and setupPrivateEndpoint falls back to fetching it
  // itself if allocate's own output didn't have it.
  const couchbaseClusterUuid = allocated.couchbaseClusterUuid ?? privateEndpointResult?.couchbaseClusterUuid;

  let cluster = await selectedClusterFor(
    cbdinocluster,
    allocated.clusterId,
    execution,
    cng,
    allocated.caoHosts,
    loadBalanced,
    deployer === "cloud" && privateEndpoint,
    privateEndpointResult?.connectionString,
  );

  if (cng && allocated.caoHosts) {
    const { username, password } = cluster?.credentials ?? { username: "Administrator", password: "password" };
    await createCaoDefaultBucket(allocated.caoHosts.uiHost, username, password, execution);
  }

  // Capella Analytics clusters don't expose the Couchbase Server management REST
  // API — mark the cluster so runClusterDiag skips it. Credentials are already
  // set correctly by buildSelectedClusterFromConnstr (Capella-flavoured hostname).
  if (cluster && deployer === "cloud" && config.columnar) {
    cluster = { ...cluster, capellaAnalytics: true };
  }

  // Private endpoint setup failed on a cluster we just allocated: don't leave a paid
  // Capella cluster (and possibly a paid VPC endpoint) orphaned — mirrors fit-instance.ts's
  // "don't leave a paid box lying around if bring-up failed" discipline.
  if (!cluster && deployer === "cloud" && privateEndpoint) {
    console.error(`✗ setup-cluster: private endpoint setup failed — removing the newly-allocated cluster ${allocated.clusterId} to avoid leaking it.`);
    await removeCluster(cbdinocluster, allocated.clusterId, execution);
    if (couchbaseClusterUuid) {
      await deleteVpcEndpointsForCluster(couchbaseClusterUuid).catch((err: unknown) => {
        fitCliWarn(`⚠ Failed to delete the private endpoint's VPC endpoint for cluster ${couchbaseClusterUuid}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return FAILED({ cbdinocluster });
  }

  return {
    ...(cluster ? { cluster } : {}),
    allocated: true,
    clusterId: allocated.clusterId,
    cbdinocluster,
    ...(couchbaseClusterUuid ? { couchbaseClusterUuid } : {}),
    ...(deployer === "cloud" && capellaEnvironment ? { capellaEnvironment } : {}),
    // Only true when PE was actually set up this run — gates whether teardown should
    // also attempt to delete a VPC endpoint. `couchbaseClusterUuid` alone isn't enough:
    // it's now populated for every cloud cluster, not just PE ones.
    ...(privateEndpointResult?.connectionString ? { privateEndpointEnabled: true } : {}),
    artifacts: allocated.artifacts,
    details: allocated.details,
  };
}

/**
 * Stand up (or reuse) the cluster described by a resolved cbdinocluster plan.
 * Finds cbdinocluster on the PATH, lists what's already running, applies the
 * policy, and allocates as needed. Failures are explained and surfaced as a
 * result with `cluster: undefined` rather than thrown.
 */
export async function setupDeclarativeCluster(plan: {
  init?: CbdinoclusterInitSetup;
  config: CbdinoclusterDef;
  onClusterExists: ClusterExistsPolicy;
  deployer?: string;
  /** CNG cluster: also fetch the couchbase2 connstr so the performer can connect. */
  cng?: boolean;
  /**
   * True when the Kubernetes cluster is shared (e.g. OpenShift/ROSA): CRDs and the
   * admission controller are already installed cluster-wide, so we must not delete and
   * reinstall them — doing so would break other users' clusters running in other namespaces.
   */
  cngSharedCluster?: boolean;
  /** GitHub credentials to inject into the uploaded ~/.cbdinocluster (for GHCR image pulls). */
  githubCredentials?: { user: string; token: string };
  /** Where to get the cbdinocluster binary. Absent means latest release. */
  source?: CbdinoclusterSource;
  /** Present when this is a Capella cloud cluster; `privateEndpoint` triggers PrivateLink setup after allocation. */
  capella?: CapellaClusterSetup;
  /**
   * The Capella environment (a key under `capella` in environments.json5) this cluster's
   * credentials were actually uploaded under — used only to build the debug links printed
   * alongside the Couchbase cluster UUID (see capella-debug-links.ts). Callers should pass
   * whatever value they resolved for uploading Capella credentials, not just `capella.environment`,
   * since some cluster types (e.g. Capella Analytics) key credential upload off a different field.
   * Defaults to {@link DEFAULT_CAPELLA_ENV} so standalone/manual callers still get a best-effort link.
   */
  capellaEnvironment?: string;
}, execution: ClusterCommandExecutor = localClusterCommandExecutor(), cycleDir: string = ensureRunDir()): Promise<SetupDeclarativeClusterResult> {
  const cng = plan.cng ?? false;
  // A self-managed Enterprise Analytics cluster is fronted by an nginx load
  // balancer (docker `passive-load-balancer`); its Analytics SDK performer must
  // connect through that single LB host, not the driver's multi-seed node list.
  const loadBalanced = plan.config.docker?.["passive-load-balancer"] === true;
  const cbdinocluster = await resolveCbdinoclusterCommand(execution, plan.source);
  if (!cbdinocluster) {
    console.error(
      `\n✗ setup-cluster: cbdinocluster isn't on the PATH for ${execution.description}. ` +
        `Get it from ${CBDINOCLUSTER_URL}.`,
    );
    return FAILED();
  }

  // CNG uploads a config object verbatim. For the docker path, run cbdinocluster init
  // with explicit args from the definition if present, or generate the standard
  // functional defaults. An empty init block ({}) means "run default init".
  let capellaKeyPool = false;
  if (plan.init?.config !== undefined) {
    await prepareCbdinoclusterConfig(execution, plan.init.config, plan.githubCredentials, cycleDir);
  } else if (plan.init !== undefined) {
    const args = plan.init.args ?? defaultCbdinoclusterInitArgs();
    ({ capellaKeyPool } = await runCbdinoclusterInit(execution, cbdinocluster, args, plan.githubCredentials, plan.init.configPatch, cycleDir));
  }
  // Carried onto whichever result this call ends up returning, so teardown removes
  // the pool even when the cluster itself never came up.
  const poolResult = capellaKeyPool ? { capellaKeyPool: true } : {};

  // CNG on a clean k3d box: install the Couchbase CRDs + admission controller the cao
  // deployer needs — the steps cbdinocluster's interactive `init` would prompt for
  // and which the non-interactive allocate would otherwise fail on. On localhost
  // we leave the operator's own ~/.cbdinocluster (and its cluster) alone.
  // On a shared cluster (OpenShift/ROSA) the CRDs are already installed cluster-wide;
  // deleting and reinstalling them would break other users' clusters in other namespaces.
  if (cng && isRemoteExecution(execution) && !plan.cngSharedCluster) {
    await installCaoCrdsAndAdmission(execution, cbdinocluster);
  }

  // `cbdinocluster ps` doubles as a sanity check and the list of what's running.
  const existing = await listExistingClusters(cbdinocluster, execution);
  if (!existing) {
    return FAILED({ cbdinocluster, ...poolResult });
  }

  const decision = decideClusterExists(existing, plan.onClusterExists);

  if (decision.action === "abort") {
    console.error(`\n✗ setup-cluster: ${decision.reason}`);
    return FAILED({ cbdinocluster, ...poolResult });
  }

  if (decision.action === "useExisting") {
    console.log(
      `→ setup-cluster: onClusterExists is "useExisting" — trusting the running cluster ` +
        `${decision.cluster.id} [${decision.cluster.details}].`,
    );
    const reusedPrivateEndpoint = plan.deployer === "cloud" && plan.capella?.privateEndpoint !== undefined;
    // The VPC endpoint (once created) is reachable from any instance in the fit-cli VPC,
    // so a reused cluster just needs its already-configured private connstr re-fetched —
    // no need to redo enable/setup-link.
    const privateConnectionString = reusedPrivateEndpoint
      ? await fetchPrivateEndpointConnstr(cbdinocluster, decision.cluster.id, execution)
      : undefined;
    // Cloud (Capella) clusters always have a Couchbase cluster UUID; log it here too for
    // consistency with a fresh allocation, even though reuse never tears the cluster down
    // (so there's nothing here that needs to persist it for teardown).
    if (plan.deployer === "cloud") {
      const couchbaseClusterUuid = await couchbaseClusterUuidFor(cbdinocluster, decision.cluster.id, execution);
      console.log(
        couchbaseClusterUuid
          ? `  Couchbase cluster UUID: ${couchbaseClusterUuid}`
          : `  ⚠ couldn't resolve a Couchbase cluster UUID for the reused cloud cluster ${decision.cluster.id}.`,
      );
      if (couchbaseClusterUuid) {
        printCapellaDebugLinks(plan.capellaEnvironment ?? DEFAULT_CAPELLA_ENV, couchbaseClusterUuid);
      }
    }
    let cluster = await selectedClusterFor(
      cbdinocluster,
      decision.cluster.id,
      execution,
      cng,
      undefined,
      loadBalanced,
      reusedPrivateEndpoint,
      privateConnectionString,
    );
    if (cluster && plan.deployer === "cloud" && plan.config?.columnar) {
      cluster = { ...cluster, capellaAnalytics: true };
    }
    return {
      ...(cluster ? { cluster } : {}),
      allocated: false,
      cbdinocluster,
      ...poolResult,
      artifacts: [],
      details: [],
    };
  }

  if (decision.action === "recreate") {
    console.log(
      `→ setup-cluster: onClusterExists is "destroyAndRecreate" — removing ` +
        `${decision.remove.length} existing cluster(s) before allocating.`,
    );
    for (const cluster of decision.remove) {
      await removeCluster(cbdinocluster, cluster.id, execution);
    }
  }

  // Pull the server image before handing off to cbdinocluster — image pull failures are
  // a common cause of long, opaque cbdinocluster timeouts, so surfacing them early helps.
  if (cng && isRemoteExecution(execution)) {
    const serverVersion = plan.config.nodes[0]?.version;
    if (serverVersion) {
      if (plan.githubCredentials) {
        await loginToGhcr(execution, plan.githubCredentials, cycleDir);
      }
      const imageRef = cngServerImageRef(serverVersion);
      console.log(`→ setup-cluster: pre-flight docker pull ${imageRef}…`);
      try {
        await execution.run("docker", ["pull", imageRef]);
      } catch {
        throwFatalToCluster(`docker pull ${imageRef} failed`);
      }
    }
  }

  const effectiveDeployer = plan.deployer ?? (cng ? "cao" : "docker");
  if (effectiveDeployer === "docker") {
    warnIfDockerNotEnabled(execution);
  }
  const allocated = await allocate(
    cbdinocluster,
    plan.config,
    effectiveDeployer,
    execution,
    cycleDir,
    cng,
    loadBalanced,
    plan.capella?.privateEndpoint !== undefined,
    effectiveDeployer === "cloud" ? (plan.capellaEnvironment ?? DEFAULT_CAPELLA_ENV) : undefined,
  );
  return { ...allocated, ...poolResult };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const result = await setupDeclarativeCluster({
      config: { nodes: [{ count: 1, version: loadEnvironments().defaults.clusterVersion, services: ["kv", "n1ql", "index"] }] },
      onClusterExists: "destroyAndRecreate",
    });
    console.log(JSON.stringify({ ...result, artifacts: result.artifacts.length }, null, 2));
    if (result.allocated && result.clusterId && result.cbdinocluster) {
      console.log("\n(standalone run) removing the cluster it just allocated…");
      await removeCluster(result.cbdinocluster, result.clusterId, localClusterCommandExecutor());
    }
    process.exit(result.cluster ? 0 : 1);
  });
}
