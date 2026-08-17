import assert from "node:assert/strict";
import { test } from "node:test";
import { imageBlockFromLabels, registryPullToken } from "../util/performer-image-labels.js";

test("the registry token is requested with Basic auth, not Bearer", async () => {
  // ghcr rejects a bearer of the same PAT (401/403). Getting this wrong doesn't look like an
  // auth failure downstream — it looks like "this build declares no revision", which is a much
  // harder thing to notice than an error.
  let seen: string | undefined;
  const fetchImpl = ((url: string, init?: { headers?: Record<string, string> }) => {
    seen = init?.headers?.Authorization;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ token: "registry-token" }) } as unknown as Response);
  }) as unknown as typeof fetch;

  const token = await registryPullToken("couchbase/java-fit-performer", { token: "ghp_example", fetchImpl });
  assert.equal(token, "registry-token");
  assert.ok(seen !== undefined && seen.startsWith("Basic "), `expected Basic auth, got ${seen}`);
  assert.equal(Buffer.from(seen.slice("Basic ".length), "base64").toString(), "x:ghp_example");
});

test("a registry that won't answer is reported, not treated as a build with no revision", async () => {
  const fetchImpl = (() => Promise.resolve({ ok: false, status: 403 } as unknown as Response)) as unknown as typeof fetch;
  await assert.rejects(() => registryPullToken("couchbase/java-fit-performer", { token: "bad", fetchImpl }), /HTTP 403/);
});

test("image labels reduce to the revision and created block", () => {
  assert.deepEqual(
    imageBlockFromLabels({
      "org.opencontainers.image.revision": "abc123",
      "org.opencontainers.image.created": "2026-08-06T15:03:20.363Z",
      "org.opencontainers.image.title": "ignored",
    }),
    { created: "2026-08-06T15:03:20.363Z", revision: "abc123" },
  );
  assert.equal(imageBlockFromLabels(undefined), undefined);
  assert.equal(imageBlockFromLabels({ "some.other.label": "x" }), undefined);
});
