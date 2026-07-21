import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InvalidDefinitionError,
  UnsupportedDefinitionVersionError,
  parseDefinition,
} from "../parse-definition.js";
import { CURRENT_FIT_DEFINITION_VERSION } from "../types.js";

const FUNCTIONAL = `
version: 1
type: fit
setup:
  repos:
    transactions-fit-performer:
      gerritRef: refs/changes/29/246329/1
instances:
  - aws:
      instanceType: c5.4xlarge
    clusters:
      - connection:
          connectionString: couchbase://localhost
          username: Administrator
          password: password
          tls: null
        sessions:
          - performer:
              image: java-fit-performer:main
            runs:
              - type: functional
                tests:
                  presets: [all]
`;

test("parses a minimal nested functional definition", () => {
  const def = parseDefinition(FUNCTIONAL);
  assert.equal(def.version, CURRENT_FIT_DEFINITION_VERSION);
  assert.equal(def.type, "fit");
  assert.equal(def.setup?.repos?.["transactions-fit-performer"]?.gerritRef, "refs/changes/29/246329/1");
  assert.equal(def.instances.length, 1);
  assert.ok(def.instances[0] && "aws" in def.instances[0]);
  assert.deepEqual(def.instances[0].aws, { instanceType: "c5.4xlarge" });
  assert.equal(def.instances[0]?.clusters[0]?.sessions[0]?.performer.image, "java-fit-performer:main");
  assert.equal(def.instances[0]?.clusters[0]?.sessions[0]?.runs[0]?.type, "functional");
});

test("parses a gcp instance", () => {
  const def = FUNCTIONAL.replace("- aws:\n      instanceType: c5.4xlarge", "- gcp:\n      instanceType: n2-standard-8");
  const parsed = parseDefinition(def);
  assert.ok(parsed.instances[0] && "gcp" in parsed.instances[0]);
  assert.deepEqual(parsed.instances[0].gcp, { instanceType: "n2-standard-8" });
});

test("parses a gcp instance with privateEndpoint", () => {
  const def = FUNCTIONAL.replace("- aws:\n      instanceType: c5.4xlarge", "- gcp:\n      privateEndpoint: {}");
  const parsed = parseDefinition(def);
  assert.ok(parsed.instances[0] && "gcp" in parsed.instances[0]);
  assert.deepEqual(parsed.instances[0].gcp, { privateEndpoint: {} });
});

test("rejects a gcp instance with a non-empty privateEndpoint", () => {
  const def = FUNCTIONAL.replace("- aws:\n      instanceType: c5.4xlarge", "- gcp:\n      privateEndpoint: { foo: bar }");
  assert.throws(() => parseDefinition(def), InvalidDefinitionError);
});

test("parses addToDefaultExcludedGroups on a functional run", () => {
  const def = parseDefinition(
    FUNCTIONAL.replace("presets: [all]", "presets: [all]\n                  addToDefaultExcludedGroups: [protostellarWillWorkLater]"),
  );
  assert.deepEqual(
    def.instances[0]?.clusters[0]?.sessions[0]?.runs[0] &&
      "tests" in def.instances[0].clusters[0].sessions[0].runs[0]
      ? def.instances[0].clusters[0].sessions[0].runs[0].tests.addToDefaultExcludedGroups
      : undefined,
    ["protostellarWillWorkLater"],
  );
});

test("rejects setting both excludedGroups and addToDefaultExcludedGroups", () => {
  const def = FUNCTIONAL.replace(
    "presets: [all]",
    "presets: [all]\n                  excludedGroups: [openshift]\n                  addToDefaultExcludedGroups: [protostellarWillWorkLater]",
  );
  assert.throws(
    () => parseDefinition(def),
    (err: unknown) => err instanceof InvalidDefinitionError && /mutually exclusive/.test(err.message),
  );
});

test("accepts the Python performer image", () => {
  const def = FUNCTIONAL.replace("image: java-fit-performer:main", "image: python-fit-performer:main");
  assert.equal(parseDefinition(def).instances[0]?.clusters[0]?.sessions[0]?.performer.image, "python-fit-performer:main");
});

test("rejects a performer image for an SDK FIT doesn't know", () => {
  const def = FUNCTIONAL.replace("image: java-fit-performer:main", "image: php-fit-performer:main");
  assert.throws(() => parseDefinition(def), /Unknown SDK "php"/);
});

