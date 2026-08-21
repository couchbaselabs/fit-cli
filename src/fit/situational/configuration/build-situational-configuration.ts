/**
 * Build the situational FITConfiguration object.
 *
 * Unlike the functional config, situational testing lets cbdino create and
 * manage its own clusters, so the clusterAccess block is just a placeholder (the
 * FIT docs say it's ignored for situational-only runs). What matters is the
 * `situational.cbdino` block (which cluster version cbdino should build) and the
 * `situational.database` block (where the timeseries results land).
 *
 * The config is assembled from config-pieces, so a shared base piece is layered
 * with the situational-specific piece — the artifact-pieces idea from the README.
 * An optional definition `fitConfig` piece is layered last so a definition file
 * can override or extend any field.
 *
 * Pure logic — no file IO — so it's easy to unit test (see
 * tests/build-situational-configuration.test.ts).
 *
 * Run on its own (prints a sample situational config as JSON):
 *   bun src/fit/situational/configuration/build-situational-configuration.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { mergeConfigPieces, type ConfigPiece, type PieceData } from "../../../util/non-fit/config-pieces.js";
import { DEFAULT_PERFORMER_PORT } from "../../performers/util/performer-port.js";
import { type ResultsDatabase } from "../../shared/util/results-database.js";
import { AUTO_GENERATED_MARKER } from "../../shared/fit-configuration/write-fit-configuration.js";

/**
 * Default Couchbase Server version for situational runs that create Capella
 * clusters, used as this (pure, no-IO) module's own default/test value. The live
 * default actually used at run time comes from environments.json5's
 * `defaults.capellaClusterVersion` (see `situationalCbdinoSettings` in
 * run-from-definition.ts) — keep this literal in sync with that value.
 */
export const DEFAULT_CAPELLA_CLUSTER_VERSION = "8.0";

/**
 * Where the driver writes result files, relative to the test-driver module. The
 * driver defaults to "results", but we set it explicitly so config generation
 * and collection share one constant.
 */
export const SITUATIONAL_RESULTS_DIR_NAME = "results";

/** Where situational results go: a hosted database, or "files" for files mode. */
export type ResultsTarget = ResultsDatabase | "files";

/** How cbdino should build the cluster the situational tests run against. */
export interface CbdinoSettings {
  /** Couchbase Server version cbdino should deploy, e.g. "8.0-stable" or a pinned build like "8.0.2-5322". */
  version: string;
  /** Name (or path) of the cbdinocluster binary the driver should invoke. */
  cbDinoClusterAppPath: string;
  enablePrivateEndpoint: boolean;
  /**
   * Which CSP cbdino should deploy the Capella cluster on ("aws"|"gcp"|"azure").
   * The driver (`CbDinoRaw.deployer`) defaults to aws when omitted, so this is
   * only set explicitly for gcp — see {@link situationalCbdinoSettings}.
   */
  deployer?: string;
  /** Region for `deployer`, e.g. "us-west1" for gcp. Only meaningful alongside `deployer`. */
  region?: string;
  /**
   * When present, cbdino builds the cluster via the Couchbase Autonomous Operator
   * (CAO) / CNG gateway (OpenShift) instead of a Capella cloud cluster — the
   * situational counterpart of functional's `cao` cbdinocluster block.
   */
  cao?: {
    operatorVersion: string;
    gatewayVersion: string;
  };
}

export const DEFAULT_CBDINO_SETTINGS: CbdinoSettings = {
  version: DEFAULT_CAPELLA_CLUSTER_VERSION,
  cbDinoClusterAppPath: "cbdinocluster",
  enablePrivateEndpoint: false,
};

/**
 * The base, flavour-agnostic part of the config: the auto-generated marker, a
 * placeholder clusterAccess (unused for situational), and the performer port.
 */
function baseConfigPiece(performerPort: number): ConfigPiece {
  return {
    label: "base",
    data: {
      "//": AUTO_GENERATED_MARKER,
      clusterAccess: {
        "//": "Ignored for situational-only runs — cbdino creates and manages the cluster. Required anyway: FITConfigRaw.convertClusterAccess throws if absent.",
        defaultHostname: "localhost",
        username: "Administrator",
        password: "password",
      },
      performerPorts: [performerPort],
    },
  };
}

/**
 * The situational-specific part: don't exclude situational tests, add cbdino +
 * database. Analytics/Columnar situational tests (tagged "columnar", e.g.
 * ColumnarTest) are excluded by default — they need an Analytics performer and
 * fail against a plain operational one. A definition file can opt back in with
 * a `fitConfig.excludeTests` override, which replaces this array wholesale.
 *
 * The database block deliberately carries only the non-secret jdbc + username.
 * The password is NOT written here: FITConfiguration.json is collected into CI
 * artifacts, so a password in it leaks. fit-cli passes it to the test-driver via
 * the FIT_RESULTS_DB_PASSWORD environment variable instead (see runTestDriver),
 * and the driver rejects a password found in config.
 *
 * Pass "files" to emit a files block instead of database - the files-only driver
 * rejects a database block.
 */
export function situationalConfigPiece(target: ResultsTarget, cbdino: CbdinoSettings): ConfigPiece {
  return {
    label: "situational",
    data: {
      excludeTests: ["columnar"],
      situational: {
        cbdino: {
          version: cbdino.version,
          cbDinoClusterAppPath: cbdino.cbDinoClusterAppPath,
          enablePrivateEndpoint: cbdino.enablePrivateEndpoint,
          ...(cbdino.deployer !== undefined ? { deployer: cbdino.deployer } : {}),
          ...(cbdino.region !== undefined ? { region: cbdino.region } : {}),
          ...(cbdino.cao
            ? { deployer: "cao", operatorVersion: cbdino.cao.operatorVersion, gatewayVersion: cbdino.cao.gatewayVersion }
            : {}),
        },
        ...(target === "files"
          ? { files: { outputDirectory: SITUATIONAL_RESULTS_DIR_NAME } }
          : {
              database: {
                jdbc: target.jdbc,
                username: target.username,
              },
            }),
      },
    },
  };
}

/**
 * Build the merged situational FITConfiguration object (pure — no IO).
 * `fitConfigPiece` is the optional definition-supplied artifact piece, layered
 * last so a definition file can override or extend any generated field.
 */
export function buildSituationalConfiguration(
  target: ResultsTarget,
  cbdino: CbdinoSettings = DEFAULT_CBDINO_SETTINGS,
  performerPort: number = DEFAULT_PERFORMER_PORT,
  fitConfigPiece?: PieceData,
): Record<string, unknown> {
  // The fitConfig piece merges last and can only add keys, so a definition in
  // files mode that still sets situational.database ends up with both blocks.
  // The driver rejects that only at startup, once the cluster is provisioned -
  // fail here instead.
  if (target === "files" && (fitConfigPiece?.situational as Record<string, unknown> | undefined)?.database !== undefined) {
    throw new Error(
      "The definition's fitConfig sets situational.database, but this run uses files mode - remove the database override from the definition.",
    );
  }
  return mergeConfigPieces([
    baseConfigPiece(performerPort),
    situationalConfigPiece(target, cbdino),
    ...(fitConfigPiece ? [{ label: "definition fitConfig piece", data: fitConfigPiece }] : []),
  ]);
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const sample = buildSituationalConfiguration({
      jdbc: "jdbc:postgresql://performance-sdk.couchbase.com:5432/perf",
      username: "results_writer",
      password: "***",
    });
    console.log(JSON.stringify(sample, null, 2));
    return Promise.resolve();
  });
}
