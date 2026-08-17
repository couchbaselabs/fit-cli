/** Parsing and validation of `performance` runs — see parse-definition.test.ts for the other run types. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidDefinitionError, parseDefinition } from "../parse-definition.js";

function performanceDefinition(performanceBody: string): string {
  return `
version: 1
type: fit
instances:
  - localhost: {}
    clusters:
      - connection:
          connectionString: couchbase://localhost
          username: Administrator
          password: password
        sessions:
          - performer:
              image: java-fit-performer:main
            runs:
              - type: performance
                performance:
${performanceBody}
`;
}

const GET_WORKLOAD_ONLY = `                  workload:
                    operations:
                      - op: get
                        bounds:
                          forSeconds: $forSeconds
                        docLocation:
                          method: pool
                          poolSize: $poolSize
                          poolSelectionStrategy: randomUniform`;

const GET_WORKLOAD = `${GET_WORKLOAD_ONLY}
                  variables:
                    forSeconds: 300
                    poolSize: 10000`;

test("parses a performance run", () => {
  const def = parseDefinition(performanceDefinition(GET_WORKLOAD));
  const run = def.instances[0]?.clusters[0]?.sessions[0]?.runs[0];
  assert.ok(run && run.type === "performance");
  assert.equal(run.performance.workload.operations.length, 1);
  assert.deepEqual(run.performance.variables, { forSeconds: 300, poolSize: 10000 });
});

test("keeps the workload's operations exactly as written", () => {
  // The workload is stored verbatim in runs.params and is part of a datapoint's
  // identity, so the parser must not normalise or reorder any of it.
  const def = parseDefinition(performanceDefinition(GET_WORKLOAD));
  const run = def.instances[0]?.clusters[0]?.sessions[0]?.runs[0];
  assert.ok(run && run.type === "performance");
  assert.deepEqual(run.performance.workload.operations[0], {
    op: "get",
    bounds: { forSeconds: "$forSeconds" },
    docLocation: { method: "pool", poolSize: "$poolSize", poolSelectionStrategy: "randomUniform" },
  });
});

test("parses a transaction workload", () => {
  const def = parseDefinition(
    performanceDefinition(`                  workload:
                    operations:
                      - transaction:
                          ops:
                            - op: get
                              docLocation:
                                method: uuid
                          bounds:
                            forSeconds: "60"`),
  );
  const run = def.instances[0]?.clusters[0]?.sessions[0]?.runs[0];
  assert.ok(run && run.type === "performance");
  assert.ok("transaction" in (run.performance.workload.operations[0] ?? {}));
});

test("parses the optional cluster metadata and driver/performer versions", () => {
  const def = parseDefinition(
    performanceDefinition(
      `${GET_WORKLOAD}\n                  driverVer: 6\n                  performerVer: 1\n                  cluster:\n                    cpuCount: 16\n                    memory: 28000\n                    storage: magma\n                    replicas: 1`,
    ),
  );
  const run = def.instances[0]?.clusters[0]?.sessions[0]?.runs[0];
  assert.ok(run && run.type === "performance");
  assert.equal(run.performance.driverVer, 6);
  assert.equal(run.performance.performerVer, 1);
  assert.deepEqual(run.performance.cluster, { cpuCount: 16, memory: 28000, storage: "magma", replicas: 1 });
});

test("rejects a performance run with no workload", () => {
  assert.throws(
    () => parseDefinition(performanceDefinition(`                  variables:\n                    forSeconds: 300`)),
    (err: unknown) => err instanceof InvalidDefinitionError && /performance\.workload/.test(err.message),
  );
});

test("rejects a performance run with an empty operations list", () => {
  assert.throws(
    () => parseDefinition(performanceDefinition(`                  workload:\n                    operations: []`)),
    (err: unknown) => err instanceof InvalidDefinitionError && /at least one operation/.test(err.message),
  );
});

test("rejects an operation that is neither an op nor a transaction", () => {
  assert.throws(
    () =>
      parseDefinition(
        performanceDefinition(
          `                  workload:\n                    operations:\n                      - bounds:\n                          forSeconds: "60"`,
        ),
      ),
    (err: unknown) => err instanceof InvalidDefinitionError && /either "op"/.test(err.message),
  );
});

test("rejects a variable that isn't a scalar", () => {
  assert.throws(
    () =>
      parseDefinition(
        performanceDefinition(`${GET_WORKLOAD_ONLY}\n                  variables:\n                    forSeconds:\n                      nested: 1`),
      ),
    (err: unknown) => err instanceof InvalidDefinitionError && /string, number or boolean/.test(err.message),
  );
});

test("rejects a performance run that also carries tests", () => {
  const bad = performanceDefinition(GET_WORKLOAD).replace(
    "              - type: performance",
    "              - type: performance\n                tests:\n                  presets: [all]",
  );
  assert.throws(
    () => parseDefinition(bad),
    (err: unknown) => err instanceof InvalidDefinitionError && /tests/.test(err.message),
  );
});

test("rejects a performance run under clusterlessSessions", () => {
  const bad = `
version: 1
type: fit
instances:
  - localhost: {}
    setup:
      cbdinocluster:
        init:
          args: "--auto"
    clusters: []
    clusterlessSessions:
      - performer:
          image: java-fit-performer:main
        runs:
          - type: performance
            performance:
              workload:
                operations:
                  - op: get
                    bounds:
                      forSeconds: "60"
`;
  assert.throws(
    () => parseDefinition(bad),
    (err: unknown) => err instanceof InvalidDefinitionError && /cannot be "performance" under clusterlessSessions/.test(err.message),
  );
});

test("rejects a performance run paired with an Analytics SDK performer", () => {
  const bad = performanceDefinition(GET_WORKLOAD).replace("java-fit-performer:main", "columnar-java-fit-performer:main");
  assert.throws(
    () => parseDefinition(bad),
    (err: unknown) => err instanceof InvalidDefinitionError && /only run "analytics-functional" tests/.test(err.message),
  );
});
