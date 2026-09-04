import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCapellaEnvironmentOverrides,
  capellaEndpointOrigin,
  deriveCapellaSandboxEndpoints,
  isCapellaEndpointOrigin,
  isCapellaOrganizationId,
  isSandboxCapellaEnvironment,
  loadEnvironments,
  type EnvironmentsFile,
} from "../environments.js";

/** A minimal registry: one normal environment and one unprovisioned sandbox. */
function testEnvironments(): EnvironmentsFile {
  return {
    ...loadEnvironments(),
    capella: {
      dev: { endpoint: "https://api.dev.example", v4Endpoint: "https://cloudapi.dev.example", oid: "oid-dev" },
      sandbox: { sandbox: true, endpoint: null, v4Endpoint: null, oid: null, secretId: "cap/sandbox" },
    },
  };
}

test("applyCapellaEnvironmentOverrides fills in a sandbox's control plane", () => {
  const environments = testEnvironments();
  applyCapellaEnvironmentOverrides(
    { sandbox: { endpoint: "https://api.sbx-1.example", v4Endpoint: "https://cloudapi.sbx-1.example", oid: "oid-sandbox" } },
    environments,
  );
  assert.deepEqual(environments.capella.sandbox, {
    sandbox: true,
    endpoint: "https://api.sbx-1.example",
    v4Endpoint: "https://cloudapi.sbx-1.example",
    oid: "oid-sandbox",
    secretId: "cap/sandbox",
  });
});

test("applyCapellaEnvironmentOverrides resets a sandbox left provisioned by an earlier definition", () => {
  const environments = testEnvironments();
  applyCapellaEnvironmentOverrides(
    { sandbox: { endpoint: "https://api.sbx-1.example", v4Endpoint: "https://cloudapi.sbx-1.example", oid: "oid-1" } },
    environments,
  );
  // A later definition in the same process names no sandbox: it must not inherit the above.
  applyCapellaEnvironmentOverrides({}, environments);
  assert.equal(environments.capella.sandbox.endpoint, null);
  assert.equal(environments.capella.sandbox.v4Endpoint, null);
  assert.equal(environments.capella.sandbox.oid, null);
  // Non-sandbox environments are untouched by the reset.
  assert.equal(environments.capella.dev.endpoint, "https://api.dev.example");
});

test("applyCapellaEnvironmentOverrides refuses to repoint a non-sandbox environment", () => {
  assert.throws(
    () =>
      applyCapellaEnvironmentOverrides(
        { dev: { endpoint: "https://evil.example", v4Endpoint: "https://evil.example", oid: "oid" } },
        testEnvironments(),
      ),
    /is not a sandbox/,
  );
});

test("applyCapellaEnvironmentOverrides rejects an environment that isn't in the registry", () => {
  assert.throws(
    () =>
      applyCapellaEnvironmentOverrides(
        { nope: { endpoint: "https://a.example", v4Endpoint: "https://b.example", oid: "oid" } },
        testEnvironments(),
      ),
    /Unknown Capella environment "nope"/,
  );
});

test("the shipped registry has exactly one sandbox environment, with no control plane pinned", () => {
  const environments = loadEnvironments();
  const sandboxes = Object.keys(environments.capella).filter((name) => isSandboxCapellaEnvironment(name, environments));
  assert.deepEqual(sandboxes, ["sandbox"]);
  const sandbox = environments.capella.sandbox;
  assert.equal(sandbox.endpoint, null);
  assert.equal(sandbox.v4Endpoint, null);
  assert.equal(sandbox.oid, null);
  // Only the two support tokens are stable enough to keep in the secret.
  assert.equal(sandbox.secretId, "fit-cli/capella/sandbox");
});

test("deriveCapellaSandboxEndpoints turns the sandbox UI URL into both control-plane endpoints", () => {
  assert.deepEqual(deriveCapellaSandboxEndpoints("https://ui.sbx-25.sandbox.nonprod-project-avengers.com/"), {
    endpoint: "https://api.sbx-25.sandbox.nonprod-project-avengers.com",
    v4Endpoint: "https://cloudapi.sbx-25.sandbox.nonprod-project-avengers.com",
    recognised: true,
  });
});

