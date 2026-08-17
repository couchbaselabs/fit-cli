/**
 * Turns a perf TestSuite's `operations` into the protobuf `run.Request` a performer executes.
 *
 * The mapping is fixed in every detail, down to the document content strings and the
 * per-operation transcoder, because a workload's protobuf shape decides what is actually
 * measured — a difference here is a difference in the numbers, not just in the code, and
 * numbers measured today have to stay comparable with the recorded history.
 */
import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { BoundsSchema, CounterGlobalSchema, CounterSchema, ForTimeSchema, type Bounds } from "../generated/shared.bounds_pb.js";
import { CollectionSchema } from "../generated/shared.collection_pb.js";
import { ContentSchema } from "../generated/shared.content_pb.js";
import {
  DocLocationPoolSchema,
  DocLocationSchema,
  DocLocationSpecificSchema,
  DocLocationUuidSchema,
  PoolSelectionStategyRandomSchema,
  PoolSelectionStrategyCounterSchema,
  RandomDistribution,
  type DocLocation,
} from "../generated/shared.doc_location_pb.js";
import { RawJsonTranscoderSchema, TranscoderSchema } from "../generated/shared.transcoders_pb.js";
import { API } from "../generated/shared.basic_pb.js";
import { CommandSchema, WorkloadSchema as SdkWorkloadSchema } from "../generated/sdk.workload_pb.js";
import { GetSchema, InsertSchema, RemoveSchema, ReplaceSchema, UpsertSchema } from "../generated/sdk.kv.commands_pb.js";
import { InsertOptionsSchema, ReplaceOptionsSchema, UpsertOptionsSchema } from "../generated/sdk.kv.options_pb.js";
import { CommandSchema as MetaCommandSchema, PingSchema, WorkloadSchema as MetaWorkloadSchema } from "../generated/meta.workload_pb.js";
import {
  ExpectedResultSchema,
  GetSchema as TxnGetSchema,
  InsertSchema as TxnInsertSchema,
  RemoveSchema as TxnRemoveSchema,
  ReplaceSchema as TxnReplaceSchema,
  TransactionCommandSchema,
  type TransactionCommand,
} from "../generated/transactions.commands_pb.js";
import { TransactionAttemptRequestSchema, TransactionCreateRequestSchema } from "../generated/transactions.performer_pb.js";
import { WorkloadSchema as TxnWorkloadSchema } from "../generated/transactions.workload_pb.js";
import { HorizontalScalingSchema, WorkloadSchema, WorkloadsSchema, type Workload } from "../generated/run.workloads_pb.js";
import { ConfigSchema, ConfigStreamingSchema } from "../generated/run.config_pb.js";
import { RequestSchema, type Request } from "../generated/run.top_level_pb.js";

/** The bucket every perf workload runs against; the driver recreates it before each run. */
export const PERF_BUCKET = "default";
/** Document ids in a pool are this plus the index, e.g. `doc_417`. */
export const PERF_KEY_PREFACE = "doc_";

/**
 * The documents a workload reads and writes.
 *
 * Sent through the raw-JSON transcoder so no SDK-side JSON encoding is timed — that would be
 * measuring the JSON library rather than the SDK.
 */
export const PERF_INITIAL_CONTENT = '{"content":"initial"}';
export const PERF_UPDATED_CONTENT = '{"content":"updated"}';

/** The six operations a perf TestSuite can name. */
export type PerfOpName = "insert" | "get" | "remove" | "replace" | "upsert" | "ping";

/** A `$name` reference into the run's variables, or a literal. Numbers are accepted for both. */
export type PerfScalar = string | number;

export interface PerfBounds {
  count?: PerfScalar;
  forSeconds?: PerfScalar;
}

export interface PerfDocLocation {
  method: "specific" | "uuid" | "pool";
  id?: string;
  idPreface?: string;
  poolSize?: PerfScalar;
  poolSelectionStrategy?: "randomUniform" | "counter";
}

export interface PerfOperation {
  op?: PerfOpName;
  bounds?: PerfBounds;
  docLocation?: PerfDocLocation;
  transaction?: { ops: PerfOperation[]; bounds?: PerfBounds };
}

