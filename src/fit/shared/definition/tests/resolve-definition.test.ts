import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildExecutionGroups,
  resolveConnectionCluster,
  resolveDefinition,
  resolveDefinitionRefs,
  resolveFitConfigCluster,
  resolveMavenArgs,
  resolveInstancePlan,
  resolveSession,
  resolveSituationalMavenArgs,
} from "../resolve-definition.js";
import {
  ANALYTICS_MAVEN_TEST_ARGS,
  DEFAULT_MAVEN_TEST_ARGS,
  SITUATIONAL_CNG_MAVEN_TEST_ARGS,
  SITUATIONAL_MAVEN_TEST_ARGS,
} from "../../run-test-driver/run-test-driver.js";
import { DEFAULT_PERFORMER_PORT } from "../../../performers/util/performer-port.js";
import type { FitDefinition, InstanceLifetime, SessionLifetime } from "../types.js";

const LOCAL_FIT_CONFIG = {
  clusterAccess: {
    connectionString: "couchbase://localhost",
    username: "Administrator",
    password: "password",
    tls: null,
  },
};

function definition(): FitDefinition {
  return {
    version: 1,
    type: "fit",
    instances: [
      {
        localhost: {},
        clusters: [
          {
            connection: {
              connectionString: "couchbase://localhost",
              username: "Administrator",
              password: "password",
              tls: null,
            },
            sessions: [
              {
                performer: { image: "java-fit-performer:main" },
                runs: [{ type: "functional", tests: {}, fitConfig: { config: { excludeTests: ["openshift"] } } }],
              },
            ],
          },
        ],
      },
    ],
  };
}

test("resolves a cluster.connection cluster", () => {
  const cluster = resolveConnectionCluster({
    connectionString: "couchbase://localhost",
    username: "Administrator",
    password: "password",
    tls: null,
  });
  assert.deepEqual(cluster, {
    scheme: "couchbase",
    defaultHostname: "localhost",
    flavour: "self-managed",
    credentials: { username: "Administrator", password: "password" },
    tls: null,
  });
});

test("resolves a cluster fitConfig clusterAccess block", () => {
  const cluster = resolveFitConfigCluster({ config: LOCAL_FIT_CONFIG });
  assert.equal(cluster?.defaultHostname, "localhost");
});

test("resolveDefinition preserves instance, cluster, session, and run nesting", () => {
  const resolved = resolveDefinition(definition());
  assert.equal(resolved.instances.length, 1);
  assert.equal(resolved.instances[0]?.clusters.length, 1);
  assert.equal(resolved.instances[0]?.clusters[0]?.sessions.length, 1);
  assert.equal(resolved.instances[0]?.clusters[0]?.sessions[0]?.runs.length, 1);
});

test("an analytics-functional run resolves into the functional group carrying the analytics marker + analytics maven args", () => {
  const def: FitDefinition = {
    version: 1,
    type: "fit",
    instances: [
      {
        localhost: {},
        clusters: [
          {
            // cbdino wire flag `columnar: true` = a self-managed Enterprise Analytics cluster.
            cbdinocluster: {
              config: { columnar: true, nodes: [{ count: 2, version: "2.2.0-1166" }] },
            },
            sessions: [
              {
                performer: { image: "columnar-java-fit-performer:main" },
                runs: [{ type: "analytics-functional", tests: {} }],
              },
            ],
          },
        ],
      },
    ],
  };
  const groups = buildExecutionGroups(resolveDefinition(def).instances);
  assert.equal(groups.length, 1);
  const group = groups[0];
  assert.equal(group?.type, "functional");
  if (group?.type !== "functional") return;
  assert.equal(group.clusterMode, "cbdinocluster");
  const run = group.sessions[0]?.runs[0];
  assert.equal(run?.type, "functional");
  assert.equal(run?.analytics, true);
  assert.equal(run?.sdk.value, "columnar-java");
  assert.deepEqual(run?.extraMavenArgs, [...ANALYTICS_MAVEN_TEST_ARGS]);
});

test("resolveSession applies performer defaults and strips redundant clusterAccess for connection mode", () => {
  const resolved = resolveSession(
    {
      performer: { image: "java-fit-performer:main" },
      runs: [
        {
          type: "functional",
          fitConfig: {
            config: {
              clusterAccess: LOCAL_FIT_CONFIG.clusterAccess,
              excludeTests: ["openshift"],
            },
          },
          tests: {},
        },
      ],
    } satisfies SessionLifetime,
    { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0 },
    true,
  );
  assert.equal(resolved.performerPort, DEFAULT_PERFORMER_PORT);
  assert.deepEqual(resolved.runs[0]?.fitConfig, { config: { excludeTests: ["openshift"] } });
});