test("deriveCapellaSandboxEndpoints accepts the api. or cloudapi. URL just as well", () => {
  const expected = {
    endpoint: "https://api.sbx-25.sandbox.nonprod-project-avengers.com",
    v4Endpoint: "https://cloudapi.sbx-25.sandbox.nonprod-project-avengers.com",
    recognised: true,
  };
  assert.deepEqual(deriveCapellaSandboxEndpoints("https://api.sbx-25.sandbox.nonprod-project-avengers.com"), expected);
  assert.deepEqual(deriveCapellaSandboxEndpoints("https://cloudapi.sbx-25.sandbox.nonprod-project-avengers.com"), expected);
});

test("deriveCapellaSandboxEndpoints keeps only the host from a full browser URL (drops path/query)", () => {
  assert.deepEqual(
    deriveCapellaSandboxEndpoints("https://ui.sbx-25.sandbox.nonprod-project-avengers.com/projects/abc?oid=xyz"),
    {
      endpoint: "https://api.sbx-25.sandbox.nonprod-project-avengers.com",
      v4Endpoint: "https://cloudapi.sbx-25.sandbox.nonprod-project-avengers.com",
      recognised: true,
    },
  );
});

test("deriveCapellaSandboxEndpoints matches any of ui./api./cloudapi. case-insensitively, canonicalising the host", () => {
  assert.deepEqual(deriveCapellaSandboxEndpoints("HTTPS://CloudAPI.SBX-25.Sandbox.Example.COM"), {
    endpoint: "https://api.sbx-25.sandbox.example.com",
    v4Endpoint: "https://cloudapi.sbx-25.sandbox.example.com",
    recognised: true,
  });
});

test("deriveCapellaSandboxEndpoints flags a host it can't rewrite rather than guessing", () => {
  assert.deepEqual(deriveCapellaSandboxEndpoints("  https://sbx-25.example.com/  "), {
    endpoint: "https://sbx-25.example.com",
    v4Endpoint: "https://sbx-25.example.com",
    recognised: false,
  });
});

test("capellaEndpointOrigin drops a browser path so the offered endpoint default is one the parser accepts", () => {
  assert.equal(capellaEndpointOrigin("https://foo.example.com/projects/x?tab=1"), "https://foo.example.com");
  assert.equal(capellaEndpointOrigin("  https://Foo.Example.com/  "), "https://foo.example.com");
});

test("isCapellaOrganizationId rejects the oid= prefix the Capella UI URL carries", () => {
  assert.equal(isCapellaOrganizationId("4c1d8e6a-0b2f-4a1e-9f3c-5d6e7a8b9c01"), true);
  assert.equal(isCapellaOrganizationId("  4C1D8E6A-0B2F-4A1E-9F3C-5D6E7A8B9C01  "), true);
  assert.equal(isCapellaOrganizationId("oid=4c1d8e6a-0b2f-4a1e-9f3c-5d6e7a8b9c01"), false);
  assert.equal(isCapellaOrganizationId("not a uuid at all"), false);
});

test("isCapellaEndpointOrigin accepts a bare origin and rejects anything carrying a path or space", () => {
  assert.equal(isCapellaEndpointOrigin("https://api.sbx-25.example.com"), true);
  assert.equal(isCapellaEndpointOrigin("https://api.sbx-25.example.com:8443"), true);
  assert.equal(isCapellaEndpointOrigin("https://api.sbx-25.example.com/projects"), false);
  assert.equal(isCapellaEndpointOrigin("https://api.sbx-25 .example.com"), false);
});

test("deriveCapellaSandboxEndpoints only reports recognised when both results are valid origins", () => {
  const derived = deriveCapellaSandboxEndpoints("https://ui.sbx-25.example.com/projects/x");
  assert.equal(derived.recognised, true);
  assert.equal(isCapellaEndpointOrigin(derived.endpoint), true);
  assert.equal(isCapellaEndpointOrigin(derived.v4Endpoint), true);
});

test("isCapellaEndpointOrigin rejects userinfo, which would smuggle a credential into the file", () => {
  assert.equal(isCapellaEndpointOrigin("https://user:hunter2@api.sbx.example.com"), false);
  assert.equal(deriveCapellaSandboxEndpoints("https://ui.u:p@x.example.com").recognised, false);
});