/** Resolved settings for one run: the top-level and per-run variables already merged. */
export interface PerfMergedSettings {
  variables: Record<string, PerfScalar | boolean>;
  /**
   * Variables the TestSuite marked `type: tunable`. These are passed through to the SDK
   * rather than read by the driver, so they need to be distinguishable from the rest once
   * the variable list has been flattened into {@link variables}.
   */
  tunableNames?: readonly string[];
  grpc?: { flowControl?: boolean; batch?: number; compression?: boolean };
}

/**
 * Resolve a `$name` reference to an integer, or parse a literal.
 *
 * Mirrors `TestSuite.Settings.getVariableAsInt`, including its habit of accepting a plain
 * number where a variable reference was expected.
 */
export function resolveInt(settings: PerfMergedSettings, input: PerfScalar): number {
  if (typeof input === "number") {
    return input;
  }
  if (!input.startsWith("$")) {
    const parsed = Number.parseInt(input, 10);
    if (Number.isNaN(parsed)) {
      throw new Error(`Expected "${input}" to be a number or a $variable reference`);
    }
    return parsed;
  }
  const name = input.slice(1);
  const value = settings.variables[name];
  if (value === undefined) {
    throw new Error(`Cannot find variable ${input}`);
  }
  if (typeof value === "boolean") {
    throw new Error(`Variable ${input} is a boolean, but is used where a number is needed`);
  }
  return typeof value === "number" ? value : Number.parseInt(value, 10);
}

/** `horizontalScaling` is read unconditionally by both engines, so its absence is an error, not a default. */
export function horizontalScaling(settings: PerfMergedSettings): number {
  return resolveInt(settings, "$horizontalScaling");
}

/** The API a workload's SDK commands should use, from the optional `api` variable. */
export function resolveApi(settings: PerfMergedSettings): API {
  const raw = settings.variables.api;
  if (raw === undefined) {
    return API.DEFAULT;
  }
  const name = String(raw);
  const value = (API as unknown as Record<string, number | undefined>)[name];
  if (value === undefined) {
    throw new Error(`Unknown api "${name}" — expected one of ${Object.keys(API).filter((k) => Number.isNaN(Number(k))).join(", ")}`);
  }
  return value;
}

/** A counter bound gets a fresh id, so it isn't shared. */
export function buildBounds(settings: PerfMergedSettings, bounds: PerfBounds | undefined, newCounterId: () => string): Bounds | undefined {
  if (bounds === undefined) {
    return undefined;
  }
  if (bounds.count !== undefined) {
    return create(BoundsSchema, {
      bounds: {
        case: "counter",
        value: create(CounterSchema, {
          counterId: newCounterId(),
          counter: { case: "global", value: create(CounterGlobalSchema, { count: resolveInt(settings, bounds.count) }) },
        }),
      },
    });
  }
  if (bounds.forSeconds !== undefined) {
    return create(BoundsSchema, {
      bounds: { case: "forTime", value: create(ForTimeSchema, { seconds: resolveInt(settings, bounds.forSeconds) }) },
    });
  }
  throw new Error("Bounds must set either `count` or `forSeconds`");
}

export function buildDocLocation(settings: PerfMergedSettings, location: PerfDocLocation, newCounterId: () => string): DocLocation {
  // The default scope name is passed as the collection name too. It is wrong in the abstract
  // and correct in practice — the default collection and scope share the name — but it is what
  // every historical datapoint was measured with, so it stays.
  const collection = create(CollectionSchema, { bucketName: PERF_BUCKET, scopeName: "_default", collectionName: "_default" });

  switch (location.method) {
    case "specific": {
      if (location.id === undefined) {
        throw new Error("Expect id to be set on specific doc location");
      }
      return create(DocLocationSchema, {
        location: { case: "specific", value: create(DocLocationSpecificSchema, { collection, id: location.id }) },
      });
    }
    case "uuid":
      return create(DocLocationSchema, { location: { case: "uuid", value: create(DocLocationUuidSchema, { collection }) } });
    case "pool": {
      if (location.poolSize === undefined) {
        throw new Error("Expect poolSize to be set on pool doc location");
      }
      const pool = create(DocLocationPoolSchema, {
        collection,
        idPreface: location.idPreface ?? PERF_KEY_PREFACE,
        poolSize: BigInt(resolveInt(settings, location.poolSize)),
        poolSelectionStrategy:
          location.poolSelectionStrategy === "counter"
            ? {
                case: "counter",
                value: create(PoolSelectionStrategyCounterSchema, {
                  counter: create(CounterSchema, {
                    counterId: newCounterId(),
                    counter: { case: "global", value: create(CounterGlobalSchema, { count: 0 }) },
                  }),
                }),
              }
            : {
                case: "random",
                value: create(PoolSelectionStategyRandomSchema, { distribution: RandomDistribution.UNIFORM }),
              },
      });
      return create(DocLocationSchema, { location: { case: "pool", value: pool } });
    }
  }
}

