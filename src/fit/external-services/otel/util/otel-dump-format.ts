/**
 * Pure logic: turning the raw traces/metrics pulled out of the ephemeral stack
 * into artifacts a human can read a week later, and the deep links that point a
 * replayed stack at the right time window. No IO here — see
 * dump-otel-data.ts for that.
 *
 * Everything renders timestamps as ISO-8601 UTC, matching the format `proc.ts`
 * already writes into the session and debug logs, so a rendered dump and a
 * container log can be interleaved by a plain `sort` when working out what the
 * driver was doing when a span appeared.
 */

/**
 * The parts of a Jaeger `/api/traces` response this module reads. Deliberately
 * a subset — the artifact keeps the full response verbatim, because Jaeger UI's
 * "JSON File" upload needs every field, not just the ones rendered here.
 */
export interface JaegerSpan {
  traceID: string;
  spanID: string;
  operationName: string;
  /** Epoch microseconds — Jaeger's native resolution, not millis. */
  startTime: number;
  /** Microseconds. */
  duration: number;
  processID: string;
  tags?: Array<{ key: string; value: unknown }>;
}

export interface JaegerProcess {
  serviceName: string;
}

export interface JaegerTrace {
  traceID: string;
  spans: JaegerSpan[];
  processes: Record<string, JaegerProcess>;
}

/** A single series from a Prometheus `/api/v1/query_range` response. */
export interface PrometheusRangeSeries {
  metric: Record<string, string>;
  /** `[epochSeconds, "value"]` pairs, as Prometheus returns them. */
  values: Array<[number, string]>;
}

export interface OtelWindow {
  /** ISO-8601 UTC — when the collector container started. */
  start: string;
  /** ISO-8601 UTC — when the dump was taken, just before teardown. */
  end: string;
}

export function isoFromEpochMicros(micros: number): string {
  const iso = new Date(Math.floor(micros / 1000)).toISOString();
  // Jaeger keeps microsecond resolution and spans routinely start within the
  // same millisecond, so preserve the last 3 digits rather than rounding them
  // away — otherwise a sorted index shows ties where the data has an order.
  const remainder = String(Math.floor(micros % 1000)).padStart(3, "0");
  return `${iso.slice(0, -1)}${remainder}Z`;
}

export function isoFromEpochSeconds(seconds: number): string {
  return new Date(Math.round(seconds * 1000)).toISOString();
}

function durationMs(micros: number): string {
  return `${(micros / 1000).toFixed(3)}ms`;
}

function spanIsError(span: JaegerSpan): boolean {
  return (span.tags ?? []).some((tag) => (tag.key === "error" && tag.value === true) || (tag.key === "otel.status_code" && tag.value === "ERROR"));
}

/**
 * One line per span, sorted by start time: the index you grep to find which
 * span was in flight when the driver logged a failure, and which traceID to
 * open in a replayed Jaeger.
 */
export function renderTraceIndex(traces: JaegerTrace[]): string {
  const lines = traces
    .flatMap((trace) =>
      trace.spans.map((span) => ({
        startTime: span.startTime,
        text: [
          isoFromEpochMicros(span.startTime),
          durationMs(span.duration).padStart(12),
          (trace.processes[span.processID]?.serviceName ?? "unknown-service").padEnd(20),
          span.operationName.padEnd(40),
          `trace=${span.traceID}`,
          `span=${span.spanID}`,
          ...(spanIsError(span) ? ["ERROR"] : []),
        ].join("  "),
      })),
    )
    .sort((a, b) => a.startTime - b.startTime || a.text.localeCompare(b.text));

  const header = `# ${lines.length} span(s) across ${traces.length} trace(s), sorted by start time (ISO-8601 UTC).\n# Columns: start  duration  service  operation  traceID  spanID\n`;
  return lines.length === 0 ? `${header}# (no spans were recorded)\n` : `${header}${lines.map((line) => line.text).join("\n")}\n`;
}

/** `db_foo{bar="baz",qux="1"}` — labels sorted so the same series always renders identically. */
export function formatSeriesName(metric: Record<string, string>): string {
  const { __name__: name, ...labels } = metric;
  const rendered = Object.keys(labels)
    .sort()
    .map((key) => `${key}="${labels[key]}"`)
    .join(",");
  return rendered === "" ? (name ?? "unknown_metric") : `${name ?? "unknown_metric"}{${rendered}}`;
}

