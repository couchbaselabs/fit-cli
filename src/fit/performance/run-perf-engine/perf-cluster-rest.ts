/**
 * The cluster-side work a perf run does before it measures anything: wait for the cluster,
 * recreate its bucket, and force a compaction.
 *
 * Doing this through the Couchbase SDK would mean taking on the Node SDK — a native addon —
 * for four management calls, so it goes over the cluster's REST API instead, the way the rest
 * of fit-cli talks to a cluster (see
 * `cluster-diag.ts` and `setup-declarative-cluster.ts`). The driver never needs KV access of
 * its own: documents are created through the performer, which is a full SDK client already.
 */
import { capture, type RunOptions } from "../../../util/non-fit/proc.js";

/** How the driver reaches the cluster's management API. */
export interface PerfClusterRest {
  /** Scheme, host and port, e.g. `http://127.0.0.1:8091`. */
  restHost: string;
  username: string;
  password: string;
  /** Injectable so this can run on a remote execution target, and be tested. */
  capture?: (command: string, args: string[], cwd?: string, opts?: RunOptions) => Promise<string>;
}

export interface PerfBucketSettings {
  name: string;
  ramQuotaMb: number;
  replicas: number;
  /** `couchstore` or `magma`; anything else is treated as couchstore. */
  storage: string;
}

/** How long to keep retrying a bucket create. */
const BUCKET_CREATE_TIMEOUT_MS = 300_000;
const BUCKET_DROP_TIMEOUT_MS = 300_000;
/** Couchbase reports a created bucket before it is fully warmed; let it settle. */
const BUCKET_SETTLE_MS = 5_000;

/** One curl invocation's outcome: the body, and the HTTP status it came with. */
export interface RestResponse {
  status: number;
  body: string;
}

/**
 * Build the curl args for one management call.
 *
 * `-k` throughout: perf clusters are frequently self-signed, and the driver is talking to a
 * cluster it just created. Exported for tests, which is the only practical way to check the
 * request shape without a live cluster.
 */
export function curlArgs(rest: PerfClusterRest, method: string, path: string, form: Record<string, string | number> = {}): string[] {
  const args = [
    "--silent",
    "--show-error",
    "--insecure",
    "--connect-timeout",
    "10",
    // Body, then a final line holding the status, so both can be read from stdout alone.
    "-w",
    "\n%{http_code}",
    "-u",
    `${rest.username}:${rest.password}`,
    "-X",
    method,
    `${rest.restHost}${path}`,
  ];
  for (const [key, value] of Object.entries(form)) {
    args.push("-d", `${key}=${String(value)}`);
  }
  return args;
}

/** Split curl's `body\nstatus` output. */
export function parseRestResponse(stdout: string): RestResponse {
  const newline = stdout.lastIndexOf("\n");
  if (newline === -1) {
    return { status: Number.parseInt(stdout.trim(), 10) || 0, body: "" };
  }
  return { status: Number.parseInt(stdout.slice(newline + 1).trim(), 10) || 0, body: stdout.slice(0, newline) };
}

