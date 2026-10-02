/**
 * A run record built from a run's own JUnit results - what fit-cli will emit at the end of
 * every run. Unlike a record scraped from a CI log, every outcome is named, so a pass is a
 * pass rather than an inference.
 */
import { RUN_RECORD_SCHEMA, type RunRecord } from "../record/run-record.js";
import type { JunitOutcomes } from "./junit-outcomes.js";

/** Everything about the run that the JUnit XML itself doesn't say. */
export type RunDescription = Pick<RunRecord, "sdk" | "preset" | "performer" | "kind" | "cluster" | "params" | "date" | "ci">;

export function recordFromJunit(junit: JunitOutcomes, run: RunDescription): RunRecord {
  const c = junit.counts;
  // Copied field by field: callers may pass a whole scraped record as the description, and
  // its source/parserVersion/tests must not leak into this one.
  return {
    schema: RUN_RECORD_SCHEMA,
    source: "fit-cli",
    sdk: run.sdk,
    preset: run.preset,
    ...(run.performer ? { performer: run.performer } : {}),
    kind: run.kind,
    cluster: run.cluster,
    params: { ...run.params },
    date: run.date,
    ci: { ...run.ci },
    outcome: c.failed + c.errored > 0 ? "tests_failed" : "passed",
    counts: c,
    passesKnown: true,
    packages: junit.packages,
    tests: junit.tests,
  };
}
