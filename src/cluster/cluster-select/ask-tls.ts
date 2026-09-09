/**
 * Step: decide the TLS section of the config for a couchbases:// cluster.
 *
 * - Production Capella: the SDK trusts Capella's built-in CA, so no TLS section
 *   is needed (returns null).
 * - Internal Capella / other couchbases:// clusters: the SDK needs either the
 *   cluster certificate or to connect insecurely — we ask which.
 *
 * See transactions-fit-performer/test-driver/FITConfiguration.md for more.
 *
 * Run on its own:
 *   bun src/cluster/cluster-select/ask-tls.ts internal-capella
 *   bun src/cluster/cluster-select/ask-tls.ts production-capella
 *   bun src/cluster/cluster-select/ask-tls.ts self-managed
 *
 * Prints the resulting tls value as JSON.
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { input, select } from "../../util/non-fit/prompts.js";
import type { ClusterFlavour } from "./classify-connection-string.js";

/** The tls section of clusterAccess: null (none), insecure, a cert path, or a cert as a PEM string. */
export type TlsConfig = null | { insecure: true } | { certPath: string } | { cert: string };

/**
 * Work out the tls section for a couchbases:// cluster, asking the user how to
 * trust the cluster where needed. Only call this for couchbases:// — plain
 * couchbase:// is non-TLS and should use null directly.
 */
export async function askTls(flavour: ClusterFlavour): Promise<TlsConfig> {
  if (flavour === "production-capella") {
    console.log(
      "Production Capella clusters are trusted by the SDK's built-in CA, so no certificate is needed.",
    );
    return null;
  }

  const choice = await select<"cert" | "insecure">({
    promptId: "cluster.tls.trust-mode",
    message: "How should the SDK trust this cluster over TLS?",
    choices: [
      { name: "Provide the cluster certificate", value: "cert" },
      { name: "Connect insecurely (skip certificate verification)", value: "insecure" },
    ],
  });

  if (choice === "insecure") {
    return { insecure: true };
  }

  const certPath = await input({
    promptId: "cluster.tls.cert-path",
    message: "Path to the cluster certificate (PEM format):",
  });
  return { certPath };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const flavour = process.argv[2] as ClusterFlavour;
    if (!["internal-capella", "production-capella", "self-managed"].includes(flavour)) {
      console.error(
        "Usage: tsx src/workflows/cluster/cluster-select/ask-tls.ts " +
          "<internal-capella | production-capella | self-managed>",
      );
      process.exit(2);
    }
    console.log(JSON.stringify(await askTls(flavour), null, 2));
  });
}