/** The raw-JSON transcoder every mutating operation is given, so JSON encoding isn't timed. */
function rawJsonTranscoder(): ReturnType<typeof create<typeof TranscoderSchema>> {
  return create(TranscoderSchema, { transcoder: { case: "rawJson", value: create(RawJsonTranscoderSchema, {}) } });
}

function content(json: string): ReturnType<typeof create<typeof ContentSchema>> {
  return create(ContentSchema, { content: { case: "passthroughString", value: json } });
}

export interface BuildContext {
  settings: PerfMergedSettings;
  api: API;
  clusterConnectionId: string;
  /** Fresh uuid per call. Injectable so tests can produce a stable request. */
  newCounterId: () => string;
}

/** One SDK command, as it appears inside an sdk.Workload. */
function sdkCommand(ctx: BuildContext, op: PerfOperation): ReturnType<typeof create<typeof CommandSchema>> {
  if (op.op === undefined) {
    throw new Error("Expected an `op`");
  }
  if (op.op === "ping") {
    throw new Error("`ping` is not an SDK command");
  }
  if (op.docLocation === undefined) {
    throw new Error(`Operation "${op.op}" needs a docLocation`);
  }
  const location = buildDocLocation(ctx.settings, op.docLocation, ctx.newCounterId);

  switch (op.op) {
    case "get":
      return create(CommandSchema, { command: { case: "get", value: create(GetSchema, { location }) }, api: ctx.api });
    case "remove":
      return create(CommandSchema, { command: { case: "remove", value: create(RemoveSchema, { location }) }, api: ctx.api });
    case "insert":
      return create(CommandSchema, {
        command: {
          case: "insert",
          value: create(InsertSchema, {
            location,
            content: content(PERF_INITIAL_CONTENT),
            options: create(InsertOptionsSchema, { transcoder: rawJsonTranscoder() }),
          }),
        },
        api: ctx.api,
      });
    case "replace":
      return create(CommandSchema, {
        command: {
          case: "replace",
          value: create(ReplaceSchema, {
            location,
            content: content(PERF_UPDATED_CONTENT),
            options: create(ReplaceOptionsSchema, { transcoder: rawJsonTranscoder() }),
          }),
        },
        api: ctx.api,
      });
    case "upsert":
      return create(CommandSchema, {
        command: {
          case: "upsert",
          value: create(UpsertSchema, {
            location,
            content: content(PERF_UPDATED_CONTENT),
            options: create(UpsertOptionsSchema, { transcoder: rawJsonTranscoder() }),
          }),
        },
        api: ctx.api,
      });
  }
}

/** One command inside a transaction. */
function transactionCommand(ctx: BuildContext, op: PerfOperation): TransactionCommand {
  if (op.op === undefined || op.docLocation === undefined) {
    throw new Error("A transaction's operations must each set `op` and `docLocation`");
  }
  const location = buildDocLocation(ctx.settings, op.docLocation, ctx.newCounterId);
  // Perf runs don't assert on results, so every command accepts whatever it gets.
  const expectedResult = [create(ExpectedResultSchema, { result: { case: "anythingAllowed", value: true } })];

  switch (op.op) {
    case "get":
      return create(TransactionCommandSchema, { command: { case: "getV2", value: create(TxnGetSchema, { location, expectedResult }) } });
    case "remove":
      return create(TransactionCommandSchema, { command: { case: "removeV2", value: create(TxnRemoveSchema, { location, expectedResult }) } });
    case "insert":
      return create(TransactionCommandSchema, {
        command: { case: "insertV2", value: create(TxnInsertSchema, { location, expectedResult, content: content(PERF_INITIAL_CONTENT) }) },
      });
    case "replace":
      return create(TransactionCommandSchema, {
        command: { case: "replaceV2", value: create(TxnReplaceSchema, { location, expectedResult, content: content(PERF_UPDATED_CONTENT) }) },
      });
    default:
      throw new Error(`Operation "${op.op}" cannot be used inside a transaction`);
  }
}

