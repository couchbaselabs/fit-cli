import assert from "node:assert/strict";
import { test } from "node:test";
import { buildObservabilityConfig } from "../run-perf-engine.js";

test("sends sampled traces to the collector, tagged with the run, and no metrics", () => {
  const config = buildObservabilityConfig("http://host.docker.internal:4317", "run-1");
  assert.equal(config.tracing?.endpointHostname, "http://host.docker.internal:4317");
  assert.equal(config.tracing?.samplingPercentage, 0.0001);
  assert.deepEqual(config.tracing?.resources.runId?.value, { case: "valueString", value: "run-1" });
  // As the Java perf driver configured it. SDK metrics cost ~5% and were never in the history.
  assert.equal(config.metrics, undefined);
});
