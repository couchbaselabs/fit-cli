import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capellaEnvironmentFromEnv,
  definitionTargetsSandbox,
  withCapellaEnvironment,
} from "../capella-environment.js";
import type { FitDefinition } from "../types.js";

/** A preset-shaped definition: environment pinned at instance level and on a Capella cluster. */
const PINNED: FitDefinition = {
  version: 1,
  type: "fit",
  setup: {},
  instances: [
    {
      localhost: {},
      setup: { capellaEnvironment: "prod" },
      clusters: [
        {
          cbdinocluster: {
            config: { nodes: [{ count: 3, version: "8.0", services: ["kv"] }] },
            capella: { cloudProvider: "aws", environment: "prod" },
          },
          sessions: [],
        },
      ],
    },
  ],
  clusterConfigs: [
    {
      id: "cluster-0",
      cbdinocluster: {
        config: { nodes: [{ count: 3, version: "8.0", services: ["kv"] }] },
        capella: { cloudProvider: "aws", environment: "prod" },
      },
    },
  ],
};

test("withCapellaEnvironment repoints every selector a preset pins, at instance and cluster level", () => {
  const out = withCapellaEnvironment(PINNED, "sandbox");
  assert.equal(out.instances[0]?.setup?.capellaEnvironment, "sandbox");
  assert.equal(out.instances[0]?.clusters[0]?.cbdinocluster?.capella?.environment, "sandbox");
  assert.equal(out.clusterConfigs?.[0]?.cbdinocluster?.capella?.environment, "sandbox");
  // The input is untouched, so a caller can still report what the file itself said.
  assert.equal(PINNED.instances[0]?.setup?.capellaEnvironment, "prod");
});

test("definitionTargetsSandbox spots a sandbox the run resolves to", () => {
  assert.equal(definitionTargetsSandbox(PINNED), false);
  assert.equal(definitionTargetsSandbox(withCapellaEnvironment(PINNED, "sandbox")), true);
});

/** PINNED with its one Capella cluster replaced by a reference to the `cluster-0` config, pinned to `environment`. */
function referencingConfig(environment: string): FitDefinition {
  const config = PINNED.clusterConfigs?.[0];
  const instance = PINNED.instances[0];
  assert.ok(config?.cbdinocluster?.capella && instance);
  return {
    ...PINNED,
    instances: [{ ...instance, clusters: [{ clusterConfig: "cluster-0", sessions: [] }] }],
    clusterConfigs: [
      { ...config, cbdinocluster: { ...config.cbdinocluster, capella: { ...config.cbdinocluster.capella, environment } } },
    ],
  };
}

test("definitionTargetsSandbox spots a sandbox pinned on a referenced cluster config", () => {
  assert.equal(definitionTargetsSandbox(referencingConfig("sandbox")), true);
});

test("definitionTargetsSandbox follows the run's precedence, not every selector in the file", () => {
  // An unreferenced cluster config pinned to the sandbox allocates nothing.
  const unreferenced: FitDefinition = { ...PINNED, clusterConfigs: referencingConfig("sandbox").clusterConfigs };
  assert.equal(definitionTargetsSandbox(unreferenced), false);
  // A cluster's own pin wins over its instance's selection.
  const instance = PINNED.instances[0];
  assert.ok(instance);
  const overridden: FitDefinition = { ...PINNED, instances: [{ ...instance, setup: { capellaEnvironment: "sandbox" } }] };
  assert.equal(definitionTargetsSandbox(overridden), false);
});

test("capellaEnvironmentFromEnv treats blank as unset", () => {
  assert.equal(capellaEnvironmentFromEnv({ CAPELLA_ENVIRONMENT: "  " }), undefined);
  assert.equal(capellaEnvironmentFromEnv({ CAPELLA_ENVIRONMENT: " sandbox " }), "sandbox");
});
