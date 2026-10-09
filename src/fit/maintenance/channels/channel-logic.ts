/**
 * Pure logic for branch channels — no I/O, so it can be unit-tested (see
 * tests/channel-logic.test.ts). The impure orchestration (git / bun / gh) lives
 * in ../channels.ts.
 *
 * A "channel" is a GitHub release tag with the four platform binaries attached
 * (fit-linux-x64, fit-linux-arm64, fit-darwin-x64, fit-darwin-arm64), exactly as
 * install.sh downloads them via CHANNEL=<name>. Two channels are "reserved" and
 * managed by their own workflows: `latest` (tip of main, every push) and `ci`
 * (manually promoted). `main` is reserved too since it already equals `latest`.
 *
 * A "branch channel" is a channel that fit-cli publishes automatically for a git
 * branch. Its release body carries a machine marker (see BRANCH_CHANNEL_MARKER)
 * recording the source branch and the exact commit the binaries were built from.
 * That marker does double duty: it lets prune identify only the releases fit-cli
 * created (never touching reserved or hand-made releases), and it lets sync skip
 * rebuilding a branch whose tip hasn't moved.
 */

/** Channels never published, overwritten, or pruned by the branch-channel logic. */
export const RESERVED_CHANNELS = ["latest", "ci", "main"] as const;

/** Marker keyword embedded in a branch-channel release body. */
export const BRANCH_CHANNEL_MARKER = "fit-cli-branch-channel";

export function isReservedChannel(name: string): boolean {
  return (RESERVED_CHANNELS as readonly string[]).includes(name);
}

/**
 * Derive a channel (release-tag) name from a branch name. Git branch names may
 * contain characters that are awkward in a release tag / download URL (notably
 * `/`), so we map anything outside `[A-Za-z0-9._-]` to `-`. The exact branch is
 * preserved separately in the release marker, so this need not be reversible.
 */
export function channelNameForBranch(branch: string): string {
  const stripped = branch.replace(/^refs\/heads\//, "");
  return stripped.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * The fully qualified ref for a branch, accepting either `feature/x` or
 * `refs/heads/feature/x`. Fetching by bare name is ambiguous when a tag of the
 * same name exists, as it does for a branch channel's own release tag.
 */
export function qualifiedBranchRef(branch: string): string {
  return branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
}

/** The source branch + built commit recorded in a branch-channel release body. */
export interface BranchChannelMarker {
  branch: string;
  sha: string;
}

/** Render the marker HTML comment that gets embedded at the top of a release body. */
export function formatMarker(marker: BranchChannelMarker): string {
  return `<!-- ${BRANCH_CHANNEL_MARKER} branch="${marker.branch}" sha="${marker.sha}" -->`;
}

/** Extract a branch-channel marker from a release body, or undefined if absent. */
export function parseMarker(body: string | null | undefined): BranchChannelMarker | undefined {
  if (!body) return undefined;
  const re = new RegExp(`<!--\\s*${BRANCH_CHANNEL_MARKER}\\s+branch="([^"]*)"\\s+sha="([^"]*)"\\s*-->`);
  const m = re.exec(body);
  if (!m) return undefined;
  return { branch: m[1], sha: m[2] };
}

/** True when two git SHAs refer to the same commit, tolerating short vs full forms. */
export function shasMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter);
}

/** A branch on the remote, with the commit its tip currently points at. */
export interface RemoteBranch {
  name: string;
  sha: string;
}

/** An existing release that carries a branch-channel marker. */
export interface BranchChannelRelease {
  tag: string;
  marker: BranchChannelMarker;
}

export type PublishReason = "new" | "changed" | "forced" | "up-to-date";

export interface PublishPlanItem {
  branch: string;
  sha: string;
  channel: string;
  reason: PublishReason;
}

/**
 * Decide, for every eligible remote branch, whether it needs (re)publishing.
 * Reserved branches are dropped entirely. A branch is `new` if it has no channel
 * yet, `changed` if its tip moved past the built commit, `forced` when `force`
 * is set, else `up-to-date` (caller skips those unless it wants to reprint them).
 */
export function planSync(
  branches: readonly RemoteBranch[],
  existing: readonly BranchChannelRelease[],
  force: boolean,
): PublishPlanItem[] {
  const byChannel = new Map(existing.map((r) => [r.tag, r]));
  const plan: PublishPlanItem[] = [];
  for (const branch of branches) {
    if (isReservedChannel(branch.name)) continue;
    const channel = channelNameForBranch(branch.name);
    const current = byChannel.get(channel);
    let reason: PublishReason;
    if (!current) {
      reason = "new";
    } else if (force) {
      reason = "forced";
    } else if (!shasMatch(current.marker.sha, branch.sha)) {
      reason = "changed";
    } else {
      reason = "up-to-date";
    }
    plan.push({ branch: branch.name, sha: branch.sha, channel, reason });
  }
  return plan;
}

/**
 * Branch names that sanitize to the same channel (a publish collision — the last
 * one published would silently overwrite the others). Reserved branches are
 * excluded. Returns only the colliding groups, keyed by channel name.
 */
export function channelCollisions(branches: readonly RemoteBranch[]): Map<string, string[]> {
  const byChannel = new Map<string, string[]>();
  for (const b of branches) {
    if (isReservedChannel(b.name)) continue;
    const channel = channelNameForBranch(b.name);
    const list = byChannel.get(channel) ?? [];
    list.push(b.name);
    byChannel.set(channel, list);
  }
  return new Map([...byChannel].filter(([, names]) => names.length > 1));
}

export interface PrunePlanItem {
  channel: string;
  branch: string;
}

/**
 * Channels to remove: branch-channel releases (identified solely by their marker)
 * whose source branch no longer exists on the remote. Reserved channels carry no
 * marker so they can never appear here, and neither can hand-made releases.
 */
export function planPrune(
  branches: readonly RemoteBranch[],
  existing: readonly BranchChannelRelease[],
): PrunePlanItem[] {
  const liveBranches = new Set(branches.map((b) => b.name));
  return existing
    .filter((r) => !liveBranches.has(r.marker.branch))
    .map((r) => ({ channel: r.tag, branch: r.marker.branch }));
}
