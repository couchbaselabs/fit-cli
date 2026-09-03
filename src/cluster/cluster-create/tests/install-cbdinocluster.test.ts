import assert from "node:assert/strict";
import test from "node:test";
import {
  remoteInstallScript,
  remoteBuildFromPrScript,
  installCbdinoclusterRemote,
  PINNED_GO_VERSION,
} from "../install-cbdinocluster.js";
import { loadEnvironments } from "../../../fit/util/environments.js";

/**
 * An explicit release tag for the tests that are about the *shape* of the install
 * script. They used to rely on `defaults.cbdinoclusterVersion`, which broke all of
 * them the moment that was pinned to a branch build (4954de6) — the script shape
 * has nothing to do with which version is configured, so it is passed in here.
 */
const A_RELEASE_TAG = "v0.0.120";

/** A {@link CaptureExecutor}-shaped stub that just records the last `sh -lc <script>` it ran. */
function fakeExecutor() {
  let lastScript = "";
  return {
    description: "fake box",
    lastScript: () => lastScript,
    capture(command: string, args: string[]) {
      if (command === "sh" && args[0] === "-lc") {
        lastScript = args[1];
      }
      // Any non-empty stdout line satisfies parseInstalledPath / the version-log capture.
      return Promise.resolve("/home/ubuntu/.local/bin/cbdinocluster");
    },
  };
}

test("remoteInstallScript: normalises amd64 arch", () => {
  const script = remoteInstallScript(undefined, A_RELEASE_TAG);
  assert.ok(script.includes("x86_64|amd64) arch=amd64"));
});

test("remoteInstallScript: normalises arm64 arch", () => {
  const script = remoteInstallScript(undefined, A_RELEASE_TAG);
  assert.ok(script.includes("aarch64|arm64) arch=arm64"));
});

test("remoteInstallScript: downloads the pinned release", () => {
  const script = remoteInstallScript(undefined, "v0.0.120");
  assert.ok(script.includes("couchbaselabs/cbdinocluster"));
  assert.ok(script.includes("releases/download/v0.0.120/cbdinocluster-"));
});

test("remoteInstallScript: with no version given, follows defaults.cbdinoclusterVersion", () => {
  // Deliberately asserts against whatever is configured rather than a hardcoded
  // tag: this default legitimately moves between a release tag and a
  // { branch } / { pr } build, and only the release form is installable here.
  const configured = loadEnvironments().defaults.cbdinoclusterVersion;
  if (typeof configured !== "string") {
    assert.throws(() => remoteInstallScript(), /not a release tag/);
    return;
  }
  assert.ok(remoteInstallScript().includes(`releases/download/${configured}/cbdinocluster-`));
});

test("remoteInstallScript: last stdout line prints the installed path", () => {
  const script = remoteInstallScript(undefined, A_RELEASE_TAG);
  const lines = script.split("\n").filter(Boolean);
  const last = lines[lines.length - 1];
  assert.ok(last.includes("printf '%s\\n'"), `unexpected last line: ${last}`);
  assert.ok(last.includes("$target"), `missing $target in: ${last}`);
});

test("remoteInstallScript: uses custom binDir", () => {
  const script = remoteInstallScript("/opt/mybin", A_RELEASE_TAG);
  assert.ok(script.includes('bindir="/opt/mybin"'));
});

test("remoteInstallScript: default binDir is $HOME/.local/bin", () => {
  const script = remoteInstallScript(undefined, A_RELEASE_TAG);
  assert.ok(script.includes('bindir="$HOME/.local/bin"'));
});

test("remoteBuildFromPrScript: clones canonical repo when no override given", () => {
  const script = remoteBuildFromPrScript({ pr: 42 });
  assert.ok(script.includes("https://github.com/couchbaselabs/cbdinocluster"));
});

test("remoteBuildFromPrScript: clones fork when repo is specified", () => {
  const script = remoteBuildFromPrScript({ pr: 42, repo: "myfork/cbdinocluster" });
  assert.ok(script.includes("https://github.com/myfork/cbdinocluster"));
  assert.ok(!script.includes("couchbaselabs/cbdinocluster"));
});