test("rejects the legacy performer sdk/version fields", () => {
  const def = FUNCTIONAL.replace("image: java-fit-performer:main", "sdk: java");
  assert.throws(() => parseDefinition(def), /no longer takes "sdk"\/"version"/);
});

test("parses clusterless situational sessions", () => {
  const def = parseDefinition(`
version: 1
type: fit
instances:
  - localhost: {}
    setup:
      cbdinocluster:
        init:
          config:
            version: 6
    clusters: []
    clusterlessSessions:
      - performer:
          image: java-fit-performer:main
        runs:
          - type: situational
            situational:
              database:
                mode: hosted
            tests:
              presets: [all]
`);
  assert.equal(def.instances[0]?.clusterlessSessions?.[0]?.runs[0]?.type, "situational");
});

test("parses a gcp instance with a situational privateEndpoint run", () => {
  const def = parseDefinition(`
version: 1
type: fit
instances:
  - gcp:
      privateEndpoint: {}
    setup:
      cbdinocluster:
        init:
          config:
            version: 6
    clusters: []
    clusterlessSessions:
      - performer:
          image: java-fit-performer:main
        runs:
          - type: situational
            situational:
              database:
                mode: hosted
              privateEndpoint: {}
            tests:
              presets: [all]
`);
  assert.ok(def.instances[0] && "gcp" in def.instances[0]);
  assert.deepEqual(def.instances[0].gcp, { privateEndpoint: {} });
  const run = def.instances[0]?.clusterlessSessions?.[0]?.runs[0];
  assert.ok(run?.type === "situational");
  assert.deepEqual(run.situational.privateEndpoint, {});
});

const FUNCTIONAL_WITH_INIT_ARGS = `
version: 1
type: fit
instances:
  - aws: {}
    setup:
      cbdinocluster:
        init:
          args: "--auto --disable-k8s --docker-network fit"
    clusters:
      - cbdinocluster:
          config:
            nodes:
              - count: 1
                version: "8.1.0"
                services: [kv]
        sessions:
          - performer:
              image: java-fit-performer:main
            runs:
              - type: functional
                tests:
                  presets: [all]
`;

test("parses a per-instance cbdinocluster init args string", () => {
  const def = parseDefinition(FUNCTIONAL_WITH_INIT_ARGS);
  assert.equal(
    def.instances[0]?.setup?.cbdinocluster?.init?.args,
    "--auto --disable-k8s --docker-network fit",
  );
  assert.equal(def.instances[0]?.setup?.cbdinocluster?.init?.config, undefined);
});

test("rejects a cbdinocluster init with both args and config", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
instances:
  - aws: {}
    setup:
      cbdinocluster:
        init:
          args: "--auto"
          config:
            version: 6
    clusters:
      - cbdinocluster:
          config:
            nodes:
              - count: 1
                version: "8.1.0"
                services: [kv]
        sessions:
          - performer:
              image: java-fit-performer:main
            runs:
              - type: functional
                tests:
                  presets: [all]
`),
    (err: unknown) => err instanceof InvalidDefinitionError && /exactly one of "args" or "config"/.test(err.message),
  );
});

test("rejects a cbdinocluster init with neither args nor config", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
instances:
  - aws: {}
    setup:
      cbdinocluster:
        init: {}
    clusters:
      - cbdinocluster:
          config:
            nodes:
              - count: 1
                version: "8.1.0"
                services: [kv]
        sessions:
          - performer:
              image: java-fit-performer:main
            runs:
              - type: functional
                tests:
                  presets: [all]
`),
    (err: unknown) => err instanceof InvalidDefinitionError && /args/.test(err.message),
  );
});

test("accepts setup.cbdinocluster without init (init is optional)", () => {
  const def = parseDefinition(`
version: 1
type: fit
instances:
  - aws: {}
    setup:
      cbdinocluster: {}
    clusters:
      - cbdinocluster:
          config:
            nodes:
              - count: 1
                version: "8.1.0"
                services: [kv]
        sessions:
          - performer:
              image: java-fit-performer:main
            runs:
              - type: functional
                tests:
                  presets: [all]
`);
  assert.equal(def.instances[0]?.setup?.cbdinocluster?.init, undefined);
});

