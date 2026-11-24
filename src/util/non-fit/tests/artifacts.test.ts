import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  artifactFromPath,
  combineArtifacts,
  combineDetails,
  combineRunOutputs,
  formatArtifactsSection,
  formatCallToActionBanner,
  formatDetailsSection,
  reconcileArtifactsWithDir,
} from "../artifacts.js";

test("reconcileArtifactsWithDir appends on-disk files not already registered", () => {
  const runDir = mkdtempSync(join(tmpdir(), "fit-cli-artifacts-"));
  writeFileSync(join(runDir, "fit.json5"), "{}");
  writeFileSync(join(runDir, "leftover.log"), "noise");
  mkdirSync(join(runDir, "instances", "0"), { recursive: true });
  writeFileSync(join(runDir, "instances", "0", "performer.log"), "logs");
  // `_internal/` bookkeeping must be omitted from the user-facing table.
  mkdirSync(join(runDir, "instances", "0", "_internal"), { recursive: true });
  writeFileSync(join(runDir, "instances", "0", "_internal", "bookkeeping.json"), "{}");

  const reconciled = reconcileArtifactsWithDir(runDir, [
    { filename: "fit.json5", explanation: "Generated fit definition file" },
  ]);

  assert.deepEqual(reconciled, [
    { filename: "fit.json5", explanation: "Generated fit definition file" },
    { filename: join("instances", "0", "performer.log"), explanation: "(captured during the run)" },
    { filename: "leftover.log", explanation: "(captured during the run)" },
  ]);
});

test("reconcileArtifactsWithDir returns the explicit list when the dir is unreadable", () => {
  const explicit = [{ filename: "a.log", explanation: "Performer logs" }];
  assert.deepEqual(reconcileArtifactsWithDir(join(tmpdir(), "does-not-exist-fit-cli"), explicit), explicit);
});

test("artifactFromPath stores the filename relative to ARTIFACT_DIR", () => {
  const artifact = artifactFromPath(
    "/tmp/fit-cli/run-123/FITConfiguration-2026-06-03.json",
    "Generated FITConfiguration.json for the FIT test-driver",
    "/tmp/fit-cli/run-123",
  );

  assert.deepEqual(artifact, {
    filename: "FITConfiguration-2026-06-03.json",
    explanation: "Generated FITConfiguration.json for the FIT test-driver",
  });
});

test("combineArtifacts keeps first-seen order and removes duplicates", () => {
  assert.deepEqual(
    combineArtifacts(
      [{ filename: "a.log", explanation: "Performer logs" }],
      [
        { filename: "a.log", explanation: "Performer logs" },
        { filename: "b.json", explanation: "Generated FIT config" },
      ],
    ),
    [
      { filename: "a.log", explanation: "Performer logs" },
      { filename: "b.json", explanation: "Generated FIT config" },
    ],
  );
});

test("combineDetails keeps first-seen order and removes duplicates", () => {
  assert.deepEqual(
    combineDetails(
      [{ label: "SSH debug command", value: "ssh fit" }],
      [
        { label: "SSH debug command", value: "ssh fit" },
        { label: "Terminate instance command", value: "terminate fit" },
      ],
    ),
    [
      { label: "SSH debug command", value: "ssh fit" },
      { label: "Terminate instance command", value: "terminate fit" },
    ],
  );
});

test("combineRunOutputs merges artifacts and details", () => {
  assert.deepEqual(
    combineRunOutputs(
      {
        artifacts: [{ filename: "a.log", explanation: "Performer logs" }],
        details: [{ label: "SSH debug command", value: "ssh fit" }],
      },
      {
        artifacts: [{ filename: "b.json", explanation: "Generated FIT config" }],
        details: [{ label: "Terminate instance command", value: "terminate fit" }],
      },
    ),
    {
      artifacts: [
        { filename: "a.log", explanation: "Performer logs" },
        { filename: "b.json", explanation: "Generated FIT config" },
      ],
      details: [
        { label: "SSH debug command", value: "ssh fit" },
        { label: "Terminate instance command", value: "terminate fit" },
      ],
    },
  );
});

