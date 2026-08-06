import assert from "node:assert/strict";
import { test } from "node:test";
import {
  awsCredentialProcessPayload,
  awsCredsFetchScript,
  remoteAwsConfigFile,
  REMOTE_CREDS_REFRESH_THRESHOLD_MS,
  REMOTE_CREDS_REFRESH_TICK_MS,
  shouldRefreshRemoteCreds,
} from "../remote-aws-creds.js";

const EXPIRY = new Date("2026-08-04T16:54:39.000Z");

test("credential_process payload matches the AWS contract", () => {
  const parsed = JSON.parse(awsCredentialProcessPayload({
    accessKeyId: "ASIAEXAMPLE",
    secretAccessKey: "secret",
    sessionToken: "token",
    expiration: EXPIRY,
  })) as Record<string, unknown>;
  // Version must be the number 1 — the SDK rejects anything else.
  assert.equal(parsed.Version, 1);
  assert.equal(parsed.AccessKeyId, "ASIAEXAMPLE");
  assert.equal(parsed.SecretAccessKey, "secret");
  assert.equal(parsed.SessionToken, "token");
  assert.equal(parsed.Expiration, "2026-08-04T16:54:39.000Z");
});

test("credential_process payload omits Expiration when we cannot know it", () => {
  // The no-assumed-session case (e.g. CI's OIDC identity): reporting an expiry we
  // haven't got would be worse than letting the SDK treat the creds as static.
  const parsed = JSON.parse(awsCredentialProcessPayload({
    accessKeyId: "ASIAEXAMPLE",
    secretAccessKey: "secret",
  })) as Record<string, unknown>;
  assert.equal("Expiration" in parsed, false);
  assert.equal("SessionToken" in parsed, false);
});

test("payload is newline-terminated so `cat` output is well-formed", () => {
  assert.ok(awsCredentialProcessPayload({ accessKeyId: "a", secretAccessKey: "b" }).endsWith("\n"));
});

test("~/.aws/config points at the credential_process, not static keys", () => {
  const config = remoteAwsConfigFile("/home/ubuntu/fit-workspace/fit-aws-creds-fetch.sh", "us-west-2");
  assert.match(config, /^\[default\]$/m);
  assert.match(config, /^region = us-west-2$/m);
  assert.match(config, /^credential_process = \/home\/ubuntu\/fit-workspace\/fit-aws-creds-fetch\.sh$/m);
  // Static credentials in the config file would defeat the point: they'd never refresh.
  assert.doesNotMatch(config, /aws_access_key_id/);
});

test("~/.aws/config rejects a credential_process path with whitespace", () => {
  // The SDK splits the value as a command line, and quoting rules vary between SDKs, so a
  // path with spaces must fail loudly rather than produce a config that resolves nothing.
  assert.throws(
    () => remoteAwsConfigFile("/home/ubuntu/fit workspace/fit-aws-creds-fetch.sh"),
    /must not contain whitespace/,
  );
});

test("fetch script execs cat on the payload path", () => {
  const script = awsCredsFetchScript("/home/ubuntu/fit-workspace/fit-aws-creds.json");
  assert.ok(script.startsWith("#!/bin/sh\n"));
  assert.match(script, /exec cat \/home\/ubuntu\/fit-workspace\/fit-aws-creds\.json/);
});

test("fetch script quotes paths that need it", () => {
  assert.match(awsCredsFetchScript("/home/a b/creds.json"), /exec cat '\/home\/a b\/creds\.json'/);
});

test("refresh triggers at the threshold, not before", () => {
  const now = new Date("2026-08-04T16:00:00.000Z");
  const at = (ms: number): Date => new Date(now.getTime() + ms);
  const minutes = (n: number): number => n * 60 * 1000;
  // Threshold passed explicitly so this tests the predicate, not the shipped constant
  // (which is pinned separately below, and is sometimes overridden while validating a run).
  const due = (expiresInMinutes: number): boolean =>
    shouldRefreshRemoteCreds(at(minutes(expiresInMinutes)), now, minutes(30));

  assert.equal(due(60), false, "a freshly issued 1h session is not due");
  assert.equal(due(31), false, "just outside the threshold");
  assert.equal(due(30), true, "exactly at it — so a 1h session renews every ~30 minutes");
  assert.equal(due(5), true);
  assert.equal(due(-5), true, "already expired — keep trying rather than giving up");
});

test("ships with a 30-minute threshold and a 5-minute tick", () => {
  // Guards against a temporarily-shortened threshold (handy for validating a real run)
  // being committed by accident.
  assert.equal(REMOTE_CREDS_REFRESH_THRESHOLD_MS, 30 * 60 * 1000);
  assert.equal(REMOTE_CREDS_REFRESH_TICK_MS, 5 * 60 * 1000);
});

test("no expiry means nothing to schedule against", () => {
  // We didn't assume these credentials, so their lifecycle isn't ours to manage.
  assert.equal(shouldRefreshRemoteCreds(undefined, new Date()), false);
});

test("a failed refresh has several retries before credentials lapse", () => {
  // The whole point of ticking faster than the threshold: one bad scp isn't fatal.
  assert.ok(REMOTE_CREDS_REFRESH_TICK_MS < REMOTE_CREDS_REFRESH_THRESHOLD_MS);
  assert.ok(REMOTE_CREDS_REFRESH_THRESHOLD_MS / REMOTE_CREDS_REFRESH_TICK_MS >= 5);
});

test("threshold exceeds the assume-role refresh margin it is passed as", () => {
  // freshAssumedCredentials() is called with this value as its margin. If it were below
  // the default 5-minute margin, ensureFreshFitCliRole would report the cached session as
  // still fresh and hand back identical credentials, making every refresh a no-op.
  assert.ok(REMOTE_CREDS_REFRESH_THRESHOLD_MS > 5 * 60 * 1000);
});
