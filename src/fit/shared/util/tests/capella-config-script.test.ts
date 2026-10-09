import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResolvedCapellaConfig } from "../../../util/config.js";
import { capellaConfigScript, requireCapellaProjectId } from "../remote-fit-run.js";

const capella: ResolvedCapellaConfig = {
  username: "sdk_qe@couchbase.com",
  endpoint: "https://api.dev.example",
  v4Endpoint: "https://cloudapi.dev.example",
  organizationId: "oid-dev",
  password: "pw",
  apiKey: "key",
  apiSecret: "secret",
};

test("capellaConfigScript exports CAPELLA_PROJECT_ID when the project id is set", () => {
  const script = capellaConfigScript({ ...capella, projectId: "pid-dev" });
  assert.match(script, /^export CAPELLA_PROJECT_ID=pid-dev$/m);
  assert.match(script, /^export CAPELLA_OID=oid-dev$/m);
});

test("capellaConfigScript clears CAPELLA_PROJECT_ID when the project id is unset", () => {
  assert.match(capellaConfigScript(capella), /^export CAPELLA_PROJECT_ID=''$/m);
});

test("requireCapellaProjectId names the env and the key to add when the project id is unset", () => {
  assert.throws(() => requireCapellaProjectId("stage", capella), {
    classification: "FatalToCluster",
    message: "Capella env stage has no projectId. Add capella.stage.projectId to environments.json5.",
  });
});

test("requireCapellaProjectId accepts a config with a project id", () => {
  assert.doesNotThrow(() => requireCapellaProjectId("dev", { ...capella, projectId: "pid-dev" }));
});
