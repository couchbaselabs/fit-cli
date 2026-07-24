/**
 * Unit tests for the performer-build family registry and its job/result parsing.
 *
 * Run on their own:
 *   bun test
 *   node --import tsx --test src/fit/performer/build/tests/build-performer.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PERFORMER_BUILD_FAMILIES,
  performerBuildFamilyByValue,
  parseMatrixJobSdk,
  summariseBuildJobs,
} from "../build-performer.js";

test("analytics-dotnet is a registered performer-build family", () => {
  const family = performerBuildFamilyByValue("analytics-dotnet");
  assert.ok(family, "expected an analytics-dotnet family entry");
  assert.equal(family.repo, "couchbase/analytics-dotnet-client");
  assert.equal(family.workflow, "publish-fit-performer.yml");
});

test("every registered family has a repo and workflow", () => {
  for (const family of PERFORMER_BUILD_FAMILIES) {
    assert.ok(family.value, "family value must be set");
    assert.match(family.repo, /^[^/]+\/[^/]+$/, `${family.value} repo must be owner/repo`);
    assert.match(family.workflow, /\.ya?ml$/, `${family.value} workflow must be a yml file`);
  }
});

test("parseMatrixJobSdk reads the sdk out of a `publish (<sdk>)` job name", () => {
  assert.equal(parseMatrixJobSdk("publish (analytics-dotnet)"), "analytics-dotnet");
  assert.equal(parseMatrixJobSdk("publish (columnar-java)"), "columnar-java");
  assert.equal(parseMatrixJobSdk("build"), undefined);
});

test("summariseBuildJobs maps a successful `publish (analytics-dotnet)` job to its GHCR image", () => {
  const { built, failed } = summariseBuildJobs(
    [{ name: "publish (analytics-dotnet)", conclusion: "success", url: "https://example/job" }],
    "main",
  );
  assert.equal(failed.length, 0);
  assert.equal(built.length, 1);
  assert.equal(built[0].sdkValue, "analytics-dotnet");
  assert.equal(built[0].fullImage, "ghcr.io/couchbase/analytics-dotnet-fit-performer:main");
});
