/**
 * Unit tests for the S3 store: which listed keys are pulled, the order changes are pushed in,
 * and that a key can't land outside the store.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/store/tests/s3-store.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalHealthStore } from "../health-store.js";
import { keysToPull, pushStages } from "../s3-store.js";

test("a listing becomes store keys: relative to the store, without the old index, raw logs only if wanted", () => {
  const listed = ["health-dev/dotnet/index.json", "health-dev/dotnet/records/2026/a.json", "health-dev/dotnet/raw/1-1.log.gz", "health-dev/dotnet/manifests/1-1.json"];
  assert.deepEqual(keysToPull(listed, "health-dev/", "dotnet"), ["dotnet/manifests/1-1.json", "dotnet/raw/1-1.log.gz", "dotnet/records/2026/a.json"]);
  assert.deepEqual(keysToPull(listed, "health-dev/", "dotnet", { skipRawLogs: true }), ["dotnet/manifests/1-1.json", "dotnet/records/2026/a.json"]);
  // A new SDK's prefix lists nothing: an empty store, not an error.
  assert.deepEqual(keysToPull([], "health-dev/", "python"), []);
});

test("manifests are pushed only after the records and logs they vouch for", () => {
  assert.deepEqual(
    pushStages(["dotnet/manifests/1-1.json", "dotnet/records/2026/a.json", "dotnet/raw/1-1.log.gz", "dotnet/notes.json"]),
    [["dotnet/records/2026/a.json", "dotnet/raw/1-1.log.gz", "dotnet/notes.json"], ["dotnet/manifests/1-1.json"]],
  );
  assert.deepEqual(pushStages(["dotnet/notes.json"]), [["dotnet/notes.json"]]);
  assert.deepEqual(pushStages([]), []);
});

test("a store key that would land outside the store is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "fit-health-test-"));
  try {
    const store = new LocalHealthStore(root);
    assert.equal(store.path("dotnet/records/a.json"), join(root, "dotnet", "records", "a.json"));
    // A leading slash just names a path inside the store.
    assert.equal(store.path("/etc/passwd"), join(root, "etc", "passwd"));
    for (const key of ["../escape.json", "dotnet/../../escape.json", "dotnet/x/../../../escape.json"]) {
      assert.throws(() => store.write(key, "x"), /outside the store/, key);
      assert.throws(() => store.read(key), /outside the store/, key);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record no manifest lists is not read: a deletion that didn't land can't stay in reports", () => {
  const root = mkdtempSync(join(tmpdir(), "fit-health-test-"));
  try {
    const store = new LocalHealthStore(root);
    store.write("dotnet/records/2026/kept.json", JSON.stringify({ preset: "kept" }));
    store.write("dotnet/records/2026/upgraded.json", JSON.stringify({ preset: "upgraded" }));
    store.write("dotnet/records/2026/stale.json", JSON.stringify({ preset: "stale" }));
    store.write(
      "dotnet/manifests/1-1.json",
      JSON.stringify({ records: ["dotnet/records/2026/kept.json"], archive: { upgraded: ["dotnet/records/2026/upgraded.json"] } }),
    );
    assert.deepEqual(store.readRecords("dotnet").map((r) => r.preset).sort(), ["kept", "upgraded"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
