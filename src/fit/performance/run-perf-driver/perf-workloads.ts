/**
 * The named workloads a performance run can drive.
 *
 * These are not invented: they are the operation shapes FIT/PERF has actually
 * been running, taken from the workloads stored in `runs.params.workload` in the
 * results database. Keeping the catalogue to the shapes with history means a run
 * started from fit-cli lands on the same chart as the runs before it, rather than
 * becoming a datapoint of one.
 *
 * A definition file isn't limited to these — `performance.workload` takes the
 * driver's operations verbatim, so anything the driver understands can be written
 * out longhand. This is what the interactive builder offers.
 */
import type { JsonValue } from "../../../util/non-fit/config-pieces.js";
import type { PerformanceWorkload } from "../../shared/definition/types.js";

/** One operation inside a transaction: an op plus where its document comes from. */
const txnOp = (op: string, docLocation: JsonValue): JsonValue => ({ op, docLocation });

const POOLED_RANDOM: JsonValue = { method: "pool", poolSize: "$poolSize", poolSelectionStrategy: "randomUniform" };
const FRESH_UUID: JsonValue = { method: "uuid" };

export interface NamedPerfWorkload {
  value: string;
  name: string;
  description: string;
  /** Whether this workload references `$poolSize`, and so needs a document pool. */
  usesPool: boolean;
  build: () => PerformanceWorkload;
}

const pooled = (op: string, strategy: "randomUniform" | "counter"): PerformanceWorkload => ({
  operations: [
    {
      op,
      bounds: { forSeconds: "$forSeconds" },
      docLocation: { method: "pool", poolSize: "$poolSize", poolSelectionStrategy: strategy },
    },
  ],
});

export const PERF_WORKLOADS: NamedPerfWorkload[] = [
  {
    value: "get",
    name: "KV get (pooled, random)",
    description: "Reads documents at random from a pre-created pool. The most-run FIT/PERF workload.",
    usesPool: true,
    build: () => pooled("get", "randomUniform"),
  },
  {
    value: "replace",
    name: "KV replace (pooled, counter)",
    description: "Replaces documents in pool order, so every document is written the same number of times.",
    usesPool: true,
    build: () => pooled("replace", "counter"),
  },
  {
    value: "insert",
    name: "KV insert (fresh uuids)",
    description: "Inserts new documents under freshly generated ids — no pool, so the bucket grows throughout.",
    usesPool: false,
    build: () => ({
      operations: [{ op: "insert", bounds: { forSeconds: "$forSeconds" }, docLocation: { method: "uuid" } }],
    }),
  },
  {
    value: "transaction-replace-insert",
    name: "Transaction: replace + insert",
    description: "A transaction replacing a pooled document and inserting a new one. Needs an SDK with transactions.",
    usesPool: true,
    build: () => ({
      operations: [
        {
          transaction: {
            ops: [txnOp("replace", POOLED_RANDOM), txnOp("insert", FRESH_UUID)],
            bounds: { forSeconds: "$forSeconds" },
          },
        },
      ],
    }),
  },
  {
    value: "transaction-get",
    name: "Transaction: single get",
    description: "A transaction doing one pooled read — the cheapest transaction, so it measures transaction overhead.",
    usesPool: true,
    build: () => ({
      operations: [
        {
          transaction: {
            ops: [txnOp("get", POOLED_RANDOM)],
            bounds: { forSeconds: "$forSeconds" },
          },
        },
      ],
    }),
  },
];

export function perfWorkloadByValue(value: string): NamedPerfWorkload | undefined {
  return PERF_WORKLOADS.find((workload) => workload.value === value);
}
