import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFitDefinition,
  buildFitFunctionalDefinition,
  buildFitFunctionalDefinitionFrom,
  buildFitSituationalDefinitionFrom,
  formatFitDefinition,
} from "../generate-definition.js";
import { parseDefinition } from "../parse-definition.js";
import {
  buildDefaultFitTestSelection,
  buildFitTestSelectionFromClassNames,
} from "../../select-fit-tests/select-fit-tests.js";
import type { SelectedCluster } from "../../../../cluster/cluster-select/cluster-select.js";
import { sdkByValue } from "../../../../util/sdk/sdks.js";

const sdk = sdkByValue("java");
if (!sdk) {
  throw new Error("Expected the java SDK to exist.");
}

const cluster: SelectedCluster = {
  scheme: "couchbase",
  defaultHostname: "localhost",
  flavour: "self-managed",
  credentials: { username: "Administrator", password: "password" },
  tls: null,
};

test("buildFitFunctionalDefinition emits one instance with one cluster, session, and run", () => {
  const definition = buildFitFunctionalDefinition(sdk, cluster, buildDefaultFitTestSelection());
  assert.equal(definition.instances.length, 1);
  assert.equal(definition.instances[0]?.clusters.length, 1);
  assert.equal(definition.instances[0]?.clusters[0]?.sessions.length, 1);
  assert.equal(definition.instances[0]?.clusters[0]?.sessions[0]?.runs[0]?.type, "functional");
});

test("buildFitFunctionalDefinitionFrom records a cbdinocluster in clusterConfigs (no fitConfig blob)", () => {
  const definition = buildFitFunctionalDefinitionFrom({
    cluster: {
      kind: "cbdinocluster",
      def: { nodeCount: 2, version: "8.1.0-2188", services: ["kv", "n1ql", "index"], cng: false },
    },
    sdk,
    version: "1.2.3",
    gerritRef: "refs/changes/29/246329/1",
    selection: buildDefaultFitTestSelection(),
  });

  assert.equal(definition.setup?.repos?.["transactions-fit-performer"]?.gerritRef, "refs/changes/29/246329/1");
  assert.equal(definition.instances[0]?.clusters[0]?.sessions[0]?.performer.image, "java-fit-performer:1.2.3");

  // Cluster uses a ref, not inline fields
  assert.equal(definition.instances[0]?.clusters[0]?.clusterConfig, "cluster-0");
  assert.equal(definition.instances[0]?.clusters[0]?.cbdinocluster, undefined);

  // cbdinocluster details live in clusterConfigs
  assert.equal(definition.clusterConfigs?.[0]?.id, "cluster-0");
  assert.equal(definition.clusterConfigs?.[0]?.cbdinocluster?.config.nodes[0]?.count, 2);

  // The docker deployer gets a per-service RAM quota emitted automatically (kv
  // here; fts would be added too if selected) so generated definitions don't hit
  // "RAM quota specified is too large" on large-bucket tests.
  assert.deepEqual(definition.clusterConfigs?.[0]?.cbdinocluster?.config.docker, { "kv-memory": 4096 });

  // cbdinocluster init is NOT emitted — args/config are generated at runtime.
  assert.equal(definition.instances[0]?.setup, undefined);

  // No fitConfig ref on the run — the FIT config is fully generated at runtime.
  assert.equal(definition.instances[0]?.clusters[0]?.sessions[0]?.runs[0]?.fitConfig, undefined);
  assert.equal(definition.fitConfigs, undefined);
});

test("buildFitSituationalDefinitionFrom emits clusterless sessions", () => {
  const definition = buildFitSituationalDefinitionFrom({
    sdk,
    onPortInUse: "reuse",
    selection: buildDefaultFitTestSelection(),
  });
  assert.equal(definition.instances[0]?.clusterlessSessions?.[0]?.performer.onPortInUse, "reuse");
  assert.equal(definition.instances[0]?.clusterlessSessions?.[0]?.runs[0]?.type, "situational");
});

