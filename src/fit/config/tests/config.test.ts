import assert from "node:assert/strict";
import { test } from "node:test";
import { loadEnvironments } from "../../util/environments.js";
import { environmentsJson, isMachineOutputConfigSubcommand } from "../config.js";

test("environmentsJson prints environments.json5 as JSON that parses back to the same values", () => {
  const environments = loadEnvironments();
  const parsed = JSON.parse(environmentsJson(environments)) as typeof environments;
  assert.deepEqual(parsed, environments);
});

test("only config environments is machine output", () => {
  assert.equal(isMachineOutputConfigSubcommand(["environments"]), true);
  assert.equal(isMachineOutputConfigSubcommand(["show"]), false);
  assert.equal(isMachineOutputConfigSubcommand(["edit", "--auto"]), false);
  assert.equal(isMachineOutputConfigSubcommand([]), false);
});
