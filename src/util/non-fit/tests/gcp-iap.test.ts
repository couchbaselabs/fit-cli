/**
 * Unit tests for the pure gcloud IAP-tunnel argument builders.
 *
 * Run on their own:
 *   node --import tsx --test src/util/non-fit/tests/gcp-iap.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIapScpArgs, buildIapSshArgs, type IapHost } from "../gcp-iap.js";

const HOST: IapHost = { instance: "fit-cli-gcp-spike", zone: "us-west1-a" };

test("buildIapSshArgs tunnels through IAP and joins the remote command into --command", () => {
  const args = buildIapSshArgs(HOST, "echo", ["hello", "world"]);
  assert.deepEqual(args.slice(0, 2), ["compute", "ssh"]);
  assert.ok(args.includes("ubuntu@fit-cli-gcp-spike"));
  assert.ok(args.includes("--tunnel-through-iap"));
  const zoneIndex = args.indexOf("--zone");
  assert.equal(args[zoneIndex + 1], "us-west1-a");
  const commandIndex = args.indexOf("--command");
  assert.equal(args[commandIndex + 1], "echo hello world");
});

test("buildIapSshArgs includes --project only when the host specifies one", () => {
  const withoutProject = buildIapSshArgs(HOST, "true");
  assert.ok(!withoutProject.includes("--project"));

  const withProject = buildIapSshArgs({ ...HOST, project: "my-project" }, "true");
  const projectIndex = withProject.indexOf("--project");
  assert.equal(withProject[projectIndex + 1], "my-project");
});

test("buildIapSshArgs honours a custom login user", () => {
  const args = buildIapSshArgs({ ...HOST, user: "ec2-user" }, "true");
  assert.ok(args.includes("ec2-user@fit-cli-gcp-spike"));
});

test("buildIapScpArgs up puts the local path first and remote target second", () => {
  const args = buildIapScpArgs(HOST, "/local/file", "/remote/file", "up");
  assert.deepEqual(args.slice(0, 2), ["compute", "scp"]);
  assert.deepEqual(args.slice(-2), ["/local/file", "ubuntu@fit-cli-gcp-spike:/remote/file"]);
});

test("buildIapScpArgs down puts the remote source first and local path second", () => {
  const args = buildIapScpArgs(HOST, "/local/file", "/remote/file", "down");
  assert.deepEqual(args.slice(-2), ["ubuntu@fit-cli-gcp-spike:/remote/file", "/local/file"]);
});

test("buildIapSshArgs passes --quiet so a key-generation prompt can never block CI", () => {
  assert.ok(buildIapSshArgs(HOST, "true").includes("--quiet"));
});

test("buildIapScpArgs passes --quiet too", () => {
  assert.ok(buildIapScpArgs(HOST, "/local/file", "/remote/file", "up").includes("--quiet"));
});