test("buildFitSituationalDefinitionFrom emits situational.privateEndpoint when requested", () => {
  const definition = buildFitSituationalDefinitionFrom({
    sdk,
    instance: { aws: { privateEndpoint: {} } },
    selection: buildDefaultFitTestSelection(),
    privateEndpoint: true,
  });
  const run = definition.instances[0]?.clusterlessSessions?.[0]?.runs[0];
  assert.equal(run?.type, "situational");
  assert.deepEqual(run?.type === "situational" ? run.situational.privateEndpoint : undefined, {});
});

test("buildFitSituationalDefinitionFrom omits situational.privateEndpoint by default", () => {
  const definition = buildFitSituationalDefinitionFrom({
    sdk,
    selection: buildDefaultFitTestSelection(),
  });
  const run = definition.instances[0]?.clusterlessSessions?.[0]?.runs[0];
  assert.equal(run?.type, "situational");
  assert.equal(run?.type === "situational" ? run.situational.privateEndpoint : undefined, undefined);
});

test("buildFitDefinition remains round-trippable through the parser (JSON5)", () => {
  const functionalDef = buildFitFunctionalDefinitionFrom({
    cluster: { kind: "connection", cluster },
    sdk,
    selection: buildDefaultFitTestSelection(),
  });
  const functionalInstance = functionalDef.instances[0];
  const situationalInstance = buildFitSituationalDefinitionFrom({
    sdk,
    version: "1.2.3",
    selection: buildFitTestSelectionFromClassNames([
      "com.couchbase.situational.tests.VolumeTest#steadyStateKvGets",
    ]),
  }).instances[0];
  if (!functionalInstance || !situationalInstance) {
    throw new Error("Expected generated definitions to contain one instance.");
  }
  const definition = buildFitDefinition({
    gerritRef: "refs/changes/29/246329/1",
    instances: [functionalInstance, situationalInstance],
    clusterConfigs: functionalDef.clusterConfigs,
  });

  assert.deepEqual(parseDefinition(formatFitDefinition(definition, "json5")), definition);
  assert.deepEqual(parseDefinition(formatFitDefinition(definition, "yaml"), "yaml"), definition);
});

test("formatFitDefinition includes the nested instances key (JSON5)", () => {
  const rendered = formatFitDefinition(
    buildFitFunctionalDefinitionFrom({
      cluster: { kind: "connection", cluster },
      sdk,
      selection: buildDefaultFitTestSelection(),
    }),
    "json5",
  );

  assert.match(rendered, /instances:/);
  assert.doesNotMatch(rendered, /fitConfigs:/);
});

test("formatFitDefinition never leaks comment markers into the output", () => {
  const functional = buildFitFunctionalDefinitionFrom({
    cluster: { kind: "cbdinocluster", def: { cng: false, nodeCount: 1, version: "7.6.0", services: ["kv"] } },
    sdk,
    selection: buildDefaultFitTestSelection(),
  });
  const situational = buildFitSituationalDefinitionFrom({
    sdk,
    selection: buildDefaultFitTestSelection(),
  });
  for (const definition of [functional, situational]) {
    for (const format of ["json5", "yaml"] as const) {
      const rendered = formatFitDefinition(definition, format);
      assert.doesNotMatch(rendered, /\/\/[0-9a-z]{6}/, `${format} output should not contain marker keys`);
    }
  }
});

test("formatFitSituationalDefinition comments the clusterless sessions", () => {
  const rendered = formatFitDefinition(
    buildFitSituationalDefinitionFrom({ sdk, selection: buildDefaultFitTestSelection() }),
    "json5",
  );
  assert.match(rendered, /\/\/ Sessions not tied to any particular cluster/);
  // cbdinocluster init args are no longer in the definition file
  assert.doesNotMatch(rendered, /--aws-region /);
});

