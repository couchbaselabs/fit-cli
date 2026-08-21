/**
 * Workflow: sanity-test a selected Couchbase cluster by querying its management
 * endpoint with curl.
 *
 * Run on its own:
 *   bun src/cluster/cluster-diag/cluster-diag.ts couchbase://127.0.0.1 Administrator password
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { capture, type RunOptions } from "../../util/non-fit/proc.js";
import type { SelectedCluster } from "../cluster-select/cluster-select.js";
import { classifyConnectionString } from "../cluster-select/classify-connection-string.js";

/**
 * The cluster's management-endpoint host and port. Shared by {@link clusterDiagUrl}
 * and cluster-ui-link.ts, which points users at the same endpoint in a browser.
 */
export function managementHostPort(cluster: SelectedCluster): { host: string; port: string } {
  const secure = cluster.scheme === "couchbases";
  const host = managementHost(cluster.defaultHostname);
  // CNG clusters on OpenShift expose management through a TLS-passthrough route
  // on the standard HTTPS port (443), not on Couchbase's native port (18091).
  const port = cluster.cng ? "443" : (secure ? "18091" : "8091");
  return { host, port };
}

/** Build the curl URL for the cluster's management endpoint. */
export function clusterDiagUrl(cluster: SelectedCluster): string {
  const secure = cluster.scheme === "couchbases";
  const scheme = secure ? "https" : "http";
  const { host, port } = managementHostPort(cluster);
  return `${scheme}://${host}:${port}/pools/default`;
}

function managementHost(defaultHostname: string): string {
  const firstHost = defaultHostname.split(",")[0]?.trim() ?? defaultHostname.trim();
  if (firstHost.startsWith("[")) {
    const bracket = firstHost.indexOf("]");
    return bracket === -1 ? firstHost : firstHost.slice(0, bracket + 1);
  }

  const colon = firstHost.indexOf(":");
  return colon === -1 ? firstHost : firstHost.slice(0, colon);
}

export interface ClusterDiagOptions {
  /** How long to keep retrying before giving up, in milliseconds. Defaults to 30 000 (30 s). */
  retryTimeoutMs?: number;
  /**
   * The function used to run curl. Defaults to the local `capture()`.
   * Pass `execution.capture` when the cluster is only reachable from a remote
   * execution target (e.g. an EC2 instance) so curl runs there instead of locally.
   */
  captureCommand?: (command: string, args: string[], cwd?: string, opts?: RunOptions) => Promise<string>;
}

/** Run a quick curl-based sanity check against the cluster's management endpoint.
 *  Retries with exponential backoff (up to 5 s per sleep) for up to retryTimeoutMs.
 *  Returns true immediately for Capella Analytics clusters — they don't expose the
 *  Couchbase Server management API at 18091/pools/default. */
export async function runClusterDiag(cluster: SelectedCluster, opts?: ClusterDiagOptions): Promise<boolean> {
  if (cluster.capellaAnalytics) {
    console.log("\n✓ Skipping cluster diag for Capella Analytics cluster (management REST API not available).");
    return true;
  }
  const url = clusterDiagUrl(cluster);
  const command = `curl -k -f --connect-timeout 5 -u <username>:<password> -X GET ${url}`;
  const retryTimeoutMs = opts?.retryTimeoutMs ?? 30_000;
  const captureCommand = opts?.captureCommand ?? capture;
  const deadline = Date.now() + retryTimeoutMs;
  let delayMs = 500;
  let attempt = 0;

  while (true) {
    try {
      // For convenience in testing e.g. Capella, always use -k (insecure).
      // Use quiet on retries to avoid spamming the terminal with repeated curl echoes.
      // --connect-timeout bounds each attempt so a single slow/unreachable attempt
      // can't silently eat the whole retry budget — without it curl falls back to
      // the OS's default TCP connect timeout (~130s on Linux), which is longer than
      // retryTimeoutMs itself and defeats the retry loop entirely (one hung attempt,
      // no actual retries). Bounding it matters especially for a freshly-linked
      // PrivateLink connection, which can need a few retries before it's reachable.
      // -f treats non-2xx responses as failures — without it, a 503 route-error page
      // (e.g. OpenShift's "Application is not available" when a CNG pod is briefly
      // down) counts as a successful curl and this check falsely passes.
      await captureCommand(
        "curl",
        ["-k", "-f", "--connect-timeout", "5", "-u", `${cluster.credentials.username}:${cluster.credentials.password}`, "-X", "GET", url],
        undefined,
        attempt > 0 ? { quiet: true } : undefined,
      );
      console.log(`\n✓ Cluster sanity test succeeded with:\n  ${command}`);
      return true;
    } catch (err) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        console.error(`\nSanity-testing the cluster with:\n  ${command}\n`);
        console.error(`\n✗ Cluster sanity test failed: ${(err as Error).message}`);
        return false;
      }
      const waitMs = Math.min(delayMs, remaining, 5_000);
      console.error(`  Cluster not ready yet (${(err as Error).message}), retrying in ${(waitMs / 1000).toFixed(1)}s (${Math.ceil(remaining / 1000)}s remaining)...`);
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      delayMs = Math.min(delayMs * 2, 5_000);
      attempt++;
    }
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const raw = process.argv[2];
    const username = process.argv[3];
    const password = process.argv[4];

    if (!raw || !username || !password) {
      console.error(
        "Usage: tsx src/workflows/cluster-diag/cluster-diag.ts <connection-string> <username> <password>",
      );
      process.exit(2);
    }

    const connection = classifyConnectionString(raw);
    if (connection.kind !== "supported") {
      console.error("The connection string must use couchbase:// or couchbases://.");
      process.exit(2);
    }

    const ok = await runClusterDiag({
      scheme: connection.scheme,
      defaultHostname: connection.defaultHostname,
      flavour: connection.flavour,
      credentials: { username, password },
      tls: connection.scheme === "couchbases" ? { insecure: true } : null,
    });
    process.exit(ok ? 0 : 1);
  });
}
