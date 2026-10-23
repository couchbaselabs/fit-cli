import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertTrustedCapellaHost,
  capellaControlPlane,
  isCapellaOrganizationId,
  isSandboxCapellaEnvironment,
  loadEnvironments,
  sandboxControlPlaneOrigins,
} from "../environments.js";

const SANDBOX_ENV = {
  CAPELLA_V4_ENDPOINT: " https://cloudapi.sbx-25.sandbox.nonprod-project-avengers.com/ ",
  CAPELLA_OID: " 4c1d8e6a-0b2f-4a1e-9f3c-5d6e7a8b9c01 ",
};

test("capellaControlPlane takes a sandbox's from CAPELLA_V4_ENDPOINT/CAPELLA_OID, with its v2 endpoint beside it", () => {
  const plane = capellaControlPlane({ sandbox: true, secretId: "cap/sandbox" }, SANDBOX_ENV);
  assert.equal(plane.v4Endpoint, "https://cloudapi.sbx-25.sandbox.nonprod-project-avengers.com");
  assert.equal(plane.endpoint, "https://api.sbx-25.sandbox.nonprod-project-avengers.com");
  assert.equal(plane.oid, "4c1d8e6a-0b2f-4a1e-9f3c-5d6e7a8b9c01");
});

test("capellaControlPlane leaves a sandbox's unset when the env vars are, so the caller can say which", () => {
  const plane = capellaControlPlane({ sandbox: true }, { CAPELLA_OID: "  " });
  assert.equal(plane.v4Endpoint, undefined);
  assert.equal(plane.endpoint, undefined);
  assert.equal(plane.oid, undefined);
});

test("capellaControlPlane derives a sandbox's endpoints from its UI URL", () => {
  const plane = capellaControlPlane({ sandbox: true }, { CAPELLA_V4_ENDPOINT: "https://ui.sbx-25.sandbox.nonprod-project-avengers.com" });
  assert.equal(plane.v4Endpoint, "https://cloudapi.sbx-25.sandbox.nonprod-project-avengers.com");
  assert.equal(plane.endpoint, "https://api.sbx-25.sandbox.nonprod-project-avengers.com");
});

test("capellaControlPlane gives a sandbox no endpoints when CAPELLA_V4_ENDPOINT has no ui./api./cloudapi. host", () => {
  const plane = capellaControlPlane({ sandbox: true }, { CAPELLA_V4_ENDPOINT: "https://sbx-25.sandbox.nonprod-project-avengers.com" });
  assert.equal(plane.v4Endpoint, undefined);
  assert.equal(plane.endpoint, undefined);
});

test("capellaControlPlane ignores the env vars for a standing environment, whose control plane is pinned", () => {
  const plane = capellaControlPlane(
    { endpoint: "https://api.dev.example", v4Endpoint: "https://cloudapi.dev.example", oid: "oid-dev" },
    SANDBOX_ENV,
  );
  assert.equal(plane.endpoint, "https://api.dev.example");
  assert.equal(plane.v4Endpoint, "https://cloudapi.dev.example");
  assert.equal(plane.oid, "oid-dev");
});

test("assertTrustedCapellaHost accepts only hosts under the environment's domains", () => {
  const suffixes = [".sandbox.nonprod-project-avengers.com"];
  assertTrustedCapellaHost("sandbox", "cloudapi.sbx-25.sandbox.nonprod-project-avengers.com", suffixes);
  for (const host of [
    "cloudapi.sbx-25.sandbox.nonprod-project-avengers.com.evil.example",
    "cloudapi.dev.nonprod-project-avengers.com", // the standing dev control plane shares the nonprod domain
  ]) {
    assert.throws(() => assertTrustedCapellaHost("sandbox", host, suffixes), /is not under sandbox\.nonprod-project-avengers\.com/, host);
  }
});

test("assertTrustedCapellaHost matches whole domain labels, so a suffix without its leading dot can't admit lookalikes", () => {
  assertTrustedCapellaHost("sandbox", "cloudapi.sbx-25.example.com", ["example.com"]);
  assert.throws(() => assertTrustedCapellaHost("sandbox", "cloudapi.evilexample.com", ["example.com"]), /is not under example\.com/);
});

