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