test("remoteBuildFromPrScript: fetches the correct PR ref", () => {
  const script = remoteBuildFromPrScript({ pr: 123 });
  assert.ok(script.includes("refs/pull/123/head"));
  assert.ok(script.includes("FETCH_HEAD"));
});

test("remoteBuildFromPrScript: different PR numbers produce different fetch refs", () => {
  const s7 = remoteBuildFromPrScript({ pr: 7 });
  const s99 = remoteBuildFromPrScript({ pr: 99 });
  assert.ok(s7.includes("refs/pull/7/head"));
  assert.ok(s99.includes("refs/pull/99/head"));
  assert.ok(!s7.includes("refs/pull/99/head"));
});

test("remoteBuildFromPrScript: auto-installs Go when missing", () => {
  const script = remoteBuildFromPrScript({ pr: 1 });
  assert.ok(script.includes("command -v go"));
  assert.ok(script.includes("go.dev/dl/"));
  assert.ok(script.includes(PINNED_GO_VERSION));
});

test("remoteBuildFromPrScript: builds with go build", () => {
  const script = remoteBuildFromPrScript({ pr: 1 });
  assert.ok(script.includes("go build -o"));
});

test("remoteBuildFromPrScript: cleans up the clone dir", () => {
  const script = remoteBuildFromPrScript({ pr: 1 });
  assert.ok(script.includes("rm -rf"));
});

test("remoteBuildFromPrScript: last stdout line prints the installed path", () => {
  const script = remoteBuildFromPrScript({ pr: 1 });
  const lines = script.split("\n").filter(Boolean);
  const last = lines[lines.length - 1];
  assert.ok(last.includes("printf '%s\\n'"), `unexpected last line: ${last}`);
  assert.ok(last.includes("$target"), `missing $target in: ${last}`);
});

test("remoteBuildFromPrScript: uses custom binDir", () => {
  const script = remoteBuildFromPrScript({ pr: 1 }, "/opt/mybin");
  assert.ok(script.includes('bindir="/opt/mybin"'));
});

test("remoteBuildFromPrScript: respects custom Go version", () => {
  const script = remoteBuildFromPrScript({ pr: 1 }, undefined, "1.21.0");
  assert.ok(script.includes("1.21.0"));
  assert.ok(!script.includes(PINNED_GO_VERSION));
});

test("remoteBuildFromPrScript: fetches a branch by name when given instead of a PR", () => {
  const script = remoteBuildFromPrScript({ branch: "retry-cluster-poll-network-errors" });
  assert.ok(script.includes("git -C \"$clonedir\" fetch origin retry-cluster-poll-network-errors"));
  assert.ok(script.includes("FETCH_HEAD"));
  assert.ok(!script.includes("refs/pull/"));
});

test("remoteBuildFromPrScript: branch build clones fork when repo is specified", () => {
  const script = remoteBuildFromPrScript({ branch: "my-fix", repo: "myfork/cbdinocluster" });
  assert.ok(script.includes("https://github.com/myfork/cbdinocluster"));
});

test("installCbdinoclusterRemote: downloads a release when given a version string", async () => {
  const executor = fakeExecutor();
  await installCbdinoclusterRemote(executor, undefined, "v0.0.120");
  assert.ok(executor.lastScript().includes("releases/download/v0.0.120/cbdinocluster-"));
});

test("installCbdinoclusterRemote: builds from a PR when given a { pr } source", async () => {
  const executor = fakeExecutor();
  await installCbdinoclusterRemote(executor, undefined, { pr: 123 });
  assert.ok(executor.lastScript().includes("refs/pull/123/head"));
});

test("installCbdinoclusterRemote: builds from a branch when given a { branch } source", async () => {
  const executor = fakeExecutor();
  await installCbdinoclusterRemote(executor, undefined, { branch: "my-fix" });
  assert.ok(executor.lastScript().includes("fetch origin my-fix"));
});
