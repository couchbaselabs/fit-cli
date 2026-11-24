/**
 * Workflow: select a Couchbase cluster to use. Reusable across features that
 * need a cluster — it asks whether to use an existing cluster or create one, and
 * for an existing cluster gathers its connection string, credentials and (for
 * couchbases://) TLS choice into a {@link SelectedCluster}.
 *
 * This workflow knows nothing about FIT configuration — turning a SelectedCluster
 * into a FITConfiguration lives under src/workflows/fit-functional/.
 *
 * Run this workflow on its own:
 *   bun src/cluster/cluster-select/cluster-select.ts
 *
 * Prints the selection as JSON.
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { askConnectionString } from "./ask-connection-string.js";
import { askCredentials, type Credentials } from "./ask-credentials.js";
import { askTls, type TlsConfig } from "./ask-tls.js";
import {
  classifyConnectionString,
  type ClusterFlavour,
  type SupportedCluster,
} from "./classify-connection-string.js";
import { chooseCluster } from "./choose-cluster.js";
import { detectCbdinocluster } from "./detect-cbdinocluster.js";

/**
 * TLS for a CNG performer's couchbase2 connection, written verbatim as the
 * FITConfiguration's `clusterAccess.tls`: `{}` is TLS verified against the default
 * trust store, `{ insecure: true }` skips verification.
 */
export type CngTls = Record<string, never> | { insecure: true };

/** Everything needed to connect to an existing cluster. */
export interface SelectedCluster {
  scheme: "couchbase" | "couchbases";
  defaultHostname: string;
  flavour: ClusterFlavour;
  credentials: Credentials;
  tls: TlsConfig;
  /**
   * Present for CNG / Protostellar clusters. The fields above stay classic — the
   * test-driver still connects over couchbase:// for admin (creating buckets,
   * inspecting configs) — while the performer connects to the gateway over this
   * couchbase2:// connection string. See FITConfiguration.couchbase2.example.json.
   */
  cng?: {
    /** The full couchbase2:// connection string the performer uses. */
    performerConnectionString: string;
    /** TLS for the performer's couchbase2 connection. */
    tls: CngTls;
  };
  /**
   * Present for a load-balanced Enterprise Analytics cluster: the nginx
   * load-balancer host (e.g. "172.18.0.3"), fetched via `cbdinocluster mgmt <id>`.
   * The Analytics SDK performer must connect through this single host — its
   * connection string is an HTTP/SDK URL, which can't take the comma-separated
   * multi-seed node list the driver (couchbase://) and REST (first node) use.
   * See build-fit-configuration's performer-host rewrite.
   */
  analyticsLoadBalancerHost?: string;
  /**
   * True for a Capella Analytics (cloud) cluster. The management REST API
   * (port 18091 / /pools/default) is not available on these clusters, so
   * sanity checks that curl that endpoint must be skipped.
   */
  capellaAnalytics?: boolean;
  /**
   * True when this Capella cluster is reached over an AWS PrivateLink connection
   * rather than the public endpoint. Unlike public Capella hostnames, a PrivateLink
   * private DNS hostname has no `_couchbases._tcp` SRV record, so build-fit-configuration
   * must force `resolveDnsSrv: false` even though the cluster otherwise looks like Capella
   * (which normally defaults `resolveDnsSrv: true`) — see build-fit-configuration.ts.
   */
  privateEndpoint?: boolean;
}

/** The outcome of the cluster-select workflow. */
export type ClusterSelection =
  | { mode: "existing"; cluster: SelectedCluster }
  /** The user wants to create a new cluster (not yet wired up anywhere). */
  | { mode: "create" };

/**
 * Resolve the connection string for an existing cluster: if cbdinocluster is
 * installed, offer to pick one of its running clusters and use that; otherwise
 * (or if its connection string isn't one this tool can use) fall back to asking
 * for it by hand.
 */
async function resolveConnection(): Promise<SupportedCluster> {
  const detected = await detectCbdinocluster();
  if (detected) {
    const classification = classifyConnectionString(detected.connectionString);
    if (classification.kind === "supported") {
      return classification;
    }
    console.log(
      `cbdinocluster returned ${detected.connectionString}, which this tool can't use ` +
        "directly — please enter a connection string instead.\n",
    );
  }
  return askConnectionString();
}

/**
 * Gather the rest of what's needed to connect to a classified cluster — its
 * credentials and (for couchbases://) TLS choice — into a {@link SelectedCluster}.
 * Shared by the select-existing path and the create-then-use path so a freshly
 * allocated cluster is finished off exactly like one the user picked.
 */
export async function buildSelectedCluster(connection: SupportedCluster): Promise<SelectedCluster> {
  const credentials = await askCredentials(connection.flavour);
  // couchbase:// is non-TLS; only couchbases:// needs a TLS decision.
  const tls: TlsConfig =
    connection.scheme === "couchbases" ? await askTls(connection.flavour) : null;

  return {
    scheme: connection.scheme,
    defaultHostname: connection.defaultHostname,
    flavour: connection.flavour,
    credentials,
    tls,
  };
}

/**
 * Walk the user through choosing a cluster. For an existing cluster this gathers
 * all the details needed to connect; for "create" it just records the intent.
 */
export async function selectCluster(): Promise<ClusterSelection> {
  const choice = await chooseCluster();
  if (choice === "create") {
    return { mode: "create" };
  }

  const connection = await resolveConnection();
  return { mode: "existing", cluster: await buildSelectedCluster(connection) };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const selection = await selectCluster();
    console.log(JSON.stringify(selection, null, 2));
  });
}