test("assertTrustedCapellaHost fails closed when the environment names no domains", () => {
  for (const suffixes of [undefined, null, [], [" "]]) {
    assert.throws(() => assertTrustedCapellaHost("sandbox", "cloudapi.sbx-25.example.com", suffixes), /no endpointSuffixes/);
  }
});

test("the shipped sandbox only trusts sandbox hosts, not the standing environments on the same domain", () => {
  const { sandbox, dev, stage } = loadEnvironments().capella;
  for (const standing of [dev, stage]) {
    const host = new URL(standing.v4Endpoint ?? "").hostname;
    assert.throws(() => assertTrustedCapellaHost("sandbox", host, sandbox.endpointSuffixes), /is not under/, host);
  }
});

test("the shipped registry has exactly one sandbox environment, with no control plane pinned", () => {
  const environments = loadEnvironments();
  const sandboxes = Object.keys(environments.capella).filter((name) => isSandboxCapellaEnvironment(name, environments));
  assert.deepEqual(sandboxes, ["sandbox"]);
  const sandbox = environments.capella.sandbox;
  // Its control plane comes from env vars (see capellaControlPlane), so none of it is pinned here.
  assert.equal(sandbox.endpoint, undefined);
  assert.equal(sandbox.v4Endpoint, undefined);
  assert.equal(sandbox.oid, undefined);
  // Only the two support tokens are stable enough to keep in the secret.
  assert.equal(sandbox.secretId, "fit-cli/capella/sandbox");
});

test("sandboxControlPlaneOrigins takes a cloudapi. origin and gives the api. host beside it", () => {
  assert.deepEqual(sandboxControlPlaneOrigins("HTTPS://CloudAPI.SBX-25.Example.COM/"), {
    endpoint: "https://api.sbx-25.example.com",
    v4Endpoint: "https://cloudapi.sbx-25.example.com",
  });
  // A stray `?` or `#` isn't carried into the endpoint cbdinocluster appends API paths to.
  for (const value of ["https://cloudapi.sbx-25.example.com?", "https://cloudapi.sbx-25.example.com#"]) {
    assert.equal(sandboxControlPlaneOrigins(value)?.v4Endpoint, "https://cloudapi.sbx-25.example.com", value);
  }
});

test("sandboxControlPlaneOrigins derives both origins from any of the sandbox's URLs, dropping any path", () => {
  for (const value of [
    "https://ui.sbx-25.example.com",
    "https://UI.SBX-25.Example.COM/sign-in", // as `fit sandbox deploy`'s Output summary shows it
    "https://ui.sbx-25.example.com/databases?oid=4c1d8e6a-0b2f-4a1e-9f3c-5d6e7a8b9c01#top", // copied from a browser
    "https://api.sbx-25.example.com", // the v2 API
    "https://cloudapi.sbx-25.example.com/v4",
  ]) {
    assert.deepEqual(
      sandboxControlPlaneOrigins(value),
      { endpoint: "https://api.sbx-25.example.com", v4Endpoint: "https://cloudapi.sbx-25.example.com" },
      value,
    );
  }
});

test("sandboxControlPlaneOrigins rejects anything that isn't an https ui./api./cloudapi. URL without credentials", () => {
  for (const value of [
    "http://ui.sbx-25.example.com",
    "https://user:hunter2@ui.sbx-25.example.com",
    "https://sbx-25.example.com",
    "https://fm.sbx-25.example.com",
    "http://cloudapi.sbx-25.example.com",
    "https://user:hunter2@cloudapi.sbx-25.example.com",
    "not a url",
  ]) {
    assert.equal(sandboxControlPlaneOrigins(value), null, value);
  }
});

test("isCapellaOrganizationId rejects the oid= prefix the Capella UI URL carries", () => {
  assert.equal(isCapellaOrganizationId("4c1d8e6a-0b2f-4a1e-9f3c-5d6e7a8b9c01"), true);
  assert.equal(isCapellaOrganizationId("  4C1D8E6A-0B2F-4A1E-9F3C-5D6E7A8B9C01  "), true);
  assert.equal(isCapellaOrganizationId("oid=4c1d8e6a-0b2f-4a1e-9f3c-5d6e7a8b9c01"), false);
  assert.equal(isCapellaOrganizationId("not a uuid at all"), false);
});
