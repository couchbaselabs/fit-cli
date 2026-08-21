import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cmdWritePlaceholder, collectSlackResults } from "../slack-cli.js";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "slack-cli-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("collectSlackResults merges every *.json file in a directory into one summary", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "java-main.json"),
      JSON.stringify({ passed: true, results: [{ label: "aws1 / java:main / func", sdk: "java:main", ok: true }] }),
    );
    writeFileSync(
      join(dir, "go-main.json"),
      JSON.stringify({ passed: false, results: [{ label: "aws2 / go:main / func", sdk: "go:main", ok: false }] }),
    );
    const { passed, results } = collectSlackResults(dir);
    assert.equal(passed, false);
    assert.equal(results.length, 2);
    assert.deepEqual(
      results.map((r) => r.sdk).sort(),
      ["go:main", "java:main"],
    );
  });
});

test("collectSlackResults reports passed when every file passed", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "a.json"), JSON.stringify({ passed: true, results: [{ label: "a", sdk: "a", ok: true }] }));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ passed: true, results: [{ label: "b", sdk: "b", ok: true }] }));
    const { passed } = collectSlackResults(dir);
    assert.equal(passed, true);
  });
});

test("collectSlackResults ignores non-json files in the directory", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "a.json"), JSON.stringify({ passed: true, results: [{ label: "a", sdk: "a", ok: true }] }));
    writeFileSync(join(dir, "README.md"), "not json");
    const { results } = collectSlackResults(dir);
    assert.equal(results.length, 1);
  });
});

test("cmdWritePlaceholder writes a single failed row for the given label", () => {
  withTempDir((dir) => {
    const path = join(dir, "slack-result.json");
    cmdWritePlaceholder(path, "op-crashed-preset");
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(parsed, { passed: false, results: [{ label: "op-crashed-preset", sdk: "op-crashed-preset", ok: false }] });
  });
});

test("collectSlackResults walks subdirectories — the shape actions/download-artifact produces", () => {
  // download-artifact with merge-multiple: false nests each matrix job's identically-named
  // slack-result.json in its own per-artifact subdirectory. post-collected is handed that
  // raw structure directly (no flattening step), so this must recurse to find them all.
  withTempDir((dir) => {
    mkdirSync(join(dir, "slack-result-0"));
    mkdirSync(join(dir, "slack-result-1"));
    writeFileSync(
      join(dir, "slack-result-0", "slack-result.json"),
      JSON.stringify({ passed: true, results: [{ label: "aws1 / java:main / func", sdk: "java:main", ok: true }] }),
    );
    writeFileSync(
      join(dir, "slack-result-1", "slack-result.json"),
      JSON.stringify({ passed: false, results: [{ label: "aws2 / go:main / func", sdk: "go:main", ok: false }] }),
    );
    const { passed, results } = collectSlackResults(dir);
    assert.equal(passed, false);
    assert.equal(results.length, 2);
    assert.deepEqual(
      results.map((r) => r.sdk).sort(),
      ["go:main", "java:main"],
    );
  });
});
