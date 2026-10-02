/**
 * Unit tests for test ids: simple class names, package-qualified where the driver reuses one.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/emit/tests/test-identity.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classKey, classOfPath, qualifiers } from "../test-identity.js";
import { canonicalTestName } from "../junit-outcomes.js";
import { asLogged } from "../compare-records.js";

const PATHS = [
  "java/com/couchbase/client/kv/GetTest.java",
  "java/com/couchbase/transactions/states/GetTest.java",
  "java/com/couchbase/client/observability/ObservabilityTest.java",
  "java/com/couchbase/transactions/observability/ObservabilityTest.java",
  "java/com/couchbase/client/kv/LockTest.java",
  "scala/com/couchbase/situational/tests/SanityTest.scala",
  "java/com/couchbase/client/kv/SanityTest.java",
];

test("a class name the driver uses in several packages gets the shortest package suffix that tells them apart", () => {
  assert.equal(classOfPath(PATHS[0]), "com.couchbase.client.kv.GetTest");
  const q = qualifiers(PATHS);
  assert.equal(classKey("com.couchbase.client.kv.GetTest", q), "kv/GetTest");
  assert.equal(classKey("com.couchbase.transactions.states.GetTest", q), "states/GetTest");
  assert.equal(classKey("com.couchbase.client.observability.ObservabilityTest", q), "client/observability/ObservabilityTest");
  assert.equal(classKey("com.couchbase.situational.tests.SanityTest", q), "tests/SanityTest");
  assert.equal(classKey("com.couchbase.client.kv.LockTest", q), "LockTest", "a unique name stays simple");
  assert.equal(classKey("com.couchbase.client.kv.GetTest$Nested", q), "kv/GetTest$Nested", "a nested class takes its outer class's key");
});

test("the committed driver list qualifies the classes that really are reused", () => {
  assert.equal(canonicalTestName("com.couchbase.client.kv.DisconnectTest", "disconnect"), "kv/DisconnectTest.disconnect");
  assert.equal(canonicalTestName("com.couchbase.client.analytics.DisconnectTest", "disconnect"), "analytics/DisconnectTest.disconnect");
  assert.equal(canonicalTestName("com.couchbase.client.core.LockTest", "getAndLock"), "LockTest.getAndLock");
});

test("a qualified id compares with the log's simple-name line", () => {
  assert.equal(asLogged("kv/GetTest.getWithProjectionNoPathsExist"), "GetTest.getWithProjectionNoPathsExist");
  assert.equal(asLogged("client/observability/ObservabilityTest.x"), "ObservabilityTest.x");
  assert.equal(asLogged("LockTest.getAndLock"), "LockTest.getAndLock");
});