test("resolveDefinition uses run-level fitConfig for useExisting clusters", () => {
  const resolved = resolveDefinition({
    version: 1,
    type: "fit",
    instances: [
      {
        localhost: {},
        clusters: [
          {
            useExisting: {},
            sessions: [{ performer: { image: "java-fit-performer:main" }, runs: [{ type: "functional", tests: {}, fitConfig: { config: LOCAL_FIT_CONFIG } }] }],
          },
        ],
      },
    ],
  });
  assert.equal(resolved.instances[0]?.clusters[0]?.clusterMode, "useExisting");
  assert.equal(resolved.instances[0]?.clusters[0]?.cluster?.defaultHostname, "localhost");
});

test("packages are expanded to Maven wildcard selectors", () => {
  const resolved = resolveDefinition({
    version: 1,
    type: "fit",
    instances: [
      {
        localhost: {},
        clusters: [
          {
            connection: {
              connectionString: "couchbase://localhost",
              username: "Administrator",
              password: "password",
              tls: null,
            },
            sessions: [
              {
                performer: { image: "java-fit-performer:main" },
                runs: [{ type: "functional", tests: { packages: ["com.couchbase.client.kv", "com.couchbase.transactions"] } }],
              },
            ],
          },
        ],
      },
    ],
  });
  const testSelection = resolved.instances[0]?.clusters[0]?.sessions[0]?.runs[0]?.testSelection;
  assert.equal(testSelection?.mavenTestSelector, "com.couchbase.client.kv.**,com.couchbase.transactions.**");
});

test("packages combined with classes produce a unified selector", () => {
  const resolved = resolveDefinition({
    version: 1,
    type: "fit",
    instances: [
      {
        localhost: {},
        clusters: [
          {
            connection: {
              connectionString: "couchbase://localhost",
              username: "Administrator",
              password: "password",
              tls: null,
            },
            sessions: [
              {
                performer: { image: "java-fit-performer:main" },
                runs: [{ type: "functional", tests: { packages: ["com.couchbase.client.kv"], classes: ["com.couchbase.other.ExplicitTest"] } }],
              },
            ],
          },
        ],
      },
    ],
  });
  const testSelection = resolved.instances[0]?.clusters[0]?.sessions[0]?.runs[0]?.testSelection;
  assert.equal(testSelection?.mavenTestSelector, "com.couchbase.other.ExplicitTest,com.couchbase.client.kv.**");
});

test("excludedGroups override the default Maven args", () => {
  assert.deepEqual(resolveMavenArgs({ excludedGroups: ["situational", "openshift"] }), [
    "-DexcludedGroups=situational,openshift",
  ]);
});

test("omitting excludedGroups keeps the default Maven args", () => {
  assert.deepEqual(resolveMavenArgs({}), [...DEFAULT_MAVEN_TEST_ARGS]);
});

test("addToDefaultExcludedGroups appends to the default functional exclusions", () => {
  assert.deepEqual(resolveMavenArgs({ addToDefaultExcludedGroups: ["protostellarWillWorkLater"] }), [
    "-DexcludedGroups=situational,openshift,syncgateway,protostellarWillWorkLater",
  ]);
});

test("addToDefaultExcludedGroups appends to the default situational exclusions", () => {
  assert.deepEqual(resolveSituationalMavenArgs({ addToDefaultExcludedGroups: ["protostellarWillWorkLater"] }, false), [
    "-Dgroups=situational,cbDino",
    "-DexcludedGroups=openshift,capella,protostellarWillWorkLater",
  ]);
});

test("situational runs use the situational Maven args", () => {
  assert.deepEqual(resolveSituationalMavenArgs({}, false), [...SITUATIONAL_MAVEN_TEST_ARGS]);
  assert.deepEqual(resolveSituationalMavenArgs({ excludedGroups: ["openshift"] }, false), [
    "-Dgroups=situational,cbDino",
    "-DexcludedGroups=openshift",
  ]);
});

