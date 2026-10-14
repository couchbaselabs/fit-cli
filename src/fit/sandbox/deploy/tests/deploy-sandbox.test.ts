/**
 * Unit tests for the sandbox deploy step's defaults and its reading of the finished run.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/sandbox/deploy/tests/deploy-sandbox.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhJobSummary, WorkflowDispatchInput } from "../../../../util/non-fit/gh-workflow.js";
import {
  applyFitCliDefaults,
  failedJobs,
  parseDeployArgs,
  parseOutputSummaryUiUrl,
  promptMessage,
  renderReportSummary,
  selectedSandboxId,
  validateInput,
  withoutPromptSessionFlags,
} from "../deploy-sandbox.js";

const choice = (name: string, options: string[], declared?: string): WorkflowDispatchInput => ({
  name, description: "", type: "choice", options, default: declared ?? options[0], required: false,
});
const text = (name: string, declared = ""): WorkflowDispatchInput => ({
  name, description: "", type: "string", options: [], default: declared, required: false,
});

test("applyFitCliDefaults sets fit-cli's defaults and leaves every other input on the workflow's", () => {
  const { inputs, unapplied } = applyFitCliDefaults([
    choice("type", ["sbx", "qe", "perf"], "qe"),
    text("cloud-id"),
    text("branch"),
    choice("profile", ["default", "medium", "large", "sanity"]),
    text("image-tag", "main"),
    choice("remind-notification", ["No", "Yes"]),
    text("reserved-hours", "1"),
    text("cidr", "127.0.0.1/32"),
    choice("stack-version", ["v1", "v2", "v1+v2"], "v1"),
  ]);
  assert.deepEqual(Object.fromEntries(inputs.map((i) => [i.name, i.default])), {
    "type": "sbx",
    "cloud-id": "",
    "branch": "",
    "profile": "default",
    "image-tag": "main",
    "remind-notification": "No",
    "reserved-hours": "10",
    "cidr": "127.0.0.1/32",
    "stack-version": "v1",
  });
  assert.deepEqual(unapplied, []);
});

test("applyFitCliDefaults reports each of ours the workflow no longer takes, and keeps the workflow's default for it", () => {
  const { inputs, unapplied } = applyFitCliDefaults([choice("type", ["qe", "perf"])], { type: "sbx", "reserved-hours": "10" });
  assert.equal(inputs[0].default, "qe", "an option the choice dropped falls back to the workflow's default");
  assert.deepEqual(unapplied, ["type", "reserved-hours"], "a dropped option and a removed input are both reported");
});

const job = (name: string, conclusion: string, stepNames: string[] = []): GhJobSummary => ({
  databaseId: 1,
  name,
  status: "completed",
  conclusion,
  url: `https://example/${name}`,
  steps: stepNames.map((stepName) => ({ name: stepName, status: "completed", conclusion })),
});

test("selectedSandboxId reads the sandbox from the summary job's step name", () => {
  assert.equal(selectedSandboxId([job("select-sbx", "success"), job("summary", "success", ["Set up job", "Checkout", "Report Summary (sbx-25)"])]), "sbx-25");
  assert.equal(selectedSandboxId([job("summary", "success", ["Report Summary ()"])]), undefined);
  assert.equal(selectedSandboxId([job("select-sbx", "in_progress")]), undefined);
});

test("failedJobs keeps only jobs that failed, not ones skipped or still running", () => {
  const jobs = [
    job("dd-metrics-gate", "skipped"),
    job("deploy-vpc", "success"),
    job("deploy-eks", "failure"),
    job("deploy-kubernetes", "cancelled"),
    job("deploy-crds", ""),
  ];
  assert.deepEqual(failedJobs(jobs).map((j) => j.name), ["deploy-eks", "deploy-kubernetes"]);
});

test("renderReportSummary matches the workflow-summary action's layout", () => {
  assert.deepEqual(renderReportSummary("main", { type: "sbx", "reserved-hours": "10" }), [
    "### Branch",
    "`refs/heads/main`",
    "### Inputs",
    "```json",
    '{\n  "type": "sbx",\n  "reserved-hours": "10"\n}',
    "```",
  ]);
});

test("parseOutputSummaryUiUrl reads the origin of the URL under the Output summary's UI heading", () => {
  const outputSummary = [
    "### Output",
    "Deployed sandbox: sbx-25",
    "Reserved until: 2026-10-14 08:00 UTC",
    "#### UI",
    "https://ui.sbx-25.sandbox.nonprod-project-avengers.com/sign-in",
    "#### Fleet Manager",
    "https://fm.sbx-25.sandbox.nonprod-project-avengers.com/",
  ];
  assert.equal(parseOutputSummaryUiUrl(outputSummary), "https://ui.sbx-25.sandbox.nonprod-project-avengers.com");
  assert.equal(parseOutputSummaryUiUrl(["### Output", "#### Fleet Manager", "https://fm.example/"]), undefined);
  assert.equal(parseOutputSummaryUiUrl(["#### UI", "#### Fleet Manager"]), undefined);
  assert.equal(parseOutputSummaryUiUrl([]), undefined);
  assert.equal(parseOutputSummaryUiUrl(["#### UI", "http://ui.sbx-25.example/sign-in"]), undefined, "only https");
  assert.equal(parseOutputSummaryUiUrl(["#### UI", "https://"]), undefined, "not a URL");
});

test("applyFitCliDefaults gives an input named like an Object.prototype member no default of ours", () => {
  const { inputs, unapplied } = applyFitCliDefaults([text("constructor", "kept"), text("toString")], { type: "sbx" });
  assert.deepEqual(inputs.map((i) => i.default), ["kept", ""]);
  assert.deepEqual(unapplied, ["type"]);
});

test("withoutPromptSessionFlags drops the flags the prompt session reads, keeping the rest", () => {
  assert.deepEqual(withoutPromptSessionFlags(["--replay", "/tmp/fit-cli/x/prompts.json", "deploy"]), ["deploy"]);
  assert.deepEqual(withoutPromptSessionFlags(["deploy", "--defaults", "/tmp/fit-cli/x/prompts.json"]), ["deploy"]);
  assert.deepEqual(withoutPromptSessionFlags(["deploy", "--interactive"]), ["deploy"]);
  assert.deepEqual(withoutPromptSessionFlags(["deploy", "extra"]), ["deploy", "extra"]);
});

test("promptMessage asks for cloud-id as the sandbox, and anything else with the workflow's description", () => {
  assert.match(promptMessage(text("cloud-id")), /^Sandbox to deploy to, e\.g\. sbx-25/);
  assert.match(promptMessage(text("branch")), /^Full commit hash to deploy/);
  assert.match(promptMessage(text("image-tag", "main")), /^Container image tag for the Capella services/);
  assert.equal(promptMessage({ ...text("profile"), description: "The profile to use" }), "profile — The profile to use");
  assert.equal(promptMessage(text("constructor")), "constructor — (no description)");
});

test("parseDeployArgs spots --auto among the prompt session's flags and rejects anything else", () => {
  assert.deepEqual(parseDeployArgs([]), { auto: false, unexpected: [] });
  assert.deepEqual(parseDeployArgs(["--auto"]), { auto: true, unexpected: [] });
  assert.deepEqual(parseDeployArgs(["--replay", "/tmp/fit-cli/x/prompts.json", "--auto"]), { auto: true, unexpected: [] });
  assert.deepEqual(parseDeployArgs(["--default"]), { auto: false, unexpected: ["--default"] });
});

test("validateInput takes only a full commit hash, or nothing, for branch", () => {
  assert.equal(validateInput(text("branch"), ""), true);
  assert.equal(validateInput(text("branch"), "4a5b762c0e3f1d2a9b8c7d6e5f4a3b2c1d0e9f8a"), true);
  assert.match(String(validateInput(text("branch"), "4a5b762")), /full 40-character commit hash/);
  assert.match(String(validateInput(text("branch"), "main")), /full 40-character commit hash/);
  assert.match(String(validateInput({ ...text("ticket"), required: true }, " ")), /ticket is required/);
  assert.equal(validateInput(text("image-tag"), "feature/x"), true);
});
