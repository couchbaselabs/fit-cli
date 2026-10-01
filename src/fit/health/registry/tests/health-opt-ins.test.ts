/**
 * Unit tests for fit health opt-ins: validation, and merging a local FIT_HEALTH_OPT_INS file
 * over the committed entries.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/registry/tests/health-opt-ins.test.ts
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { HEALTH_OPT_INS_ENV_VAR, loadOptIns, validateOptIn } from "../health-opt-ins.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

test("a minimal entry is valid; branch and slack are optional", () => {
  assert.deepEqual(validateOptIn("java", { repo: "couchbase/couchbase-jvm-clients", workflows: ["fit-testing-java.yml"] }), []);
});

test("invalid entries say exactly what is wrong", () => {
  const p = validateOptIn("klingon", { repo: "nope", workflows: [], slack: { channel: "#general" } });
  assert.ok(p.some((x) => /not an SDK/.test(x)));
  assert.ok(p.some((x) => /owner\/name/.test(x)));
  assert.ok(p.some((x) => /non-empty list/.test(x)));
  assert.ok(p.some((x) => /channel or user ID/.test(x)));
});

test("a local opt-in file adds entries and overrides committed ones, marked local", () => {
  const all = loadOptIns({ [HEALTH_OPT_INS_ENV_VAR]: join(FIXTURES, "opt-ins.json5") });
  assert.equal(all.java.repo, "couchbase/couchbase-jvm-clients");
  assert.equal(all.java.local, true);
  assert.equal(all.dotnet.branch, "release-3.9");
  assert.equal(loadOptIns({}).java, undefined, "without the file, only committed entries");
});

test("an invalid local entry is refused, naming the file", () => {
  assert.throws(() => loadOptIns({ [HEALTH_OPT_INS_ENV_VAR]: join(FIXTURES, "bad-opt-ins.json5") }), /Invalid fit health opt-in for klingon \(from .*bad-opt-ins\.json5\)/);
  assert.throws(() => loadOptIns({ [HEALTH_OPT_INS_ENV_VAR]: join(FIXTURES, "missing.json5") }), /does not exist/);
});

test("SDKs sharing a repo each need their own workflow and their own paths; shared code is declared as shared", async () => {
  const { validateOptInSet } = await import("../health-opt-ins.js");
  const jvm = (workflow: string, paths: string[]) => ({
    repo: "couchbase/couchbase-jvm-clients",
    workflows: [workflow],
    paths,
    sharedCorePaths: ["core-io/", "core-io-deps/"],
    sharedHarnessPaths: ["core-fit-performer/"],
    family: "jvm",
  });
  assert.deepEqual(validateOptIn("kotlin", jvm("fit-testing-kotlin.yml", ["kotlin-client/", "kotlin-fit-performer/"])), []);
  const ok = { java: jvm("fit-testing-java.yml", ["java-client/"]), kotlin: jvm("fit-testing-kotlin.yml", ["kotlin-client/"]) };
  assert.deepEqual(validateOptInSet(ok), []);
  assert.match(validateOptInSet({ ...ok, scala: jvm("fit-testing-java.yml", ["scala-client/"]) }).join(), /both claim fit-testing-java.yml/);
  assert.match(validateOptInSet({ ...ok, scala: jvm("fit-testing-scala.yml", ["java-client/x/"]) }).join(), /java and scala both own java-client\//);
  const noPaths = { repo: "couchbase/couchbase-jvm-clients", workflows: ["fit-testing-scala.yml"] };
  assert.match(validateOptInSet({ ...ok, scala: noPaths }).join(), /each needs paths/);
  assert.match(validateOptIn("scala", { ...noPaths, sharedCorePaths: ["core-io/"] }).join(), /need paths too/);
  assert.match(validateOptIn("scala", { ...noPaths, paths: ["../escape/"] }).join(), /repo-relative paths/);
  assert.match(validateOptIn("scala", { ...noPaths, family: "JVM" }).join(), /lower-case/);
});