/** One entry in the workload list: an SDK command, a transaction, or a gRPC ping. */
export function buildWorkload(ctx: BuildContext, op: PerfOperation, bounds: Bounds | undefined): Workload {
  if (op.transaction !== undefined) {
    const transactionBounds = buildBounds(ctx.settings, op.transaction.bounds, ctx.newCounterId);
    return create(WorkloadSchema, {
      workload: {
        case: "transaction",
        value: create(TxnWorkloadSchema, {
          performanceMode: true,
          command: [
            create(TransactionCreateRequestSchema, {
              clusterConnectionId: ctx.clusterConnectionId,
              attempts: [create(TransactionAttemptRequestSchema, { commands: op.transaction.ops.map((inner) => transactionCommand(ctx, inner)) })],
            }),
          ],
          ...(transactionBounds ? { bounds: transactionBounds } : {}),
        }),
      },
    });
  }

  if (op.op === "ping") {
    return create(WorkloadSchema, {
      workload: {
        case: "grpc",
        value: create(MetaWorkloadSchema, {
          command: create(MetaCommandSchema, { command: { case: "ping", value: create(PingSchema, {}) } }),
          ...(bounds ? { bounds } : {}),
        }),
      },
    });
  }

  return create(WorkloadSchema, {
    workload: {
      case: "sdk",
      value: create(SdkWorkloadSchema, { command: [sdkCommand(ctx, op)], ...(bounds ? { bounds } : {}) }),
    },
  });
}

export interface BuildPerfRequestInput {
  operations: PerfOperation[];
  settings: PerfMergedSettings;
  clusterConnectionId: string;
  /** Injectable for tests; defaults to `crypto.randomUUID`. */
  newCounterId?: () => string;
}

/**
 * Build the whole `run.Request` for one run.
 *
 * The same workload list is repeated `horizontalScaling` times, which is how the protocol
 * expresses concurrency: each entry is a thread-like the performer runs the list in.
 */
export function buildPerfRequest(input: BuildPerfRequestInput): Request {
  const ctx: BuildContext = {
    settings: input.settings,
    api: resolveApi(input.settings),
    clusterConnectionId: input.clusterConnectionId,
    newCounterId: input.newCounterId ?? randomUUID,
  };

  const workloads = input.operations.map((op) => buildWorkload(ctx, op, buildBounds(ctx.settings, op.bounds, ctx.newCounterId)));
  const scaling = horizontalScaling(input.settings);
  const streaming = create(ConfigStreamingSchema, {
    enableMetrics: true,
    ...(input.settings.grpc?.batch ? { batchSize: input.settings.grpc.batch } : {}),
    ...(input.settings.grpc?.flowControl !== undefined ? { flowControl: input.settings.grpc.flowControl } : {}),
  });

  return create(RequestSchema, {
    config: create(ConfigSchema, { streamingConfig: streaming }),
    request: {
      case: "workloads",
      value: create(WorkloadsSchema, {
        clusterConnectionId: input.clusterConnectionId,
        horizontalScaling: Array.from({ length: scaling }, () => create(HorizontalScalingSchema, { workloads })),
      }),
    },
    tunables: tunablesFrom(input.settings),
  });
}

/** Variables marked `type: tunable`, as the string map the protocol carries them in. */
export function tunablesFrom(settings: PerfMergedSettings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of settings.tunableNames ?? []) {
    const value = settings.variables[name];
    if (value !== undefined) {
      out[name] = String(value);
    }
  }
  return out;
}

/** Pool sizes that must exist as documents before the workload runs. Recurses into transactions. */
export function poolSizesIn(settings: PerfMergedSettings, operations: readonly PerfOperation[]): number[] {
  const sizes: number[] = [];
  const visit = (op: PerfOperation): void => {
    if (op.docLocation?.method === "pool" && op.docLocation.poolSize !== undefined) {
      sizes.push(resolveInt(settings, op.docLocation.poolSize));
    }
    op.transaction?.ops.forEach(visit);
  };
  operations.forEach(visit);
  return sizes;
}
