import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capellaFunctionalCbdinoclusterInitArgs,
  capellaKeyPoolInitArgs,
  defaultCbdinoclusterInitArgs,
  situationalCbdinoclusterInitArgs,
} from "../default-cbdinocluster-init-config.js";

test("default init args disable Capella (functional doesn't need it)", () => {
  assert.match(defaultCbdinoclusterInitArgs(), /--disable-capella/);
});

test("default init args disable AWS (functional doesn't need it)", () => {
  assert.match(defaultCbdinoclusterInitArgs(), /--disable-aws/);
});

test("situational init args leave Capella enabled so `init --auto` populates it from CAPELLA_* env", () => {
  assert.doesNotMatch(situationalCbdinoclusterInitArgs(), /--disable-capella/);
});

test("situational init args include --aws-region so init --auto enables the aws block directly", () => {
  const args = situationalCbdinoclusterInitArgs();
  assert.doesNotMatch(args, /--disable-aws/);
  assert.match(args, /--aws-region /);
});

test("situational init args default to aws when no cloud provider is given", () => {
  const args = situationalCbdinoclusterInitArgs();
  assert.doesNotMatch(args, /--disable-aws/);
  assert.match(args, /--aws-region /);
  assert.match(args, /--disable-gcp/);
});

test("situational init args enable only gcp for a gcp cloud provider", () => {
  const args = situationalCbdinoclusterInitArgs(undefined, "gcp");
  assert.match(args, /--disable-aws/);
  assert.doesNotMatch(args, /--disable-gcp/);
  assert.match(args, /--gcp-project-id /);
  assert.match(args, /--gcp-region /);
});

test("capella functional init args disable both aws and gcp when private endpoint isn't requested", () => {
  const args = capellaFunctionalCbdinoclusterInitArgs("aws");
  assert.match(args, /--disable-aws/);
  assert.match(args, /--disable-gcp/);
});

test("capella functional init args enable only aws for an AWS private endpoint", () => {
  const args = capellaFunctionalCbdinoclusterInitArgs("aws", undefined, true);
  assert.doesNotMatch(args, /--disable-aws/);
  assert.match(args, /--aws-region /);
  assert.match(args, /--disable-gcp/);
});

test("capella functional init args enable only gcp for a GCP private endpoint", () => {
  const args = capellaFunctionalCbdinoclusterInitArgs("gcp", undefined, true);
  assert.match(args, /--disable-aws/);
  assert.doesNotMatch(args, /--disable-gcp/);
  assert.match(args, /--gcp-project-id /);
  assert.match(args, /--gcp-region /);
});

const POOL = { enabled: true, size: 10, expiryDays: 1 };

test("key pool args carry the pool name, size and expiry when Capella is enabled", () => {
  const initArgs = capellaFunctionalCbdinoclusterInitArgs("aws").split(" ");
  assert.deepEqual(capellaKeyPoolInitArgs(initArgs, "fitcli-run-user", POOL), [
    "--capella-create-pool",
    "--capella-pool-name",
    "fitcli-run-user",
    "--capella-pool-size",
    "10",
    "--capella-pool-expiry",
    "1",
  ]);
});

test("key pool args are empty when the pool is disabled", () => {
  const initArgs = capellaFunctionalCbdinoclusterInitArgs("aws").split(" ");
  assert.deepEqual(capellaKeyPoolInitArgs(initArgs, "fitcli-run-user", { ...POOL, enabled: false }), []);
});

test("key pool args are empty when the init args disable Capella", () => {
  const initArgs = defaultCbdinoclusterInitArgs().split(" ");
  assert.deepEqual(capellaKeyPoolInitArgs(initArgs, "fitcli-run-user", POOL), []);
});
