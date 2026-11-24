/**
 * Unit tests for the Capella key rotate step's arguments and environment lookup.
 *
 * Run on their own:
 *   node --import tsx --test src/cloud/util/aws/tests/capella-key-rotate.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiKeyRequest } from "../capella-api-keys.js";
import {
  CAPELLA_KEY_DESCRIPTION,
  CAPELLA_KEY_NAME,
  parseRotateArgs,
  resolveRotateTarget,
  shortKeyId,
  v2Credentials,
} from "../capella-key-rotate.js";

const capella = {
  prod: {
    endpoint: "https://api.example.com",
    v4Endpoint: "https://cloudapi.example.com",
    oid: "org-1",
    username: "shared@example.com",
    secretId: "fit-cli/capella/prod",
  },
  dev: { endpoint: "https://api.dev.example.com", v4Endpoint: null, oid: "org-2", secretId: null },
};

test("rotate takes an optional environment and --auto, in any order", () => {
  assert.deepEqual(parseRotateArgs([]), { env: undefined, auto: false });
  assert.deepEqual(parseRotateArgs(["dev"]), { env: "dev", auto: false });
  assert.deepEqual(parseRotateArgs(["--auto", "dev"]), { env: "dev", auto: true });
  assert.deepEqual(parseRotateArgs(["dev", "--auto"]), { env: "dev", auto: true });
  assert.deepEqual(parseRotateArgs(["--interactive", "--auto"]), { env: undefined, auto: true });
});

test("rotate refuses a second environment or an unknown flag, so a secret can't be passed as an argument", () => {
  assert.throws(() => parseRotateArgs(["prod", "dev"]), /at most one environment/);
  assert.throws(() => parseRotateArgs(["--secret=abc"]), /Unexpected argument: --secret=abc/);
});

test("the target is the environment's endpoints, org and secret", () => {
  assert.deepEqual(resolveRotateTarget(capella, "prod"), {
    env: "prod",
    endpoint: "https://api.example.com",
    v4Endpoint: "https://cloudapi.example.com",
    organizationId: "org-1",
    secretId: "fit-cli/capella/prod",
    username: "shared@example.com",
  });
});

test("an unknown or half provisioned environment fails and says what is wrong", () => {
  assert.throws(() => resolveRotateTarget(capella, "stage"), /Unknown Capella environment "stage"\. environments\.json5 has prod, dev\./);
  assert.throws(() => resolveRotateTarget(capella, "toString"), /Unknown Capella environment/);
  assert.throws(() => resolveRotateTarget(capella, "dev"), /"dev" in environments\.json5 has no v4Endpoint, secretId\./);
});

test("the v2 login uses the password from the secret, and the environments.json5 username wins over the secret's", () => {
  const target = resolveRotateTarget(capella, "prod");
  assert.deepEqual(v2Credentials(target, { password: "pw" }), { username: "shared@example.com", password: "pw" });
  assert.deepEqual(v2Credentials(target, { password: "pw", username: "other@example.com" }), {
    username: "shared@example.com",
    password: "pw",
  });
  assert.deepEqual(v2Credentials({ ...target, username: undefined }, { password: "pw", username: "other@example.com" }), {
    username: "other@example.com",
    password: "pw",
  });
  assert.throws(() => v2Credentials(target, {}), /no password for "prod"/);
  assert.throws(() => v2Credentials({ ...target, username: undefined }, {}), /no username and password/);
});

test("the shared key's name and description fit Capella's limits", () => {
  assert.doesNotThrow(() => createApiKeyRequest(CAPELLA_KEY_NAME, CAPELLA_KEY_DESCRIPTION));
});

test("shortKeyId shows only the last 4 characters of a key ID", () => {
  assert.equal(shortKeyId("a1b2c3d4e5f6"), "…e5f6");
  assert.equal(shortKeyId("abc"), "…abc");
});