async function request(rest: PerfClusterRest, method: string, path: string, form?: Record<string, string | number>): Promise<RestResponse> {
  const run = rest.capture ?? capture;
  try {
    return parseRestResponse(await run("curl", curlArgs(rest, method, path, form), undefined, { quiet: true }));
  } catch (err) {
    // curl exiting non-zero means it couldn't complete the request at all (connection
    // refused, DNS, timeout) — not an HTTP error. Report it as status 0.
    return { status: 0, body: (err as Error).message };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The redacted form of a call, for the command echo. */
function describe(rest: PerfClusterRest, method: string, path: string): string {
  return `curl -k -u ${rest.username}:<password> -X ${method} ${rest.restHost}${path}`;
}

/**
 * Wait until the cluster answers and reports healthy nodes.
 *
 * Perf clusters are often allocated moments beforehand.
 */
export async function waitForClusterReady(rest: PerfClusterRest, timeoutMs = 120_000): Promise<void> {
  console.log(`Waiting for the cluster to be ready:\n  ${describe(rest, "GET", "/pools/default")}`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await request(rest, "GET", "/pools/default");
    const unhealthy = response.status === 200 ? unhealthyNodes(response.body) : [];
    const problem = response.status !== 200 ? `HTTP ${response.status}` : unhealthy.length > 0 ? `nodes not healthy: ${unhealthy.join(", ")}` : undefined;
    if (problem === undefined) {
      console.log("✓ Cluster is ready");
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Cluster at ${rest.restHost} was not ready within ${Math.round(timeoutMs / 1000)}s (${problem})`);
    }
    await sleep(2_000);
  }
}

/** Node hostnames whose status isn't `healthy`, from a /pools/default body. */
export function unhealthyNodes(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { nodes?: { hostname?: string; status?: string }[] };
    return (parsed.nodes ?? []).filter((node) => node.status !== "healthy").map((node) => node.hostname ?? "?");
  } catch {
    return ["(could not parse /pools/default)"];
  }
}

/**
 * Drop and recreate the workload's bucket.
 *
 * Every perf run starts from an empty bucket with a known quota, replica count and storage
 * backend — those are part of what the datapoint means, not incidental setup. The retries exist
 * because bucket deletion is asynchronous and a create can be rejected for seconds after the
 * delete returned (CBD-5050).
 */
export async function recreateBucket(rest: PerfClusterRest, settings: PerfBucketSettings): Promise<void> {
  const path = `/pools/default/buckets/${settings.name}`;
  console.log(
    `(Re)creating bucket ${settings.name} with ${settings.ramQuotaMb}MB, ${settings.replicas} replica(s), ${storageBackend(settings.storage)}:\n` +
      `  ${describe(rest, "DELETE", path)}\n` +
      `  ${describe(rest, "POST", "/pools/default/buckets")}`,
  );

  const dropDeadline = Date.now() + BUCKET_DROP_TIMEOUT_MS;
  for (;;) {
    const response = await request(rest, "DELETE", path);
    // 404: nothing to drop. 200: dropped.
    if (response.status === 404 || response.status === 200) {
      break;
    }
    if (Date.now() >= dropDeadline) {
      throw new Error(`Could not drop bucket ${settings.name}: HTTP ${response.status} ${response.body}`);
    }
    await sleep(1_000);
  }

  const createDeadline = Date.now() + BUCKET_CREATE_TIMEOUT_MS;
  for (;;) {
    const response = await request(rest, "POST", "/pools/default/buckets", {
      name: settings.name,
      bucketType: "couchbase",
      ramQuota: settings.ramQuotaMb,
      replicaNumber: settings.replicas,
      storageBackend: storageBackend(settings.storage),
    });
    if (response.status === 202 || response.status === 200) {
      break;
    }
    // The bucket's asynchronous deletion may still be in flight, which shows up as the name
    // being taken. Anything else is a real failure worth surfacing immediately.
    const retryable = response.status === 400 && /exist/i.test(response.body);
    if (!retryable || Date.now() >= createDeadline) {
      throw new Error(`Could not create bucket ${settings.name}: HTTP ${response.status} ${response.body}`);
    }
    await sleep(5_000);
  }

  await sleep(BUCKET_SETTLE_MS);
  console.log(`✓ Bucket ${settings.name} recreated`);
}

/** `magma` if asked for by name, `couchstore` otherwise. */
export function storageBackend(storage: string | undefined): string {
  return storage?.toLowerCase() === "magma" ? "magma" : "couchstore";
}

/**
 * Compact the bucket before measuring.
 *
 * CBD-5001: auto-compaction is disabled on perf clusters, so without this the disk grows
 * across runs and later runs measure a differently-shaped bucket than earlier ones.
 */
export async function forceCompaction(rest: PerfClusterRest, bucket: string): Promise<void> {
  const path = `/pools/default/buckets/${bucket}/controller/compactBucket`;
  console.log(`Forcing a compaction:\n  ${describe(rest, "POST", path)}`);
  const response = await request(rest, "POST", path);
  // Non-fatal: log the result and continue.
  console.log(`  Result of forcing compaction: HTTP ${response.status}`);
}

/**
 * The cluster facts a perf run records, as the cluster itself reports them. Every one is part
 * of a datapoint's identity (see perf-identity.ts), so they are read rather than assumed.
 */
export interface MeasuredClusterFacts {
  /** `/pools` `implementationVersion`, e.g. `8.0.0-3777-enterprise`. */
  version?: string;
  /** `/pools/default` `memoryQuota`: the data service quota, in MB. */
  memory?: number;
  /** `/pools/default` first node's `cpuCount`. */
  cpuCount?: number;
  /** `/pools/default` node count. */
  nodeCount?: number;
}

/**
 * Pull the recorded cluster facts out of the `/pools` and `/pools/default` bodies, exactly as
 * jenkins-sdk's `modifyConfigClusters` did for every run in the existing history.
 */
export function clusterFactsFrom(poolsBody: string, poolsDefaultBody: string): MeasuredClusterFacts {
  const pools = JSON.parse(poolsBody) as { implementationVersion?: unknown };
  const poolsDefault = JSON.parse(poolsDefaultBody) as { memoryQuota?: unknown; nodes?: { cpuCount?: unknown }[] };
  const facts: MeasuredClusterFacts = {};
  if (typeof pools.implementationVersion === "string") facts.version = pools.implementationVersion;
  if (typeof poolsDefault.memoryQuota === "number") facts.memory = poolsDefault.memoryQuota;
  const firstNode = poolsDefault.nodes?.[0];
  if (typeof firstNode?.cpuCount === "number") facts.cpuCount = firstNode.cpuCount;
  if (Array.isArray(poolsDefault.nodes)) facts.nodeCount = poolsDefault.nodes.length;
  return facts;
}

/** Read the recorded cluster facts from the cluster. See {@link clusterFactsFrom}. */
export async function measureClusterFacts(rest: PerfClusterRest): Promise<MeasuredClusterFacts> {
  console.log(`Reading the cluster's facts for the run record:\n  ${describe(rest, "GET", "/pools")}\n  ${describe(rest, "GET", "/pools/default")}`);
  const [pools, poolsDefault] = [await request(rest, "GET", "/pools"), await request(rest, "GET", "/pools/default")];
  for (const [path, response] of [["/pools", pools], ["/pools/default", poolsDefault]] as const) {
    if (response.status !== 200) {
      throw new Error(`Could not read ${path} from ${rest.restHost}: HTTP ${response.status} ${response.body}`);
    }
  }
  return clusterFactsFrom(pools.body, poolsDefault.body);
}

/**
 * The TestSuite's cluster block with the measured facts filled in.
 *
 * `version`, `cpuCount` and `nodeCount` are facts about the cluster, so a value the config
 * states must agree with the measured one: recording a value that isn't true of the machine
 * would quietly file the run under someone else's history. `memory` is different — it is
 * also the bucket's RAM quota, so a stated value is a choice (a smaller bucket) and wins, as
 * it did in jenkins-sdk; unstated, the bucket gets the whole data service quota, as the Java
 * driver did.
 */
export function withMeasuredClusterFacts(
  cluster: Record<string, string | number | boolean>,
  measured: MeasuredClusterFacts,
): Record<string, string | number | boolean> {
  const out = { ...cluster };
  const mismatches: string[] = [];
  for (const key of ["version", "cpuCount", "nodeCount"] as const) {
    const value = measured[key];
    if (value === undefined) {
      continue;
    }
    if (out[key] !== undefined && out[key] !== value) {
      mismatches.push(`${key}: the config says ${JSON.stringify(out[key])}, the cluster reports ${JSON.stringify(value)}`);
    }
    out[key] = value;
  }
  if (mismatches.length > 0) {
    throw new Error(
      `The cluster doesn't match the perf config's stated cluster facts, so this run would be recorded against the wrong history:\n  ` +
        mismatches.join("\n  "),
    );
  }
  if (out.memory === undefined && measured.memory !== undefined) {
    out.memory = measured.memory;
  }
  for (const key of ["version", "memory", "cpuCount", "nodeCount"] as const) {
    if (out[key] === undefined) {
      throw new Error(`Could not determine the cluster's ${key}, which every perf run records`);
    }
  }
  return out;
}

/** How many documents the bucket holds, from its `basicStats`. */
export async function bucketItemCount(rest: PerfClusterRest, bucket: string): Promise<number | undefined> {
  const response = await request(rest, "GET", `/pools/default/buckets/${bucket}`);
  if (response.status !== 200) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(response.body) as { basicStats?: { itemCount?: number } };
    return parsed.basicStats?.itemCount;
  } catch {
    return undefined;
  }
}