test("combineRunOutputs picks the most severe failure and sums failure counts", () => {
  const result = combineRunOutputs(
    {
      artifacts: [],
      details: [],
      worstFailure: { classification: "NonFatal", message: "flaky", context: { instanceIndex: 0 } },
      failureCount: 2,
    },
    {
      artifacts: [],
      details: [],
      worstFailure: { classification: "FatalToInstance", message: "boom", context: { instanceIndex: 1 } },
      failureCount: 1,
    },
  );

  assert.equal(result.worstFailure?.classification, "FatalToInstance");
  assert.equal(result.worstFailure?.message, "boom");
  assert.equal(result.failureCount, 3);
});

test("combineRunOutputs omits worstFailure/failureCount when no group has a failure", () => {
  const result = combineRunOutputs({ artifacts: [], details: [] }, { artifacts: [], details: [] });
  assert.equal(result.worstFailure, undefined);
  assert.equal(result.failureCount, undefined);
});

test("formatArtifactsSection renders a table", () => {
  const runDir = mkdtempSync(join(tmpdir(), "fit-cli-artifacts-"));
  const performerPath = join(runDir, "performer.log");
  const configPath = join(runDir, "FITConfiguration.json");
  writeFileSync(performerPath, "hello");
  writeFileSync(configPath, "{}");
  const filenameWidth = Math.max("Artifact filename".length, performerPath.length, configPath.length);
  const sizeWidth = "Size".length;

  assert.equal(
    formatArtifactsSection(runDir, [
      { filename: "performer.log", explanation: "Performer logs" },
      { filename: "FITConfiguration.json", explanation: "Generated FIT config" },
    ]),
    [
      `${"Artifact filename".padEnd(filenameWidth)} | ${"Size".padEnd(sizeWidth)} | Purpose`,
      `${"-".repeat(filenameWidth)}-+-${"-".repeat(sizeWidth)}-+-${"-".repeat("Purpose".length)}`,
      `${performerPath.padEnd(filenameWidth)} | ${"5 B".padEnd(sizeWidth)} | Performer logs`,
      `${configPath.padEnd(filenameWidth)} | ${"2 B".padEnd(sizeWidth)} | Generated FIT config`,
    ].join("\n"),
  );
});

test("formatArtifactsSection skips missing file sizes without throwing", () => {
  const runDir = mkdtempSync(join(tmpdir(), "fit-cli-artifacts-"));
  const performerPath = join(runDir, "performer.log");
  const missingPath = join(runDir, "missing.log");
  writeFileSync(performerPath, "hello");
  const filenameWidth = Math.max("Artifact filename".length, performerPath.length, missingPath.length);
  const sizeWidth = "Size".length;

  assert.equal(
    formatArtifactsSection(runDir, [
      { filename: "performer.log", explanation: "Performer logs" },
      { filename: "missing.log", explanation: "Missing logs" },
    ]),
    [
      `${"Artifact filename".padEnd(filenameWidth)} | ${"Size".padEnd(sizeWidth)} | Purpose`,
      `${"-".repeat(filenameWidth)}-+-${"-".repeat(sizeWidth)}-+-${"-".repeat("Purpose".length)}`,
      `${performerPath.padEnd(filenameWidth)} | ${"5 B".padEnd(sizeWidth)} | Performer logs`,
      `${missingPath.padEnd(filenameWidth)} | ${"".padEnd(sizeWidth)} | Missing logs`,
    ].join("\n"),
  );
});

test("formatCallToActionBanner wraps URL in OSC 8 hyperlink outside GHA", () => {
  const url = "https://faas.couchbase.com/results/situational";
  const banner = formatCallToActionBanner("Results UI", url, {});
  assert.ok(banner.includes("\x1b]8;;"), "should contain OSC 8 opener");
  assert.ok(banner.includes(url), "should contain the URL");
});

test("formatCallToActionBanner uses plain URL on GitHub Actions", () => {
  const url = "https://faas.couchbase.com/results/situational";
  const banner = formatCallToActionBanner("Results UI", url, { GITHUB_ACTIONS: "true" });
  assert.ok(!banner.includes("\x1b]8;;"), "should not contain OSC 8 sequences");
  assert.ok(banner.includes(url), "should still contain the URL");
});

test("formatDetailsSection renders a table", () => {
  assert.equal(
    formatDetailsSection([
      { label: "SSH debug command", value: "ssh -i key ubuntu@host" },
      { label: "Terminate instance command", value: "terminate --id i-123" },
    ]),
    [
      "Detail                     | Value",
      "---------------------------+-----------------------",
      "SSH debug command          | ssh -i key ubuntu@host",
      "Terminate instance command | terminate --id i-123",
    ].join("\n"),
  );
});