test("rejects cbdinocluster init left on a cluster config (moved to instance.setup)", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
instances:
  - aws: {}
    clusters:
      - cbdinocluster:
          init:
            args: "--auto"
          config:
            nodes:
              - count: 1
                version: "8.1.0"
                services: [kv]
        sessions:
          - performer:
              image: java-fit-performer:main
            runs:
              - type: functional
                tests:
                  presets: [all]
`),
    (err: unknown) => err instanceof InvalidDefinitionError && /setup\.cbdinocluster\.init/.test(err.message),
  );
});

test("rejects missing instances in the new schema", () => {
  assert.throws(
    () => parseDefinition("version: 1\ntype: fit\n"),
    (err: unknown) => err instanceof InvalidDefinitionError && /instances/.test(err.message),
  );
});

test("rejects empty instances", () => {
  assert.throws(
    () => parseDefinition("version: 1\ntype: fit\ninstances: []\n"),
    InvalidDefinitionError,
  );
});

test("rejects legacy cycles", () => {
  assert.throws(
    () => parseDefinition("version: 1\ntype: fit\ncycles: []\n"),
    (err: unknown) => err instanceof InvalidDefinitionError && /cycles/.test(err.message),
  );
});

test("rejects legacy iterations", () => {
  assert.throws(
    () => parseDefinition("version: 1\ntype: fit\niterations: []\n"),
    (err: unknown) => err instanceof InvalidDefinitionError && /iterations/.test(err.message),
  );
});

test("rejects a clusterless functional run", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
instances:
  - localhost: {}
    setup:
      cbdinocluster:
        init:
          config: {}
    clusters: []
    clusterlessSessions:
      - performer:
          image: java-fit-performer:main
        runs:
          - type: functional
            tests:
              presets: [all]
`),
    InvalidDefinitionError,
  );
});

test("parses clusterless sessions without explicit cbdinocluster init", () => {
  // init args are generated at runtime; no setup block is required in the definition.
  const def = parseDefinition(`
version: 1
type: fit
instances:
  - localhost: {}
    clusters: []
    clusterlessSessions:
      - performer:
          image: java-fit-performer:main
        runs:
          - type: situational
            situational:
              database:
                mode: local
            tests:
              presets: [all]
`);
  assert.equal(def.instances[0]?.clusterlessSessions?.[0]?.runs[0]?.type, "situational");
  assert.equal(def.instances[0]?.setup, undefined);
});

test("rejects unsupported future versions", () => {
  assert.throws(
    () => parseDefinition(`version: ${CURRENT_FIT_DEFINITION_VERSION + 1}\ntype: fit\ninstances: []\n`),
    UnsupportedDefinitionVersionError,
  );
});

test("parses clusterConfig string ref and fitConfig string ref at run level", () => {
  const def = parseDefinition(`
version: 1
type: fit
instances:
  - localhost: {}
    clusters:
      - clusterConfig: "cluster-0"
        sessions:
          - performer:
              image: java-fit-performer:main
            runs:
              - type: functional
                fitConfig: "fit-config-0"
                tests:
                  presets: [all]
clusterConfigs:
  - id: "cluster-0"
    cbdinocluster:
      config:
        nodes:
          - count: 1
            version: 8.1.0-2188
            services: [kv]
fitConfigs:
  - id: "fit-config-0"
    config:
      clusterAccess:
        connectionString: couchbase://\${defaultHostname}
        username: Administrator
        password: password
        tls: null
`);
  assert.equal(def.instances[0]?.clusters[0]?.clusterConfig, "cluster-0");
  assert.equal(def.instances[0]?.clusters[0]?.sessions[0]?.runs[0]?.fitConfig, "fit-config-0");
  assert.equal(def.clusterConfigs?.[0]?.id, "cluster-0");
  assert.equal(def.fitConfigs?.[0]?.id, "fit-config-0");
});

test("parses docker per-service RAM quotas on a cbdinocluster config", () => {
  const def = parseDefinition(`
version: 1
type: fit
instances:
  - localhost: {}
    clusters:
      - cbdinocluster:
          config:
            nodes:
              - count: 3
                version: 8.1.0-2188
                services: [kv, fts]
            docker:
              kv-memory: 4096
              fts-memory: 4096
        sessions:
          - performer:
              image: java-fit-performer:main
            runs:
              - type: functional
                tests:
                  presets: [all]
`);
  assert.deepEqual(def.instances[0]?.clusters[0]?.cbdinocluster?.config.docker, {
    "kv-memory": 4096,
    "fts-memory": 4096,
  });
});

