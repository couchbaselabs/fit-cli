/**
 * Unit tests for parsing workflow inputs, picking the dispatched run, and reading job logs.
 *
 * Run on their own:
 *   node --import tsx --test src/util/non-fit/tests/gh-workflow.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractJobErrorExcerpt,
  extractStepSummaryOutput,
  formatRunHeartbeat,
  parseRunIdFromUrl,
  parseWorkflowDispatchInputs,
} from "../gh-workflow.js";

const WORKFLOW_YAML = `
name: example
run-name: example (\${{ inputs.cloud-id || 'auto' }})
on:
  workflow_dispatch:
    inputs:
      type:
        description: The type of sandbox to deploy
        type: choice
        default: "sbx"
        options: ["sbx", "qe", "perf"]
      cloud-id:
        description: OVERRIDE - The specific sandbox to deploy to
        type: string
      profile:
        description: The profile
        type: choice
        options: ["default", "medium"]
      dry-run:
        type: boolean
        default: false
      ticket:
        description: "  Jira ticket  "
        required: true
jobs:
  build:
    runs-on: ubuntu-latest
`;

test("parseWorkflowDispatchInputs keeps declaration order and resolves the form's defaults", () => {
  const inputs = parseWorkflowDispatchInputs(WORKFLOW_YAML);
  assert.deepEqual(inputs.map((i) => i.name), ["type", "cloud-id", "profile", "dry-run", "ticket"]);
  const byName = Object.fromEntries(inputs.map((i) => [i.name, i]));
  assert.equal(byName["type"].default, "sbx");
  assert.deepEqual(byName["type"].options, ["sbx", "qe", "perf"]);
  assert.equal(byName["cloud-id"].default, "", "a string input with no default starts empty");
  assert.deepEqual(byName["cloud-id"].options, []);
  assert.equal(byName["profile"].default, "default", "a choice with no default starts on its first option");
  assert.deepEqual(byName["dry-run"].options, ["true", "false"]);
  assert.equal(byName["dry-run"].default, "false");
  assert.equal(byName["ticket"].type, "string", "type defaults to string");
  assert.equal(byName["ticket"].description, "Jira ticket");
  assert.equal(byName["ticket"].required, true);
});

test("parseWorkflowDispatchInputs returns nothing for a workflow without dispatch inputs", () => {
  assert.deepEqual(parseWorkflowDispatchInputs("on:\n  workflow_dispatch:\njobs: {}\n"), []);
  assert.deepEqual(parseWorkflowDispatchInputs("on: push\n"), []);
});

test("parseWorkflowDispatchInputs starts a boolean with no default unchecked, like GitHub's form", () => {
  const [flag] = parseWorkflowDispatchInputs("on:\n  workflow_dispatch:\n    inputs:\n      force:\n        type: boolean\n");
  assert.equal(flag.default, "false");
  assert.deepEqual(flag.options, ["true", "false"]);
});

test("parseWorkflowDispatchInputs takes a description YAML reads as a number or boolean", () => {
  const inputs = parseWorkflowDispatchInputs("on:\n  workflow_dispatch:\n    inputs:\n      a:\n        description: 2.0\n      b:\n        description: true\n");
  assert.deepEqual(inputs.map((i) => i.description), ["2", "true"]);
});

test("parseRunIdFromUrl reads the run id from the run URL gh prints after a dispatch", () => {
  assert.equal(parseRunIdFromUrl("https://github.com/couchbasecloud/couchbase-cloud/actions/runs/18412345678\n"), 18412345678);
  assert.equal(parseRunIdFromUrl("✓ Created workflow_dispatch event for x.yml at main\n"), undefined);
  assert.equal(parseRunIdFromUrl(""), undefined);
});

const ts = (line: string): string => `2026-10-13T10:00:01.1234567Z ${line}`;

const OUTPUT_JOB_LOG = [
  "﻿2026-10-13T10:00:00.0000000Z Current runner version: '2.328.0'",
  ts("##[group]Operating System"),
  ts("Ubuntu"),
  ts("##[endgroup]"),
  ts("Complete job name: output-summary"),
  ts('##[group]Run echo "### Output" | tee -a $GITHUB_STEP_SUMMARY'),
  ts('echo "### Output" | tee -a $GITHUB_STEP_SUMMARY'),
  ts('SBX_ID="sbx-25"'),
  ts("shell: /usr/bin/bash -e {0}"),
  ts("##[endgroup]"),
  ts("### Output"),
  ts("Deployed sandbox: sbx-25"),
  ts("#### UI"),
  ts("https://ui.sbx-25.sandbox.nonprod-project-avengers.com/sign-in"),
  ts(""),
  ts("Cleaning up orphan processes"),
  "",
].join("\n");

test("extractStepSummaryOutput returns what the summary step printed, without its script or the runner trailer", () => {
  assert.deepEqual(extractStepSummaryOutput(OUTPUT_JOB_LOG), [
    "### Output",
    "Deployed sandbox: sbx-25",
    "#### UI",
    "https://ui.sbx-25.sandbox.nonprod-project-avengers.com/sign-in",
  ]);
});

test("extractStepSummaryOutput stops at the next step", () => {
  const log = [
    ts('##[group]Run echo one | tee -a $GITHUB_STEP_SUMMARY'), ts("##[endgroup]"), ts("one"),
    ts("##[group]Run echo two"), ts("##[endgroup]"), ts("two"),
  ].join("\n");
  assert.deepEqual(extractStepSummaryOutput(log), ["one"]);
});

test("extractStepSummaryOutput skips a self-hosted runner's job hooks around the summary step", () => {
  const log = [
    ts("A job started hook has been configured by the self-hosted runner administrator"),
    ts("##[group]Run '/home/runner/hooks/job-started.sh'"), ts("##[endgroup]"), ts("hook says hello"),
    ts('##[group]Run echo "### Output" | tee -a $GITHUB_STEP_SUMMARY'), ts('echo "### Output" | tee -a $GITHUB_STEP_SUMMARY'), ts("##[endgroup]"),
    ts("### Output"),
    ts("A job completed hook has been configured by the self-hosted runner administrator"),
    ts("##[group]Run '/home/runner/hooks/job-completed.sh'"), ts("##[endgroup]"), ts("hook says bye"),
  ].join("\n");
  assert.deepEqual(extractStepSummaryOutput(log), ["### Output"]);
});

test("extractStepSummaryOutput returns nothing when no step writes the step summary", () => {
  assert.deepEqual(extractStepSummaryOutput([ts("Complete job name: x"), ts("Cleaning up orphan processes")].join("\n")), []);
  assert.deepEqual(extractStepSummaryOutput([ts("##[group]Run echo hi"), ts("##[endgroup]"), ts("hi")].join("\n")), []);
});

test("extractJobErrorExcerpt keeps each error with its lead-up, merging overlaps and marking gaps", () => {
  const lines = Array.from({ length: 60 }, (_, i) => ts(`line ${i}`));
  lines[30] = ts("##[error]first");
  lines[33] = ts("##[error]second");
  lines[58] = ts("##[error]third");
  const excerpt = extractJobErrorExcerpt(lines.join("\n"));

  assert.equal(excerpt[0], "line 10", "20 lines of context before the first error");
  assert.ok(excerpt.includes("##[error]first"));
  assert.ok(excerpt.includes("##[error]second"));
  assert.equal(excerpt.filter((line) => line === "line 31").length, 1, "overlapping windows are not repeated");
  assert.equal(excerpt[excerpt.indexOf("##[error]second") + 1], "…", "a gap between windows is marked");
  assert.equal(excerpt[excerpt.length - 1], "##[error]third");
  assert.ok(!excerpt.includes("line 59"), "nothing after the last error");
});

test("extractJobErrorExcerpt never returns more than 80 lines, counting its leading gap marker", () => {
  const lines = Array.from({ length: 400 }, (_, i) => ts(i % 10 === 9 ? `##[error]fail ${i}` : `line ${i}`));
  const excerpt = extractJobErrorExcerpt(lines.join("\n"));
  assert.equal(excerpt.length, 80);
  assert.equal(excerpt[0], "…");
  assert.equal(excerpt[excerpt.length - 1], "##[error]fail 399");
});

test("extractJobErrorExcerpt falls back to the log's tail when there is no ##[error]", () => {
  const lines = Array.from({ length: 50 }, (_, i) => ts(`line ${i}`));
  const excerpt = extractJobErrorExcerpt(`${lines.join("\n")}\n\n`);
  assert.equal(excerpt.length, 30);
  assert.equal(excerpt[excerpt.length - 1], "line 49");
});

const createdAt = "2026-10-14T08:00:00Z";
const after = (ms: number) => Date.parse(createdAt) + ms;

test("formatRunHeartbeat names the jobs in progress, timed from the run's start", () => {
  const job = (name: string, status: string) => ({ databaseId: 1, name, status, conclusion: "", url: "", steps: [] });
  assert.equal(
    formatRunHeartbeat({ status: "in_progress", createdAt, jobs: [job("deploy-vpc", "completed"), job("deploy-aws", "in_progress")] }, after(754_000)),
    "  ...in progress (12m34s elapsed): deploy-aws",
  );
  assert.equal(formatRunHeartbeat({ status: "queued", createdAt, jobs: [] }, after(30_000)), "  ...queued (30s elapsed)");
  assert.equal(formatRunHeartbeat({ status: "queued", createdAt, jobs: [] }, after(-5_000)), "  ...queued (0s elapsed)", "clock skew");
});

test("formatRunHeartbeat never rounds the seconds up to 60", () => {
  assert.equal(formatRunHeartbeat({ status: "in_progress", createdAt, jobs: [] }, after(119_600)), "  ...in progress (1m59s elapsed)");
  assert.equal(formatRunHeartbeat({ status: "in_progress", createdAt, jobs: [] }, after(59_999)), "  ...in progress (59s elapsed)");
});

test("formatRunHeartbeat says a waiting run needs an approval", () => {
  assert.equal(formatRunHeartbeat({ status: "waiting", createdAt, jobs: [] }, after(60_000)), "  ...waiting for an approval (1m00s elapsed)");
});