/**
 * One line per sample, sorted by timestamp: the metrics equivalent of
 * {@link renderTraceIndex}, and the thing to grep when a metrics test asserted
 * a series existed and you need to know whether it ever had a value at all.
 */
export function renderMetricIndex(series: PrometheusRangeSeries[]): string {
  const lines = series
    .flatMap((one) => {
      const name = formatSeriesName(one.metric);
      return one.values.map(([seconds, value]) => ({
        seconds,
        text: `${isoFromEpochSeconds(seconds)}  ${name}  ${value}`,
      }));
    })
    .sort((a, b) => a.seconds - b.seconds || a.text.localeCompare(b.text));

  const header = `# ${lines.length} sample(s) across ${series.length} series, sorted by timestamp (ISO-8601 UTC).\n# Columns: timestamp  metric{labels}  value\n`;
  return lines.length === 0 ? `${header}# (no samples were recorded)\n` : `${header}${lines.map((line) => line.text).join("\n")}\n`;
}

/**
 * Prometheus' and the collector's own self-monitoring series. Excluded from the
 * dump: they are the same every run, dwarf the series a FIT test actually cares
 * about, and are still in the TSDB snapshot if ever needed.
 */
const INTERNAL_METRIC_PREFIXES = ["prometheus_", "promhttp_", "go_", "process_", "scrape_", "net_conntrack_", "otelcol_"] as const;

export function isInternalMetricName(name: string): boolean {
  return INTERNAL_METRIC_PREFIXES.some((prefix) => name.startsWith(prefix)) || name === "up";
}

/** The metric names worth dumping, sorted, with the self-monitoring noise dropped. */
export function metricNamesToDump(allNames: readonly string[]): string[] {
  return [...allNames].filter((name) => !isInternalMetricName(name)).sort();
}

/**
 * Jaeger UI's search deep link.
 *
 * Three details, each of which breaks the link if wrong:
 *  - `service` is REQUIRED. Jaeger UI runs a search immediately from the URL
 *    params, and its own `/api/traces` call rejects a serviceless query with
 *    `400 parameter 'service' is required` — so a link without one always fails,
 *    even though the time range is perfectly valid.
 *  - `lookback=custom` is what makes the UI honour `start`/`end`. Without it the
 *    time selector falls back to a relative default (an hour) and computes its own
 *    range from now, which for a dump opened the next day finds nothing.
 *  - `start`/`end` are microseconds — the same unit as a span's startTime, and
 *    *not* the millis most other UIs take.
 */
export function jaegerSearchUrl(uiBaseUrl: string, window: OtelWindow, service: string, limit = 1500): string {
  const params = new URLSearchParams({
    service,
    start: String(Date.parse(window.start) * 1000),
    end: String(Date.parse(window.end) * 1000),
    lookback: "custom",
    limit: String(limit),
  });
  return `${uiBaseUrl}/search?${params.toString()}`;
}

export const JAEGER_INTERNAL_SERVICE = "jaeger-all-in-one";

export function isInterestingJaegerService(service: string): boolean {
  return service !== JAEGER_INTERNAL_SERVICE;
}

/** `2026-08-13 14:30:00` — the literal format Prometheus' graph UI parses from `g0.end_input`. */
export function prometheusEndInput(iso: string): string {
  return iso.replace("T", " ").replace(/\..*$/, "");
}

/**
 * Prometheus graph deep link covering the whole run window, so a replayed
 * Prometheus opens on the run's data instead of the default "last hour" (which,
 * for a dump replayed the next day, is empty and reads as "the metrics are gone").
 */
export function prometheusGraphUrl(baseUrl: string, window: OtelWindow, query: string): string {
  const rangeSeconds = Math.max(60, Math.ceil((Date.parse(window.end) - Date.parse(window.start)) / 1000));
  const params = new URLSearchParams({
    "g0.expr": query,
    "g0.tab": "0",
    "g0.range_input": `${rangeSeconds}s`,
    "g0.end_input": prometheusEndInput(window.end),
  });
  return `${baseUrl}/graph?${params.toString()}`;
}