test("passes the cbdinocluster config block through verbatim, including unmodelled keys", () => {
  const def = parseDefinition(`
version: 1
type: fit
instances:
  - localhost: {}
    clusters:
      - cbdinocluster:
          config:
            nodes:
              - count: 1
                version: 8.1.0-2188
                services: [kv]
                extra-node-key: keep-me
            docker:
              kv-memory: 4096
            columnar: true
            some-future-cbdino-key:
              nested: value
        sessions:
          - performer:
              image: java-fit-performer:main
            runs:
              - type: functional
                tests:
                  presets: [all]
`);
  // The whole block is forwarded as-is — fit-cli neither strips unknown top-level
  // keys nor reshapes nodes — so the cbdinocluster CLI sees exactly what was written.
  assert.deepEqual(def.instances[0]?.clusters[0]?.cbdinocluster?.config, {
    nodes: [{ count: 1, version: "8.1.0-2188", services: ["kv"], "extra-node-key": "keep-me" }],
    docker: { "kv-memory": 4096 },
    columnar: true,
    "some-future-cbdino-key": { nested: "value" },
  });
});

test("rejects clusterConfig mixed with inline cluster fields", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
instances:
  - localhost: {}
    clusters:
      - clusterConfig: "cluster-0"
        cbdinocluster:
          config:
            nodes:
              - count: 1
                version: 8.1.0-2188
                services: [kv]
        sessions:
          - performer:
              image: java-fit-performer:main
            runs:
              - type: functional
                tests:
                  presets: [all]
clusterConfigs: []
`),
    (err: unknown) => err instanceof InvalidDefinitionError && /mix/.test(err.message),
  );
});

test("rejects duplicate clusterConfigs ids", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
instances:
  - localhost: {}
    clusters:
      - clusterConfig: "cluster-0"
        sessions:
          - performer:
              image: java-fit-performer:main
            runs:
              - type: functional
                tests:
                  presets: [all]
clusterConfigs:
  - id: "cluster-0"
    cbdinocluster:
      config:
        nodes:
          - count: 1
            version: 8.1.0-2188
            services: [kv]
  - id: "cluster-0"
    cbdinocluster:
      config:
        nodes:
          - count: 1
            version: 8.1.0-2188
            services: [kv]
`),
    (err: unknown) => err instanceof InvalidDefinitionError && /[Dd]uplicate/.test(err.message),
  );
});

test("rejects duplicate fitConfigs ids", () => {
  assert.throws(
    () =>
      parseDefinition(`
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
              - type: functional
                tests:
                  presets: [all]
fitConfigs:
  - id: "fit-config-0"
    config:
      key: value
  - id: "fit-config-0"
    config:
      key: other
`),
    (err: unknown) => err instanceof InvalidDefinitionError && /[Dd]uplicate/.test(err.message),
  );
});

