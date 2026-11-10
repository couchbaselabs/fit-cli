/**
 * Unit tests for building the Capella create key request and reading its response.
 *
 * Run on their own:
 *   node --import tsx --test src/cloud/util/aws/tests/capella-api-keys.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { apiKeyUrl, createApiKeyRequest, createApiKeyUrl, loginUrl, organizationUrl, parseCreatedApiKey } from "../capella-api-keys.js";

const org = { endpoint: "https://api.example.com", v4Endpoint: "https://cloudapi.example.com", organizationId: "org-1" };

test("the create request asks for an organization owner key that never expires and works from anywhere", () => {
  assert.deepEqual(createApiKeyRequest("FIT-CLI-DONT-DELETE", "Do not delete."), {
    name: "FIT-CLI-DONT-DELETE",
    description: "Do not delete.",
    organizationRoles: ["organizationOwner"],
    expiry: -1,
    allowedCIDRs: ["0.0.0.0/0"],
  });
});

test("the create request refuses a name or description Capella would reject", () => {
  assert.throws(() => createApiKeyRequest("", "d"), /1 to 64 characters, got 0/);
  assert.throws(() => createApiKeyRequest("n".repeat(65), "d"), /1 to 64 characters, got 65/);
  assert.doesNotThrow(() => createApiKeyRequest("n".repeat(64), "d".repeat(256)));
  assert.throws(() => createApiKeyRequest("n", "d".repeat(257)), /at most 256 characters, got 257/);
});

test("a create response gives the key ID, its name and its token", () => {
  const body = { id: " key-1 ", name: "FIT-CLI-DONT-DELETE", description: "x", secretKey: "s", token: "t0ken" };
  assert.deepEqual(parseCreatedApiKey(body, "requested"), { id: "key-1", name: "FIT-CLI-DONT-DELETE", token: "t0ken" });
  assert.equal(parseCreatedApiKey({ id: "key-1", token: "t0ken" }, "requested").name, "requested");
});

test("a create response without an ID or token fails, and the error never quotes the body", () => {
  assert.throws(() => parseCreatedApiKey({ id: "key-1", token: "" }, "n"), (err: Error) => {
    assert.equal(err.message, "The Capella create key response has no token.");
    return true;
  });
  assert.throws(() => parseCreatedApiKey({ token: "t0ken" }, "n"), (err: Error) => {
    assert.equal(err.message, "The Capella create key response has no id.");
    return true;
  });
  assert.throws(() => parseCreatedApiKey(null, "n"), /has no id and token/);
  assert.throws(() => parseCreatedApiKey("t0ken", "n"), /has no id and token/);
});

test("the v2 calls go to the v2 endpoint and the v4 calls to the v4 endpoint", () => {
  assert.equal(loginUrl(org), "https://api.example.com/sessions");
  assert.equal(createApiKeyUrl(org), "https://api.example.com/v2/organizations/org-1/apikeys");
  assert.equal(organizationUrl(org), "https://cloudapi.example.com/v4/organizations/org-1");
  assert.equal(apiKeyUrl(org, "key/1"), "https://cloudapi.example.com/v4/organizations/org-1/apikeys/key%2F1");
});