test("buildFitFunctionalDefinition emits a preset placeholder when the selection has presets", () => {
  const allNonTransactions: Parameters<typeof buildFitFunctionalDefinition>[2] = {
    allTests: [],
    selectedTests: [],
    mavenTestSelector: "com.couchbase.client.kv.SanityTest",
    presets: ["all-non-transactions"],
  };
  const definition = buildFitFunctionalDefinition(sdk, cluster, allNonTransactions);
  const run = definition.instances[0]?.clusters[0]?.sessions[0]?.runs[0];
  assert.deepEqual(run?.tests.presets, ["all-non-transactions"]);

  const allTransactions: Parameters<typeof buildFitFunctionalDefinition>[2] = {
    allTests: [],
    selectedTests: [],
    mavenTestSelector: "com.couchbase.transactions.FooTest",
    presets: ["all-transactions"],
  };
  const defTxn = buildFitFunctionalDefinition(sdk, cluster, allTransactions);
  const runTxn = defTxn.instances[0]?.clusters[0]?.sessions[0]?.runs[0];
  assert.deepEqual(runTxn?.tests.presets, ["all-transactions"]);

  // round-trip: the placeholder parses cleanly
  assert.deepEqual(parseDefinition(formatFitDefinition(definition, "json5")), definition);
  assert.deepEqual(parseDefinition(formatFitDefinition(defTxn, "yaml"), "yaml"), defTxn);
});

test("formatFitDefinition includes the nested instances key (YAML)", () => {
  const rendered = formatFitDefinition(
    buildFitFunctionalDefinitionFrom({
      cluster: { kind: "connection", cluster },
      sdk,
      selection: buildDefaultFitTestSelection(),
    }),
    "yaml",
  );

  assert.match(rendered, /instances:/);
  assert.doesNotMatch(rendered, /fitConfigs:/);
});

test("an analytics-functional definition relocates the fitConfig to top-level fitConfigs and references it by id", () => {
  const analyticsSdk = sdkByValue("columnar-java");
  if (!analyticsSdk) throw new Error("Expected the columnar-java SDK to exist.");
  const definition = buildFitFunctionalDefinitionFrom({
    cluster: {
      kind: "cbdinocluster",
      def: { nodeCount: 2, version: "2.2.0-1166", services: [], cng: false, enterpriseAnalytics: true },
    },
    sdk: analyticsSdk,
    selection: buildDefaultFitTestSelection(),
    analytics: true,
  });

  const run = definition.instances[0]?.clusters[0]?.sessions[0]?.runs[0];
  assert.equal(run?.type, "analytics-functional");
  // The run references the fitConfig by id rather than inlining it.
  assert.equal(run?.fitConfig, "fit-config-0");
  assert.equal(definition.fitConfigs?.length, 1);
  assert.equal(definition.fitConfigs?.[0]?.id, "fit-config-0");
  // A Columnar SDK reaches Analytics over couchbases:// with insecure TLS.
  const columnarPerformer = (definition.fitConfigs?.[0]?.config?.clusterAccess as Record<string, unknown> | undefined)
    ?.performer as Record<string, unknown> | undefined;
  assert.deepEqual(columnarPerformer, { connectionString: "couchbases://${defaultHostname}", tls: { insecure: true } });
  // Round-trips through the parser cleanly.
  assert.deepEqual(parseDefinition(formatFitDefinition(definition, "json5")), definition);
});

test("an Enterprise Analytics SDK performer connects over http(s), not couchbases", () => {
  const eaSdk = sdkByValue("analytics-java");
  if (!eaSdk) throw new Error("Expected the analytics-java SDK to exist.");
  const definition = buildFitFunctionalDefinitionFrom({
    cluster: {
      kind: "cbdinocluster",
      def: { nodeCount: 2, version: "2.2.0-1166", services: [], cng: false, enterpriseAnalytics: true },
    },
    sdk: eaSdk,
    selection: buildDefaultFitTestSelection(),
    analytics: true,
  });

  const performer = (definition.fitConfigs?.[0]?.config?.clusterAccess as Record<string, unknown> | undefined)
    ?.performer as Record<string, unknown> | undefined;
  // The EA SDK rejects couchbases:// ("Expected URL scheme 'http' or 'https'") — use http://...:8095.
  assert.deepEqual(performer, { connectionString: "http://${defaultHostname}:8095", tls: null });
});
