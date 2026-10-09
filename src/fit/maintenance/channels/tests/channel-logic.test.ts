import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  channelCollisions,
  channelNameForBranch,
  formatMarker,
  isReservedChannel,
  parseMarker,
  planPrune,
  planSync,
  qualifiedBranchRef,
  shasMatch,
  type BranchChannelRelease,
  type RemoteBranch,
} from "../channel-logic.js";

describe("channelNameForBranch", () => {
  it("passes through a simple branch name", () => {
    assert.equal(channelNameForBranch("my-feature"), "my-feature");
  });

  it("maps slashes and other awkward chars to dashes", () => {
    assert.equal(channelNameForBranch("feature/foo bar"), "feature-foo-bar");
    assert.equal(channelNameForBranch("user/JIRA-123"), "user-JIRA-123");
  });

  it("strips a refs/heads/ prefix", () => {
    assert.equal(channelNameForBranch("refs/heads/feature/x"), "feature-x");
  });

  it("keeps dots, underscores and dashes", () => {
    assert.equal(channelNameForBranch("v1.2_rc-3"), "v1.2_rc-3");
  });
});

describe("qualifiedBranchRef", () => {
  it("adds refs/heads/ to a bare branch name", () => {
    assert.equal(qualifiedBranchRef("feature/x"), "refs/heads/feature/x");
  });

  it("leaves an already-qualified ref unchanged", () => {
    assert.equal(qualifiedBranchRef("refs/heads/feature/x"), "refs/heads/feature/x");
  });
});

describe("isReservedChannel", () => {
  it("treats latest, ci and main as reserved", () => {
    assert.equal(isReservedChannel("latest"), true);
    assert.equal(isReservedChannel("ci"), true);
    assert.equal(isReservedChannel("main"), true);
  });

  it("treats anything else as not reserved", () => {
    assert.equal(isReservedChannel("my-feature"), false);
    assert.equal(isReservedChannel("mainish"), false);
  });
});

describe("marker round-trip", () => {
  it("formats and parses back a marker", () => {
    const marker = { branch: "feature/foo", sha: "abc123def456" };
    const body = `${formatMarker(marker)}\nSome notes here.`;
    assert.deepEqual(parseMarker(body), marker);
  });

  it("returns undefined for a body without a marker", () => {
    assert.equal(parseMarker("just some release notes"), undefined);
    assert.equal(parseMarker(""), undefined);
    assert.equal(parseMarker(null), undefined);
    assert.equal(parseMarker(undefined), undefined);
  });
});

describe("shasMatch", () => {
  it("matches identical shas", () => {
    assert.equal(shasMatch("abcdef1234", "abcdef1234"), true);
  });
  it("matches short vs long prefixes", () => {
    assert.equal(shasMatch("abcdef", "abcdef1234567890"), true);
    assert.equal(shasMatch("abcdef1234567890", "abcdef"), true);
  });
  it("rejects non-matching or empty", () => {
    assert.equal(shasMatch("abcdef", "abcxyz"), false);
    assert.equal(shasMatch("", "abcdef"), false);
    assert.equal(shasMatch("abcdef", ""), false);
  });
});

const rel = (tag: string, branch: string, sha: string): BranchChannelRelease => ({ tag, marker: { branch, sha } });
const br = (name: string, sha: string): RemoteBranch => ({ name, sha });

describe("planSync", () => {
  it("skips reserved branches", () => {
    const plan = planSync([br("main", "a"), br("ci", "b")], [], false);
    assert.equal(plan.length, 0);
  });

  it("marks branches with no channel as new", () => {
    const plan = planSync([br("feat", "sha1")], [], false);
    assert.deepEqual(plan, [{ branch: "feat", sha: "sha1", channel: "feat", reason: "new" }]);
  });

  it("marks a moved tip as changed", () => {
    const plan = planSync([br("feat", "sha2")], [rel("feat", "feat", "sha1")], false);
    assert.equal(plan[0].reason, "changed");
  });

  it("marks an unchanged tip as up-to-date", () => {
    const plan = planSync([br("feat", "sha1")], [rel("feat", "feat", "sha1")], false);
    assert.equal(plan[0].reason, "up-to-date");
  });

  it("force overrides up-to-date", () => {
    const plan = planSync([br("feat", "sha1")], [rel("feat", "feat", "sha1")], true);
    assert.equal(plan[0].reason, "forced");
  });

  it("matches an existing channel via the sanitized branch name", () => {
    const plan = planSync([br("feature/foo", "sha1")], [rel("feature-foo", "feature/foo", "sha1")], false);
    assert.equal(plan[0].channel, "feature-foo");
    assert.equal(plan[0].reason, "up-to-date");
  });
});

describe("channelCollisions", () => {
  it("reports branches that sanitize to the same channel", () => {
    const collisions = channelCollisions([br("a/b", "s1"), br("a-b", "s2"), br("solo", "s3")]);
    assert.deepEqual([...collisions], [["a-b", ["a/b", "a-b"]]]);
  });

  it("returns nothing when every channel is unique", () => {
    assert.equal(channelCollisions([br("a", "s1"), br("b", "s2")]).size, 0);
  });

  it("ignores reserved branches", () => {
    assert.equal(channelCollisions([br("main", "s1"), br("main", "s2")]).size, 0);
  });
});

describe("planPrune", () => {
  it("prunes channels whose branch no longer exists", () => {
    const releases = [rel("gone", "gone", "s1"), rel("live", "live", "s2")];
    const branches = [br("live", "s2")];
    assert.deepEqual(planPrune(branches, releases), [{ channel: "gone", branch: "gone" }]);
  });

  it("prunes nothing when every marker branch is live", () => {
    const releases = [rel("a", "a", "s1"), rel("feature-foo", "feature/foo", "s2")];
    const branches = [br("a", "s1"), br("feature/foo", "s2")];
    assert.deepEqual(planPrune(branches, releases), []);
  });
});