function definitionWithTests(testsBody: string): string {
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
              - type: functional
                tests:
${testsBody}
`;
}

test("parses packages list", () => {
  const def = parseDefinition(
    definitionWithTests(
      `                  packages:\n                    - com.couchbase.client.kv\n                    - com.couchbase.transactions`,
    ),
  );
  const tests = def.instances[0]?.clusters[0]?.sessions[0]?.runs[0]?.tests;
  assert.deepEqual(tests?.packages, ["com.couchbase.client.kv", "com.couchbase.transactions"]);
});

test("rejects an empty packages list", () => {
  assert.throws(
    () => parseDefinition(definitionWithTests(`                  packages: []`)),
    (err: unknown) => err instanceof InvalidDefinitionError && /packages/.test(err.message),
  );
});

test("parses all-transactions and all-non-transactions preset placeholders", () => {
  for (const preset of ["all-transactions", "all-non-transactions"] as const) {
    const def = parseDefinition(definitionWithTests(`                  presets: [${preset}]`));
    assert.deepEqual(def.instances[0]?.clusters[0]?.sessions[0]?.runs[0]?.tests.presets, [preset]);
  }
});

test("parses presets unioned with explicit classes", () => {
  const def = parseDefinition(
    definitionWithTests(
      `                  presets: [all-non-transactions]\n                  classes:\n                    - com.couchbase.transactions.FooTest`,
    ),
  );
  const tests = def.instances[0]?.clusters[0]?.sessions[0]?.runs[0]?.tests;
  assert.deepEqual(tests?.presets, ["all-non-transactions"]);
  assert.deepEqual(tests?.classes, ["com.couchbase.transactions.FooTest"]);
});

test("rejects an unknown preset", () => {
  assert.throws(
    () => parseDefinition(definitionWithTests(`                  presets: [all-unknown]`)),
    (err: unknown) => err instanceof InvalidDefinitionError && /presets/.test(err.message),
  );
});

test("rejects the legacy tests.run key", () => {
  assert.throws(
    () => parseDefinition(definitionWithTests(`                  run: all`)),
    (err: unknown) => err instanceof InvalidDefinitionError && /run.*no longer supported/.test(err.message),
  );
});

test("parses repeat on a functional run", () => {
  const def = parseDefinition(FUNCTIONAL.replace("presets: [all]", "presets: [all]\n                repeat: 5"));
  assert.equal(def.instances[0]?.clusters[0]?.sessions[0]?.runs[0]?.repeat, 5);
});

test("rejects repeat: 0", () => {
  assert.throws(
    () => parseDefinition(FUNCTIONAL.replace("presets: [all]", "presets: [all]\n                repeat: 0")),
    (err: unknown) => err instanceof InvalidDefinitionError && /repeat/.test(err.message),
  );
});

test("rejects non-integer repeat", () => {
  assert.throws(
    () => parseDefinition(FUNCTIONAL.replace("presets: [all]", "presets: [all]\n                repeat: 1.5")),
    (err: unknown) => err instanceof InvalidDefinitionError && /repeat/.test(err.message),
  );
});

const SITUATIONAL = `
version: 1
type: fit
instances:
  - localhost: {}
    clusters: []
    clusterlessSessions:
      - performer:
          image: java-fit-performer:main
        runs:
          - type: situational
            situational:
              database:
                mode: hosted
            tests:
              presets: [all]
`;

test("parses versions on a situational run, expanding to N sequential runs at resolve time (not here)", () => {
  const def = parseDefinition(SITUATIONAL.replace("presets: [all]", "presets: [all]\n            versions: [8.0-stable, \"7.6\"]"));
  const run = def.instances[0]?.clusterlessSessions?.[0]?.runs[0];
  assert.ok(run && run.type === "situational");
  assert.deepEqual(run.versions, ["8.0-stable", "7.6"]);
});

test("parses situational.version", () => {
  const def = parseDefinition(SITUATIONAL.replace("mode: hosted", "mode: hosted\n              version: 8.0-stable"));
  const run = def.instances[0]?.clusterlessSessions?.[0]?.runs[0];
  assert.ok(run && run.type === "situational");
  assert.equal(run.situational.version, "8.0-stable");
});

test("rejects empty versions array", () => {
  assert.throws(
    () => parseDefinition(SITUATIONAL.replace("presets: [all]", "presets: [all]\n            versions: []")),
    (err: unknown) => err instanceof InvalidDefinitionError && /versions/.test(err.message),
  );
});

test("rejects versions combined with repeat", () => {
  assert.throws(
    () => parseDefinition(SITUATIONAL.replace("presets: [all]", "presets: [all]\n            versions: [8.0-stable]\n            repeat: 2")),
    (err: unknown) => err instanceof InvalidDefinitionError && /mutually exclusive/.test(err.message),
  );
});

test("rejects versions combined with situational.version", () => {
  assert.throws(
    () => parseDefinition(
      SITUATIONAL
        .replace("mode: hosted", "mode: hosted\n              version: \"7.6\"")
        .replace("presets: [all]", "presets: [all]\n            versions: [8.0-stable]"),
    ),
    (err: unknown) => err instanceof InvalidDefinitionError && /mutually exclusive/.test(err.message),
  );
});

test("rejects versions combined with situational.cng", () => {
  assert.throws(
    () => parseDefinition(
      SITUATIONAL
        .replace("mode: hosted", "mode: hosted\n              cng: {}")
        .replace("presets: [all]", "presets: [all]\n            versions: [8.0-stable]"),
    ),
    (err: unknown) => err instanceof InvalidDefinitionError && /CNG pins its own cluster version/.test(err.message),
  );
});

test("rejects situational.version combined with situational.cng", () => {
  assert.throws(
    () => parseDefinition(
      SITUATIONAL.replace("mode: hosted", "mode: hosted\n              version: 8.0-stable\n              cng: {}"),
    ),
    (err: unknown) => err instanceof InvalidDefinitionError && /mutually exclusive/.test(err.message),
  );
});

test("rejects unknown top-level field", () => {
  assert.throws(
    () => parseDefinition(FUNCTIONAL.replace("version: 1", "version: 1\nbad: ignored")),
    (err: unknown) => err instanceof InvalidDefinitionError && /bad/.test(err.message),
  );
});

test("rejects unknown field on an instance", () => {
  assert.throws(
    () => parseDefinition(FUNCTIONAL.replace("    clusters:", "    typo: oops\n    clusters:")),
    (err: unknown) => err instanceof InvalidDefinitionError && /typo/.test(err.message),
  );
});

test("rejects unknown field on a cluster", () => {
  assert.throws(
    () => parseDefinition(FUNCTIONAL.replace("        sessions:", "        oops: true\n        sessions:")),
    (err: unknown) => err instanceof InvalidDefinitionError && /oops/.test(err.message),
  );
});

test("rejects unknown field on a session", () => {
  assert.throws(
    () => parseDefinition(FUNCTIONAL.replace("            runs:", "            oops: true\n            runs:")),
    (err: unknown) => err instanceof InvalidDefinitionError && /oops/.test(err.message),
  );
});

test("rejects unknown field on a run", () => {
  assert.throws(
    () => parseDefinition(FUNCTIONAL.replace("                presets: [all]", "                presets: [all]\n                oops: true")),
    (err: unknown) => err instanceof InvalidDefinitionError && /oops/.test(err.message),
  );
});

test("rejects unknown field on a tests section", () => {
  assert.throws(
    () => parseDefinition(FUNCTIONAL.replace("                presets: [all]", "                presets: [all]\n                badfield: true")),
    (err: unknown) => err instanceof InvalidDefinitionError && /badfield/.test(err.message),
  );
});

test("rejects unknown field on a performer", () => {
  assert.throws(
    () => parseDefinition(FUNCTIONAL.replace("              image: java-fit-performer:main", "              image: java-fit-performer:main\n              oops: true")),
    (err: unknown) => err instanceof InvalidDefinitionError && /oops/.test(err.message),
  );
});

const ANALYTICS_FUNCTIONAL = `
version: 1
type: fit
instances:
  - localhost: {}
    clusters:
      - clusterConfig: cluster-0
        sessions:
          - performer:
              image: columnar-java-fit-performer:main
            runs:
              - type: analytics-functional
                fitConfig: fit-config-0
                tests:
                  presets: [all]
clusterConfigs:
  - id: cluster-0
    cbdinocluster:
      config:
        columnar: true
        nodes:
          - count: 2
            version: 2.2.0-1166
fitConfigs:
  - id: fit-config-0
    config:
      clusterAccess:
        performer:
          connectionString: http://\${defaultHostname}:8095
`;

test("parses an analytics-functional definition", () => {
  const def = parseDefinition(ANALYTICS_FUNCTIONAL);
  const run = def.instances[0]?.clusters[0]?.sessions[0]?.runs[0];
  assert.equal(run?.type, "analytics-functional");
});

test("rejects an analytics-functional run paired with an operational performer", () => {
  const bad = ANALYTICS_FUNCTIONAL.replace("image: analytics-go-fit-performer:main", "image: java-fit-performer:main")
    .replace("image: columnar-java-fit-performer:main", "image: java-fit-performer:main");
  assert.throws(
    () => parseDefinition(bad),
    (err: unknown) =>
      err instanceof InvalidDefinitionError && /analytics-functional.*operational SDK|operational SDK.*analytics/i.test(err.message),
  );
});

test("rejects an operational functional run paired with an Analytics SDK performer", () => {
  const bad = FUNCTIONAL.replace("image: java-fit-performer:main", "image: columnar-java-fit-performer:main");
  assert.throws(
    () => parseDefinition(bad),
    (err: unknown) => err instanceof InvalidDefinitionError && /Analytics SDK.*only run "analytics-functional"/.test(err.message),
  );
});

test("rejects an analytics-functional run under clusterlessSessions", () => {
  const bad = `
version: 1
type: fit
instances:
  - localhost: {}
    clusters: []
    clusterlessSessions:
      - performer:
          image: columnar-java-fit-performer:main
        runs:
          - type: analytics-functional
            tests:
              presets: [all]
`;
  assert.throws(
    () => parseDefinition(bad),
    (err: unknown) =>
      err instanceof InvalidDefinitionError && /cannot be "analytics-functional" under clusterlessSessions/.test(err.message),
  );
});
