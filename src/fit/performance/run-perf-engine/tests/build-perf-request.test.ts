import assert from "node:assert/strict";
import { test } from "node:test";
import { toBinary } from "@bufbuild/protobuf";
import {
  PERF_BUCKET,
  PERF_INITIAL_CONTENT,
  PERF_KEY_PREFACE,
  PERF_UPDATED_CONTENT,
  buildBounds,
  buildDocLocation,
  buildPerfRequest,
  buildWorkload,
  horizontalScaling,
  poolSizesIn,
  resolveApi,
  resolveInt,
  tunablesFrom,
  type PerfMergedSettings,
  type PerfOperation,
} from "../build-perf-request.js";
import { RequestSchema } from "../../generated/run.top_level_pb.js";
import { API } from "../../generated/shared.basic_pb.js";
import { RandomDistribution } from "../../generated/shared.doc_location_pb.js";

/** Stable counter ids, so a built request can be compared byte-for-byte. */
function counters(): () => string {
  let n = 0;
  return () => `counter-${++n}`;
}

const settings: PerfMergedSettings = {
  variables: { forSeconds: 20, poolSize: 1000, horizontalScaling: 1 },
};

test("resolveInt reads a $variable, a numeric string, and a plain number", () => {
  assert.equal(resolveInt(settings, "$poolSize"), 1000);
  assert.equal(resolveInt(settings, "250"), 250);
  assert.equal(resolveInt(settings, 42), 42);
});

test("resolveInt names the missing variable rather than defaulting", () => {
  assert.throws(() => resolveInt(settings, "$nope"), /Cannot find variable \$nope/);
});

test("horizontalScaling is required, not defaulted", () => {
  assert.equal(horizontalScaling(settings), 1);
  assert.throws(() => horizontalScaling({ variables: {} }), /horizontalScaling/);
});

test("resolveApi defaults to DEFAULT and reads the api variable", () => {
  assert.equal(resolveApi(settings), API.DEFAULT);
  assert.equal(resolveApi({ variables: { api: "ASYNC" } }), API.ASYNC);
  assert.throws(() => resolveApi({ variables: { api: "SIDEWAYS" } }), /Unknown api/);
});

test("a forSeconds bound becomes a ForTime bound", () => {
  const bounds = buildBounds(settings, { forSeconds: "$forSeconds" }, counters());
  assert.equal(bounds?.bounds.case, "forTime");
  assert.equal(bounds?.bounds.case === "forTime" ? bounds.bounds.value.seconds : undefined, 20);
});

test("a count bound becomes a global counter with its own id", () => {
  const bounds = buildBounds(settings, { count: 500 }, counters());
  assert.equal(bounds?.bounds.case, "counter");
  if (bounds?.bounds.case !== "counter") throw new Error("expected a counter bound");
  assert.equal(bounds.bounds.value.counterId, "counter-1");
  assert.equal(bounds.bounds.value.counter.case === "global" ? bounds.bounds.value.counter.value.count : undefined, 500);
});

test("no bounds means no bounds, rather than an empty one", () => {
  assert.equal(buildBounds(settings, undefined, counters()), undefined);
});

test("bounds must say how they are bounded", () => {
  assert.throws(() => buildBounds(settings, {}, counters()), /count.*forSeconds|forSeconds/);
});

test("a pool doc location carries the bucket, preface and resolved size", () => {
  const location = buildDocLocation(settings, { method: "pool", poolSize: "$poolSize", poolSelectionStrategy: "randomUniform" }, counters());
  assert.equal(location.location.case, "pool");
  if (location.location.case !== "pool") throw new Error("expected a pool location");
  const pool = location.location.value;
  assert.equal(pool.collection?.bucketName, PERF_BUCKET);
  assert.equal(pool.collection?.scopeName, "_default");
  // The default scope name is sent as the collection name too — odd, but it is what every
  // historical datapoint was measured with.
  assert.equal(pool.collection?.collectionName, "_default");
  assert.equal(pool.idPreface, PERF_KEY_PREFACE);
  assert.equal(pool.poolSize, 1000n);
  assert.equal(pool.poolSelectionStrategy.case, "random");
  assert.equal(
    pool.poolSelectionStrategy.case === "random" ? pool.poolSelectionStrategy.value.distribution : undefined,
    RandomDistribution.UNIFORM,
  );
});

