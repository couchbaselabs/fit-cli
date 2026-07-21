/**
 * Pure logic: names, ports, image refs and `docker create` arg builders for
 * fit-cli's ephemeral local otel stack (collector + Jaeger +
 * Prometheus). No IO here — see start-otel-stack.ts for that.
 *
 * Run on its own (prints the topology as JSON):
 *   bun src/fit/external-services/otel/util/otel-topology.ts
 */
import { isMain, runCli } from "../../../../util/non-fit/cli.js";
import type { OtelDefaults } from "../../../util/environments.js";

/** Dedicated bridge network so the 3 containers can reach each other by name. */
export const OTEL_NETWORK = "fit-otel";

/**
 * Fixed container names. Fixed (not per-run) so a leaked stack from an
 * interrupted run is found and adopted rather than silently duplicated — see
 * the adopt-or-fail check in start-otel-stack.ts.
 */
export const OTEL_CONTAINER_NAMES = {
  collector: "fit-cli-otel-collector",
  jaeger: "fit-cli-otel-jaeger",
  prometheus: "fit-cli-otel-prometheus",
} as const;

/** Host ports published for this box's stack. Fixed, like DEFAULT_PERFORMER_PORT. */
export const OTEL_PORTS = {
  otlpGrpc: 4317,
  otlpHttp: 4318,
  collectorHealth: 13133,
  /** Published for direct debugging only — Prometheus reaches this by container DNS, not this port. */
  collectorPrometheusExporter: 8889,
  jaegerQueryGrpc: 16685,
  jaegerUi: 16686,
  prometheus: 9090,
} as const;

/** Paths inside each container where its config gets `docker cp`'d. */
export const OTEL_CONFIG_PATHS = {
  collector: "/etc/otelcol-contrib/config.yaml",
  prometheus: "/etc/prometheus/prometheus.yml",
} as const;

/**
 * Jaeger's badger store, persisted so the spans survive the container.
 *
 * all-in-one defaults to in-memory storage, which is fine for a live run but
 * leaves nothing to dump. Switching it to badger on a volume makes traces work
 * exactly like metrics do: snapshot the store at teardown, restore it into a
 * fresh server to look at it later (see dump-otel-data.ts and
 * replay-otel-data.ts). That symmetry is the point — the alternative
 * was a collector `file/traces` exporter, which needed its own writable mount,
 * its own replay collector to re-ingest the result, and could fail the collector's
 * startup (and therefore any functional run) if its file couldn't be opened.
 *
 * A named volume rather than a bind mount, and chmod'd before Jaeger starts,
 * because the image runs non-root and:
 *  - a fresh volume is created root-owned 0755, which Jaeger can't write to, but
 *    unlike a bind mount its permissions can be fixed from inside a container;
 *  - a host bind mount is presented by Docker Desktop as root:root 0755 whatever
 *    the host is chmod'd to, and worse, silently resolves to an empty VM-local
 *    directory when the file-sharing list omits /tmp — where fit-cli's artifacts
 *    live. See the module doc on start-otel-stack.ts.
 */
export const OTEL_BADGER_VOLUME = "fit-cli-otel-jaeger-badger";
export const OTEL_BADGER_DIR = "/badger";
export const OTEL_BADGER_TAR_FILENAME = "jaeger-badger.tar.gz";

/** Prometheus' TSDB path inside the official image — snapshots land under `<this>/snapshots/<name>`. */
export const PROMETHEUS_TSDB_PATH = "/prometheus";


export interface OtelImages {
  collector: string;
  jaeger: string;
  prometheus: string;
}

/** Build the 3 pinned image refs from environments.json5's externalServices.otel. */
export function otelImages(otel: OtelDefaults): OtelImages {
  return {
    collector: `otel/opentelemetry-collector-contrib:${otel.collectorVersion}`,
    jaeger: `jaegertracing/all-in-one:${otel.jaegerVersion}`,
    prometheus: `prom/prometheus:${otel.prometheusVersion}`,
  };
}

