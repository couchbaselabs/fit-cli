import test from "node:test";
import assert from "node:assert/strict";
import { producedOnlyBoilerplate } from "../artifacts.js";

const boilerplate = [
  { filename: "session.info.log", explanation: "Terminal output log for this fit-cli session" },
  { filename: "session.debug.log", explanation: "Full command I/O log" },
  { filename: "prompts.json", explanation: "(captured during the run)" },
];

test("producedOnlyBoilerplate: a bookkeeping command that wrote nothing else", () => {
  assert.equal(producedOnlyBoilerplate(boilerplate), true);
});

test("producedOnlyBoilerplate: a real run, which also captured a definition and an instance", () => {
  assert.equal(
    producedOnlyBoilerplate([
      ...boilerplate,
      { filename: "fit.json5", explanation: "Definition file used for this run" },
      { filename: "instances/aws1/ec2-instance.json", explanation: "(captured during the run)" },
    ]),
    false,
  );
});

test("producedOnlyBoilerplate: an empty artifact list counts as nothing worth keeping", () => {
  assert.equal(producedOnlyBoilerplate([]), true);
});

test("runArtifactsWorthUploading: a failure always uploads; success only when it made something not kept elsewhere", async () => {
  const { runArtifactsWorthUploading, combineRunOutputs } = await import("../artifacts.js");
  const report = [...boilerplate, { filename: "health-report.html", explanation: "The health report as a page" }];
  assert.equal(runArtifactsWorthUploading(false, boilerplate, {}), false);
  assert.equal(runArtifactsWorthUploading(false, report, {}), true);
  assert.equal(runArtifactsWorthUploading(false, report, { artifactsKeptElsewhere: true }), false);
  assert.equal(runArtifactsWorthUploading(true, report, { artifactsKeptElsewhere: true }), true);
  // The flag survives runCli merging the command's output with the session logs.
  assert.equal(combineRunOutputs({ artifactsKeptElsewhere: true, artifacts: [] }, { artifacts: boilerplate }).artifactsKeptElsewhere, true);
  assert.equal(combineRunOutputs({ artifacts: [] }).artifactsKeptElsewhere, undefined);
});
