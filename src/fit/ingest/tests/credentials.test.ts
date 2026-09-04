/**
 * Unit tests for where the ingester gets its password, and for the one-line
 * messages it prints when the database is unreachable or rejects it.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/ingest/tests/credentials.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INGEST_DB_USERNAME,
  INGEST_PASSWORD_ENV_VAR,
  INGEST_SECRET_ID,
  IngestCredentialsError,
  ingestDbFailureLine,
  resolveIngestPassword,
} from "../credentials.js";

const secret = (password: string) => () => Promise.resolve(JSON.stringify({ password }));
const noSecret = () => Promise.reject(new Error("fetchSecret should not have been called"));

test("the environment variable wins over Secrets Manager", async () => {
  const resolved = await resolveIngestPassword({
    env: { [INGEST_PASSWORD_ENV_VAR]: "from-env" },
    fetchSecret: noSecret,
  });
  assert.deepEqual(resolved, { password: "from-env", source: "env" });
});

test("falls back to Secrets Manager when the variable is unset or blank", async () => {
  assert.deepEqual(await resolveIngestPassword({ env: {}, fetchSecret: secret("from-secret") }), {
    password: "from-secret",
    source: "secret",
  });
  assert.deepEqual(
    await resolveIngestPassword({ env: { [INGEST_PASSWORD_ENV_VAR]: "  " }, fetchSecret: secret("from-secret") }),
    { password: "from-secret", source: "secret" },
  );
});

test("a failed secret fetch names the AWS error and both ways to fix it", async () => {
  const err = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
  await assert.rejects(
    () => resolveIngestPassword({ env: {}, fetchSecret: () => Promise.reject(err) }),
    (thrown: Error) => {
      assert.ok(thrown instanceof IngestCredentialsError);
      assert.equal(
        thrown.message,
        `Could not read Secrets Manager secret ${INGEST_SECRET_ID} (AccessDeniedException). ` +
          `Set ${INGEST_PASSWORD_ENV_VAR} or run on a host whose IAM role can read the secret.`,
      );
      return true;
    },
  );
});

test("a malformed secret fails the same way as an unreadable one", async () => {
  for (const value of ["not json", "{}", '{"password":"  "}']) {
    await assert.rejects(
      () => resolveIngestPassword({ env: {}, fetchSecret: () => Promise.resolve(value) }),
      IngestCredentialsError,
    );
  }
});

test("unreachable database codes report the host and port", () => {
  for (const code of ["ECONNREFUSED", "ETIMEDOUT", "CONNECT_TIMEOUT", "EHOSTUNREACH"]) {
    assert.equal(
      ingestDbFailureLine(Object.assign(new Error("x"), { code }), { host: "localhost", port: 5432 }),
      "Could not connect to Postgres at localhost:5432. Check the database is running.",
    );
  }
});

test("a rejected password points at the secret, not at the password", () => {
  for (const code of ["28P01", "28000"]) {
    const line = ingestDbFailureLine(Object.assign(new Error("x"), { code }), { host: "localhost", port: 5432 });
    assert.equal(
      line,
      `Postgres rejected the ${INGEST_DB_USERNAME} password. The ${INGEST_SECRET_ID} secret does not match the database role.`,
    );
  }
});

test("any other error is left for the caller to report", () => {
  assert.equal(ingestDbFailureLine(new Error("boom"), { host: "localhost", port: 5432 }), null);
  assert.equal(
    ingestDbFailureLine(Object.assign(new Error("x"), { code: "42P01" }), { host: "localhost", port: 5432 }),
    null,
  );
});