test("a counter pool selection gets a counter starting at zero", () => {
  const location = buildDocLocation(settings, { method: "pool", poolSize: 10, poolSelectionStrategy: "counter" }, counters());
  if (location.location.case !== "pool") throw new Error("expected a pool location");
  const strategy = location.location.value.poolSelectionStrategy;
  assert.equal(strategy.case, "counter");
  assert.equal(strategy.case === "counter" ? strategy.value.counter?.counter.case : undefined, "global");
});

test("a specific doc location needs an id", () => {
  assert.throws(() => buildDocLocation(settings, { method: "specific" }, counters()), /id to be set/);
  const location = buildDocLocation(settings, { method: "specific", id: "doc" }, counters());
  assert.equal(location.location.case, "specific");
});

test("a uuid doc location carries only the collection", () => {
  const location = buildDocLocation(settings, { method: "uuid" }, counters());
  assert.equal(location.location.case, "uuid");
});

test("a pool doc location needs a pool size", () => {
  assert.throws(() => buildDocLocation(settings, { method: "pool" }, counters()), /poolSize/);
});

const poolGet: PerfOperation = {
  op: "get",
  bounds: { forSeconds: "$forSeconds" },
  docLocation: { method: "pool", poolSize: "$poolSize", poolSelectionStrategy: "randomUniform" },
};

test("a get becomes an sdk workload with one get command", () => {
  const workload = buildWorkload({ settings, api: API.DEFAULT, clusterConnectionId: "cc", newCounterId: counters() }, poolGet, undefined);
  assert.equal(workload.workload.case, "sdk");
  if (workload.workload.case !== "sdk") throw new Error("expected an sdk workload");
  assert.equal(workload.workload.value.command.length, 1);
  assert.equal(workload.workload.value.command[0].command.case, "get");
});

test("mutating operations carry their content and the raw-JSON transcoder", () => {
  const ctx = { settings, api: API.DEFAULT, clusterConnectionId: "cc", newCounterId: counters() };
  for (const [op, expected] of [
    ["insert", PERF_INITIAL_CONTENT],
    ["replace", PERF_UPDATED_CONTENT],
    ["upsert", PERF_UPDATED_CONTENT],
  ] as const) {
    const workload = buildWorkload(ctx, { ...poolGet, op }, undefined);
    if (workload.workload.case !== "sdk") throw new Error("expected an sdk workload");
    const command = workload.workload.value.command[0].command;
    if (command.case !== op) throw new Error(`expected a ${op} command`);
    const value = command.value as { content?: { content: { case?: string; value?: unknown } }; options?: { transcoder?: unknown } };
    assert.equal(value.content?.content.case, "passthroughString");
    assert.equal(value.content?.content.value, expected);
    // Without this the SDK's own JSON encoding would be inside the timing.
    assert.ok(value.options?.transcoder, `${op} should set a transcoder`);
  }
});

test("a remove carries no content", () => {
  const workload = buildWorkload({ settings, api: API.DEFAULT, clusterConnectionId: "cc", newCounterId: counters() }, { ...poolGet, op: "remove" }, undefined);
  if (workload.workload.case !== "sdk") throw new Error("expected an sdk workload");
  assert.equal(workload.workload.value.command[0].command.case, "remove");
});

test("a ping becomes a grpc workload, not an sdk one", () => {
  const workload = buildWorkload(
    { settings, api: API.DEFAULT, clusterConnectionId: "cc", newCounterId: counters() },
    { op: "ping", bounds: { forSeconds: 5 } },
    buildBounds(settings, { forSeconds: 5 }, counters()),
  );
  assert.equal(workload.workload.case, "grpc");
});

