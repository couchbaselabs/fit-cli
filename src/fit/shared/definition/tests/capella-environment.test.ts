import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capellaEnvironmentFromEnv,
  capellaEnvironmentOverridesFromEnv,
  withCapellaEnvironment,
} from "../capella-environment.js";
import type { FitDefinition } from "../types.js";

const SANDBOX_ENV = {
  CAPELLA_ENVIRONMENT: "sandbox",
  CAPELLA_ENDPOINT: "https://ui.sbx-25.sandbox.nonprod-project-avengers.com",
  CAPELLA_OID: "4c1d8e6a-0b2f-4a1e-9f3c-5d6e7a8b9c01",
};

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

test("capellaEnvironmentOverridesFromEnv derives both endpoints from the pasted UI URL", () => {
  assert.deepEqual(capellaEnvironmentOverridesFromEnv(SANDBOX_ENV), {
    sandbox: {
      endpoint: "https://api.sbx-25.sandbox.nonprod-project-avengers.com",
      v4Endpoint: "https://cloudapi.sbx-25.sandbox.nonprod-project-avengers.com",
      oid: "4c1d8e6a-0b2f-4a1e-9f3c-5d6e7a8b9c01",
    },
  });
});

test("capellaEnvironmentOverridesFromEnv honours an explicit CAPELLA_V4_ENDPOINT", () => {
  const overrides = capellaEnvironmentOverridesFromEnv({ ...SANDBOX_ENV, CAPELLA_V4_ENDPOINT: "https://v4.example.com" });
  assert.equal(overrides?.sandbox?.v4Endpoint, "https://v4.example.com");
});

test("capellaEnvironmentOverridesFromEnv yields nothing from a partial set", () => {
  assert.equal(capellaEnvironmentOverridesFromEnv({ CAPELLA_ENVIRONMENT: "sandbox" }), undefined);
  assert.equal(capellaEnvironmentOverridesFromEnv({ ...SANDBOX_ENV, CAPELLA_OID: "" }), undefined);
  // Without CAPELLA_ENVIRONMENT there is no environment to attach the coordinates to.
  assert.equal(capellaEnvironmentOverridesFromEnv({ CAPELLA_ENDPOINT: "https://api.x.com", CAPELLA_OID: "x" }), undefined);
});

test("capellaEnvironmentFromEnv treats blank as unset", () => {
  assert.equal(capellaEnvironmentFromEnv({ CAPELLA_ENVIRONMENT: "  " }), undefined);
  assert.equal(capellaEnvironmentFromEnv({ CAPELLA_ENVIRONMENT: " sandbox " }), "sandbox");
});