/**
 * `docker create` args for the collector. Created (not run) so its config can
 * be `docker cp`'d in before `docker start` — see the module doc on
 * start-otel-stack.ts for why that beats a bind mount. No `--rm`: it
 * only removes containers that exit, so it wouldn't help with Ctrl-C, and it
 * would destroy a crashed collector before its log could be inspected.
 */
export function collectorCreateArgs(image: string): string[] {
  return [
    "create",
    "--name",
    OTEL_CONTAINER_NAMES.collector,
    "--network",
    OTEL_NETWORK,
    "--publish",
    `${OTEL_PORTS.otlpGrpc}:4317`,
    "--publish",
    `${OTEL_PORTS.otlpHttp}:4318`,
    "--publish",
    `${OTEL_PORTS.collectorHealth}:13133`,
    "--publish",
    `${OTEL_PORTS.collectorPrometheusExporter}:8889`,
    image,
    `--config=${OTEL_CONFIG_PATHS.collector}`,
  ];
}

/**
 * `docker create` args for Jaeger. Its own OTLP receiver (enabled via
 * COLLECTOR_OTLP_ENABLED) stays internal — the collector reaches it by
 * container DNS (`fit-cli-otel-jaeger:4317`), never published to the
 * host.
 *
 * The badger env vars replace all-in-one's default in-memory storage with a
 * persistent store on a volume, which is what makes the spans dumpable at all —
 * see {@link OTEL_BADGER_VOLUME}. Without BADGER_EPHEMERAL=false badger still
 * runs but throws its data away with the container, exactly like memory storage, 
 * and the dump comes back empty.
 */
export function jaegerCreateArgs(image: string): string[] {
  return [
    "create",
    "--name",
    OTEL_CONTAINER_NAMES.jaeger,
    "--network",
    OTEL_NETWORK,
    "--publish",
    `${OTEL_PORTS.jaegerQueryGrpc}:16685`,
    "--publish",
    `${OTEL_PORTS.jaegerUi}:16686`,
    "--env",
    "COLLECTOR_OTLP_ENABLED=true",
    "--env",
    "SPAN_STORAGE_TYPE=badger",
    "--env",
    "BADGER_EPHEMERAL=false",
    "--env",
    `BADGER_DIRECTORY_KEY=${OTEL_BADGER_DIR}/key`,
    "--env",
    `BADGER_DIRECTORY_VALUE=${OTEL_BADGER_DIR}/data`,
    "--volume",
    `${OTEL_BADGER_VOLUME}:${OTEL_BADGER_DIR}`,
    image,
  ];
}

/**
 * `docker create` args for Prometheus. `--web.enable-admin-api` is what makes
 * `POST /api/v1/admin/tsdb/snapshot` available; without it the teardown dump has
 * no way to capture metric *history*, only the latest sample per series. Safe
 * here because this Prometheus is per-run, per-box and never internet-facing.
 */
export function prometheusCreateArgs(image: string): string[] {
  return [
    "create",
    "--name",
    OTEL_CONTAINER_NAMES.prometheus,
    "--network",
    OTEL_NETWORK,
    "--publish",
    `${OTEL_PORTS.prometheus}:9090`,
    image,
    `--config.file=${OTEL_CONFIG_PATHS.prometheus}`,
    // Explicit, not inherited: passing any args here replaces the image's default
    // CMD, so without this the TSDB would land on Prometheus' own built-in default
    // (`data/`, relative to the image's /prometheus WORKDIR) and the snapshot path
    // the dump step `docker cp`s from would be wrong.
    `--storage.tsdb.path=${PROMETHEUS_TSDB_PATH}`,
    "--web.enable-admin-api",
  ];
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const images = otelImages({
      collectorVersion: "0.135.0",
      jaegerVersion: "1.62.0",
      prometheusVersion: "v2.55.0",
    });
    console.log(
      JSON.stringify(
        {
          network: OTEL_NETWORK,
          containerNames: OTEL_CONTAINER_NAMES,
          ports: OTEL_PORTS,
          images,
          collectorCreateArgs: collectorCreateArgs(images.collector),
          jaegerCreateArgs: jaegerCreateArgs(images.jaeger),
          prometheusCreateArgs: prometheusCreateArgs(images.prometheus),
        },
        null,
        2,
      ),
    );
    return Promise.resolve();
  });
}