test("a transaction wraps its ops, sets performance mode, and takes its own bounds", () => {
  const transaction: PerfOperation = {
    transaction: {
      bounds: { forSeconds: "$forSeconds" },
      ops: [
        { op: "replace", docLocation: { method: "pool", poolSize: "$poolSize", poolSelectionStrategy: "randomUniform" } },
        { op: "insert", docLocation: { method: "uuid" } },
      ],
    },
  };
  const workload = buildWorkload({ settings, api: API.DEFAULT, clusterConnectionId: "cc-7", newCounterId: counters() }, transaction, undefined);
  assert.equal(workload.workload.case, "transaction");
  if (workload.workload.case !== "transaction") throw new Error("expected a transaction workload");
  const value = workload.workload.value;
  assert.equal(value.performanceMode, true);
  assert.equal(value.bounds?.bounds.case, "forTime");
  assert.equal(value.command[0].clusterConnectionId, "cc-7");
  const commands = value.command[0].attempts[0].commands;
  assert.deepEqual(commands.map((c) => c.command.case), ["replaceV2", "insertV2"]);
});

test("a transaction rejects operations it cannot express", () => {
  const transaction: PerfOperation = { transaction: { ops: [{ op: "upsert", docLocation: { method: "uuid" } }] } };
  assert.throws(
    () => buildWorkload({ settings, api: API.DEFAULT, clusterConnectionId: "cc", newCounterId: counters() }, transaction, undefined),
    /cannot be used inside a transaction/,
  );
});

test("horizontalScaling repeats the same workload list", () => {
  const request = buildPerfRequest({
    operations: [poolGet],
    settings: { variables: { ...settings.variables, horizontalScaling: 4 } },
    clusterConnectionId: "cc",
    newCounterId: counters(),
  });
  assert.equal(request.request.case, "workloads");
  if (request.request.case !== "workloads") throw new Error("expected workloads");
  assert.equal(request.request.value.horizontalScaling.length, 4);
  assert.equal(request.request.value.clusterConnectionId, "cc");
});

test("the request always asks for metrics, and only sets streaming hints when given", () => {
  const plain = buildPerfRequest({ operations: [poolGet], settings, clusterConnectionId: "cc", newCounterId: counters() });
  assert.equal(plain.config?.streamingConfig?.enableMetrics, true);
  assert.equal(plain.config?.streamingConfig?.batchSize, undefined);

  const tuned = buildPerfRequest({
    operations: [poolGet],
    settings: { ...settings, grpc: { batch: 100, flowControl: true } },
    clusterConnectionId: "cc",
    newCounterId: counters(),
  });
  assert.equal(tuned.config?.streamingConfig?.batchSize, 100);
  assert.equal(tuned.config?.streamingConfig?.flowControl, true);
});

test("a batch size of zero is treated as unset", () => {
  const request = buildPerfRequest({
    operations: [poolGet],
    settings: { ...settings, grpc: { batch: 0 } },
    clusterConnectionId: "cc",
    newCounterId: counters(),
  });
  assert.equal(request.config?.streamingConfig?.batchSize, undefined);
});

test("only tunable variables are sent as tunables", () => {
  assert.deepEqual(tunablesFrom(settings), {});
  assert.deepEqual(
    tunablesFrom({ variables: { forSeconds: 20, "com.couchbase.threads": 8 }, tunableNames: ["com.couchbase.threads"] }),
    { "com.couchbase.threads": "8" },
  );
});

test("the built request is stable for a given workload", () => {
  // Byte-stability matters: it is what makes a two-engine diff meaningful.
  const build = (): Uint8Array =>
    toBinary(RequestSchema, buildPerfRequest({ operations: [poolGet], settings, clusterConnectionId: "cc", newCounterId: counters() }));
  assert.deepEqual(build(), build());
});

test("poolSizesIn finds pools inside transactions too", () => {
  assert.deepEqual(poolSizesIn(settings, [poolGet]), [1000]);
  assert.deepEqual(
    poolSizesIn(settings, [{ transaction: { ops: [{ op: "get", docLocation: { method: "pool", poolSize: 25 } }] } }]),
    [25],
  );
  assert.deepEqual(poolSizesIn(settings, [{ op: "insert", docLocation: { method: "uuid" } }]), []);
});