test("situational CNG runs select the openshift-tagged tests instead of cbDino", () => {
  assert.deepEqual(resolveSituationalMavenArgs({}, true), [...SITUATIONAL_CNG_MAVEN_TEST_ARGS]);
  assert.deepEqual(resolveSituationalMavenArgs({ addToDefaultExcludedGroups: ["protostellarWillWorkLater"] }, true), [
    "-Dgroups=situational,openshift",
    "-DexcludedGroups=cbDino,capella,protostellarWillWorkLater",
  ]);
});

test("resolveDefinitionRefs replaces clusterConfig string ref with inline fields", () => {
  const def = resolveDefinitionRefs({
    version: 1,
    type: "fit",
    instances: [
      {
        localhost: {},
        clusters: [
          {
            clusterConfig: "cluster-0",
            sessions: [{ performer: { image: "java-fit-performer:main" }, runs: [{ type: "functional", tests: {} }] }],
          },
        ],
      },
    ],
    clusterConfigs: [
      {
        id: "cluster-0",
        cbdinocluster: {
          config: { nodes: [{ count: 1, version: "8.1.0-2188", services: ["kv"] }] },
        },
      },
    ],
  });
  const cluster = def.instances[0]?.clusters[0];
  assert.ok(cluster?.cbdinocluster, "ref should be replaced with inline cbdinocluster");
  assert.equal(cluster?.clusterConfig, undefined);
  assert.equal(def.clusterConfigs, undefined);
});

test("resolveDefinitionRefs replaces fitConfig string ref with inline config", () => {
  const fitConfigData = { clusterAccess: { connectionString: "couchbase://localhost", username: "Administrator", password: "password", tls: null } };
  const def = resolveDefinitionRefs({
    version: 1,
    type: "fit",
    instances: [
      {
        localhost: {},
        clusters: [
          {
            connection: { connectionString: "couchbase://localhost", username: "Administrator", password: "password", tls: null },
            sessions: [{ performer: { image: "java-fit-performer:main" }, runs: [{ type: "functional", fitConfig: "fit-config-0", tests: {} }] }],
          },
        ],
      },
    ],
    fitConfigs: [{ id: "fit-config-0", config: fitConfigData }],
  });
  const run = def.instances[0]?.clusters[0]?.sessions[0]?.runs[0];
  assert.deepEqual(run?.fitConfig, { config: fitConfigData });
  assert.equal(def.fitConfigs, undefined);
});

test("resolveDefinitionRefs throws on unknown clusterConfig ref", () => {
  assert.throws(
    () =>
      resolveDefinitionRefs({
        version: 1,
        type: "fit",
        instances: [
          {
            localhost: {},
            clusters: [
              {
                clusterConfig: "nonexistent",
                sessions: [{ performer: { image: "java-fit-performer:main" }, runs: [{ type: "functional", tests: {} }] }],
              },
            ],
          },
        ],
      }),
    /nonexistent/,
  );
});

test("resolveDefinitionRefs throws on unknown fitConfig ref", () => {
  assert.throws(
    () =>
      resolveDefinitionRefs({
        version: 1,
        type: "fit",
        instances: [
          {
            localhost: {},
            clusters: [
              {
                connection: { connectionString: "couchbase://localhost", username: "Administrator", password: "password", tls: null },
                sessions: [{ performer: { image: "java-fit-performer:main" }, runs: [{ type: "functional", fitConfig: "nonexistent", tests: {} }] }],
              },
            ],
          },
        ],
      }),
    /nonexistent/,
  );
});

test("dirSegments are populated through instance → cluster → session → run", () => {
  const instance: InstanceLifetime = {
    aws: {},
    clusters: [
      {
        cbdinocluster: { config: { nodes: [{ version: "8.0-stable", count: 1, services: ["kv"] }] } },
        sessions: [
          {
            performer: { image: "java-fit-performer:main" },
            runs: [{ type: "functional", tests: { presets: ["standard-qe"] } }],
          },
        ],
      },
    ],
  };
  const plan = resolveInstancePlan(instance, 0);
  const groups = buildExecutionGroups([plan]);
  const group = groups[0];
  assert.ok(group);
  assert.equal(group.path.dirSegments?.instance, "aws1");
  assert.equal(group.path.dirSegments?.cluster, "8.0-stable");
  const run = group.type === "functional" ? group.sessions[0]?.runs[0] : undefined;
  assert.ok(run);
  assert.equal(run.path.dirSegments?.instance, "aws1");
  assert.equal(run.path.dirSegments?.cluster, "8.0-stable");
  assert.equal(run.path.dirSegments?.session, "java:main");
  assert.equal(run.path.dirSegments?.run, "functional:standard-qe");
});

