/**
 * Unit tests for the S3 store's index: the list of keys that stands in for bucket listing,
 * which fit-cli-role is not allowed to do.
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
import { nextIndex } from "../s3-store.js";

test("the next index keeps what was there, adds what was written, drops what was removed", () => {
  assert.deepEqual(nextIndex(["dotnet/a", "dotnet/b"], ["dotnet/c", "dotnet/a"], ["dotnet/b"]), ["dotnet/a", "dotnet/c"]);
});

test("a first push to a new store indexes exactly what was written", () => {
  assert.deepEqual(nextIndex([], ["dotnet/z", "dotnet/m"], []), ["dotnet/m", "dotnet/z"]);
});

test("manifests are pushed only after the records and logs they vouch for", async () => {
  const { pushStages } = await import("../s3-store.js");
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
