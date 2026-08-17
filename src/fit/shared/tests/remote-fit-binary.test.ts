import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chooseReleaseChannel, fitCliRepoRoot, linuxArchFromUname, stageFitCliBinary } from "../util/remote-fit-binary.js";
import { releaseAssetUrl } from "../../upgrade/upgrade.js";
import type { FitExecutionContext } from "../util/remote-fit-run.js";

test("linuxArchFromUname maps what uname actually prints", () => {
  assert.equal(linuxArchFromUname("x86_64\n"), "x64");
  assert.equal(linuxArchFromUname("amd64"), "x64");
  assert.equal(linuxArchFromUname("aarch64\n"), "arm64");
  assert.equal(linuxArchFromUname("arm64"), "arm64");
});

test("linuxArchFromUname refuses an architecture fit-cli publishes no binary for", () => {
  // Better to say so before provisioning than to ship a binary that won't exec.
  assert.throws(() => linuxArchFromUname("armv7l"), /armv7l/);
});

test("fitCliRepoRoot finds the checkout these tests are running from", () => {
  const root = fitCliRepoRoot();
  assert.ok(root, "expected a repo root when running from source");
  assert.ok(existsSync(join(root, "src", "fit", "main", "main.ts")));
});

test("stageFitCliBinary does nothing for a local execution context", async () => {
  // A local run is already executing the binary in question; touching the target at all
  // would be wrong, so the stub throws on any use.
  const execution = {
    kind: "local",
    description: "this machine",
    capture: () => Promise.reject(new Error("must not touch the target for a local context")),
    stageFile: () => Promise.reject(new Error("must not stage for a local context")),
  } as unknown as FitExecutionContext;

  assert.equal(await stageFitCliBinary(execution), process.execPath);
});

test("chooseReleaseChannel downloads the build this binary actually is", () => {
  const tips = [
    { channel: "ci" as const, sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { channel: "latest" as const, sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  ];
  // Short form, as `fit version` prints it — shasMatch tolerates the prefix.
  const chosen = chooseReleaseChannel("bbbbbbbbbbbb", tips);
  assert.deepEqual(chosen, { channel: "latest", sha: tips[1]?.sha, matchesThisBuild: true });
});

test("chooseReleaseChannel prefers ci when both tags sit on this commit", () => {
  // Just after a promotion the two channels are the same commit, and `ci` is the more
  // meaningful name to have in the log.
  const sha = "cccccccccccccccccccccccccccccccccccccccc";
  const chosen = chooseReleaseChannel(sha, [
    { channel: "latest", sha },
    { channel: "ci", sha },
  ]);
  assert.equal(chosen.channel, "ci");
  assert.equal(chosen.matchesThisBuild, true);
});

test("chooseReleaseChannel still picks a channel for a stale install, but flags it", () => {
  // A mac install goes stale as soon as anything lands on main. Refusing here would make
  // remote perf broken-by-default for exactly the users it exists to serve.
  const chosen = chooseReleaseChannel("deadbeefdead", [
    { channel: "ci", sha: "1111111111111111111111111111111111111111" },
    { channel: "latest", sha: "2222222222222222222222222222222222222222" },
  ]);
  assert.equal(chosen.channel, "ci");
  assert.equal(chosen.matchesThisBuild, false);
});

test("chooseReleaseChannel still names a channel when the release API is unreachable", () => {
  // The asset download doesn't go through that API, so an API wobble shouldn't be what stops
  // a perf run. No sha means the download can't be identified, hence can't be cached either.
  const chosen = chooseReleaseChannel("abc", []);
  assert.equal(chosen.channel, "ci");
  assert.equal(chosen.sha, undefined);
  assert.equal(chosen.matchesThisBuild, false);
});

test("releaseAssetUrl matches the scheme install.sh downloads from", () => {
  assert.equal(
    releaseAssetUrl("ci", "fit-linux-arm64"),
    "https://github.com/couchbaselabs/fit-cli/releases/download/ci/fit-linux-arm64",
  );
});