test("repeat expands a run into N sequential copies with distinct runIndex values", () => {
  const session: SessionLifetime = {
    performer: { image: "java-fit-performer:main" },
    runs: [{ type: "functional", tests: { classes: ["com.example.MyTest"] }, repeat: 3 }],
  };
  const resolved = resolveSession(session, { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0 }, false);
  assert.equal(resolved.runs.length, 3);
  assert.equal(resolved.runs[0]?.path.runIndex, 0);
  assert.equal(resolved.runs[1]?.path.runIndex, 1);
  assert.equal(resolved.runs[2]?.path.runIndex, 2);
});

test("repeat appends :r1/:r2/... to the run dir segment to avoid collisions", () => {
  const session: SessionLifetime = {
    performer: { image: "java-fit-performer:main" },
    runs: [{ type: "functional", tests: { classes: ["com.example.MyTest"] }, repeat: 3 }],
  };
  const resolved = resolveSession(session, { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0 }, false);
  assert.equal(resolved.runs[0]?.path.dirSegments?.run, "functional:r1");
  assert.equal(resolved.runs[1]?.path.dirSegments?.run, "functional:r2");
  assert.equal(resolved.runs[2]?.path.dirSegments?.run, "functional:r3");
});

test("run without repeat produces no :rN suffix and a single entry", () => {
  const session: SessionLifetime = {
    performer: { image: "java-fit-performer:main" },
    runs: [{ type: "functional", tests: { classes: ["com.example.MyTest"] } }],
  };
  const resolved = resolveSession(session, { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0 }, false);
  assert.equal(resolved.runs.length, 1);
  assert.equal(resolved.runs[0]?.path.dirSegments?.run, "functional");
});

test("repeat mixes correctly with non-repeated runs in the same session", () => {
  const session: SessionLifetime = {
    performer: { image: "java-fit-performer:main" },
    runs: [
      { type: "functional", tests: { classes: ["com.example.Setup"] } },
      { type: "functional", tests: { classes: ["com.example.Flaky"] }, repeat: 2 },
    ],
  };
  const resolved = resolveSession(session, { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0 }, false);
  assert.equal(resolved.runs.length, 3);
  assert.equal(resolved.runs[0]?.path.runIndex, 0);
  assert.equal(resolved.runs[0]?.path.dirSegments?.run, "functional");
  assert.equal(resolved.runs[1]?.path.runIndex, 1);
  assert.equal(resolved.runs[1]?.path.dirSegments?.run, "functional:r1");
  assert.equal(resolved.runs[2]?.path.runIndex, 2);
  assert.equal(resolved.runs[2]?.path.dirSegments?.run, "functional:r2");
});

test("versions expands a situational run into one copy per version with distinct runIndex values", () => {
  const session: SessionLifetime = {
    performer: { image: "java-fit-performer:main" },
    runs: [
      {
        type: "situational",
        tests: { classes: ["com.example.MyTest"] },
        situational: {},
        versions: ["8.0-stable", "7.6"],
      },
    ],
  };
  const resolved = resolveSession(session, { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0 }, false);
  assert.equal(resolved.runs.length, 2);
  assert.equal(resolved.runs[0]?.path.runIndex, 0);
  assert.equal(resolved.runs[1]?.path.runIndex, 1);
  const run0 = resolved.runs[0];
  const run1 = resolved.runs[1];
  assert.equal(run0?.type === "situational" ? run0.version : undefined, "8.0-stable");
  assert.equal(run1?.type === "situational" ? run1.version : undefined, "7.6");
});

test("versions appends :v{version} to the run dir segment to avoid collisions", () => {
  const session: SessionLifetime = {
    performer: { image: "java-fit-performer:main" },
    runs: [
      {
        type: "situational",
        tests: { classes: ["com.example.MyTest"] },
        situational: {},
        versions: ["8.0-stable", "7.6"],
      },
    ],
  };
  const resolved = resolveSession(session, { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0 }, false);
  assert.equal(resolved.runs[0]?.path.dirSegments?.run, "situational:v8.0-stable");
  assert.equal(resolved.runs[1]?.path.dirSegments?.run, "situational:v7.6");
});
