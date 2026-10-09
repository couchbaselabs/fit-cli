#!/usr/bin/env node
/**
 * `fit maintenance channels` — publish git branches as installable release
 * "channels", and prune channels whose branch has been deleted.
 *
 * A channel is a GitHub release tag with the four platform binaries attached,
 * exactly as install.sh downloads them (`CHANNEL=<name>`). Publishing a branch
 * builds those binaries from that branch's source — reproducing what CI does —
 * and creates/replaces a release named after the branch. See channel-logic.ts
 * for the reserved-channel and marker rules.
 *
 * Subcommands:
 *   list             Show every branch channel, its built commit, and branch status.
 *   publish [branch] Build & publish one branch as a channel (default: current branch).
 *   sync             Publish every eligible remote branch (skips unchanged unless --force).
 *   prune            Delete channels whose source branch no longer exists.
 *
 * `sync --prune` does both, and is what the Maintenance workflow runs nightly.
 * Flags: --force (rebuild even if unchanged), --dry-run (plan only, no changes).
 *
 * publish/sync build binaries, so they must run from source (bun + checkout);
 * list/prune only talk to the GitHub API and work from the installed binary too.
 *
 * Debug directly (not a stable CLI path):
 *   bun src/fit/maintenance/channels/channels.ts list
 *   bun src/fit/maintenance/channels/channels.ts publish my-branch --dry-run
 */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isMain } from "../../../util/non-fit/cli.js";
import { capture, run } from "../../../util/non-fit/proc.js";
import { isFitBinary, runScriptPrefix } from "../../../util/non-fit/fit-cli-log.js";
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
} from "./channel-logic.js";

const REPO = "couchbaselabs/fit-cli";
const REPO_URL = `https://github.com/${REPO}.git`;
const INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${REPO}/main/install.sh`;

/** Compile targets → release asset names, matching install.sh's detect_target. */
const BUILD_TARGETS = [
  { target: "bun-linux-x64", asset: "fit-linux-x64" },
  { target: "bun-linux-arm64", asset: "fit-linux-arm64" },
  { target: "bun-darwin-x64", asset: "fit-darwin-x64" },
  { target: "bun-darwin-arm64", asset: "fit-darwin-arm64" },
] as const;

export interface ChannelsArgs {
  force: boolean;
  dryRun: boolean;
  prune: boolean;
  help: boolean;
  positionals: string[];
}

export function parseChannelsArgs(argv: readonly string[]): ChannelsArgs {
  const args: ChannelsArgs = { force: false, dryRun: false, prune: false, help: false, positionals: [] };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--force" || arg === "-f") args.force = true;
    else if (arg === "--dry-run" || arg === "-n") args.dryRun = true;
    else if (arg === "--prune") args.prune = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown argument: ${arg}`);
    else args.positionals.push(arg);
  }
  return args;
}

export function helpText(): string {
  const p = runScriptPrefix("maintenance");
  return `Publish git branches as installable release channels, and prune deleted ones.

Usage:
  ${p} channels list
  ${p} channels publish [branch] [--force] [--dry-run]
  ${p} channels sync [--force] [--prune] [--dry-run]
  ${p} channels prune [--dry-run]

Subcommands:
  list             Show every branch channel, its built commit, and branch status.
  publish [branch] Build & publish one branch as a channel (default: current branch).
  sync             Publish every eligible remote branch as a channel.
  prune            Delete channels whose source branch no longer exists.

Flags:
  --force, -f    Rebuild/republish even if the branch tip is unchanged.
  --prune        (sync only) Also prune channels for deleted branches afterwards.
  --dry-run, -n  Show what would change without building, publishing, or deleting.

A channel is installed with:  CHANNEL=<channel> bash <(curl -fsSL ${INSTALL_SCRIPT_URL})
Reserved channels (latest, ci, main) are managed separately and never touched here.
publish/sync build binaries, so run them from source (bun run maintenance ...).`;
}

/** Fetch all branch-channel releases (those carrying a marker) from the GitHub API. */
async function listBranchChannelReleases(): Promise<BranchChannelRelease[]> {
  const out = await capture("gh", [
    "api",
    "--paginate",
    `repos/${REPO}/releases`,
    "--jq",
    ".[] | {tag: .tag_name, body: .body} | tojson",
  ]);
  const releases: BranchChannelRelease[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const { tag, body } = JSON.parse(trimmed) as { tag: string; body: string | null };
    const marker = parseMarker(body);
    if (marker) releases.push({ tag, marker });
  }
  return releases;
}

/** Fetch every remote branch and the commit its tip points at. */
async function listRemoteBranches(): Promise<RemoteBranch[]> {
  const out = await capture("gh", [
    "api",
    "--paginate",
    `repos/${REPO}/branches`,
    "--jq",
    ".[] | {name: .name, sha: .commit.sha} | tojson",
  ]);
  const branches: RemoteBranch[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    branches.push(JSON.parse(trimmed) as RemoteBranch);
  }
  return branches;
}

function releaseNotes(channel: string, branch: string, sha: string): string {
  return `${formatMarker({ branch, sha })}
> ⚠️ **Auto-published channel for the \`${branch}\` branch, built at \`${sha}\`. It is
> removed automatically when the branch is deleted. Not a stable release — use the
> \`ci\` channel for anything that matters.**

## Install

\`\`\`sh
curl -fsSL ${INSTALL_SCRIPT_URL} | CHANNEL=${channel} bash
\`\`\`

Published by \`${runScriptPrefix("maintenance")} channels\`.`;
}

/**
 * Build the four platform binaries from a branch's source and publish them as a
 * channel release. Uses a detached worktree at the branch tip so the current
 * working tree is untouched and no local branch (which could collide with the
 * release tag) is created. Bakes the branch's own commit into the binaries.
 */
async function buildAndPublish(branch: string, dryRun: boolean): Promise<void> {
  const channel = channelNameForBranch(branch);

  // Bring the branch tip local and resolve the exact commit we'll build & tag.
  // Fetch from the canonical repo URL rather than a named remote: the remote is
  // "origin" in the GHA checkout but may be named anything (e.g. "couchbaselabs")
  // in a developer's clone. fit-cli is public, so this needs no auth.
  // Fully qualified: the channel's own release tag usually has the same name as the
  // branch, and a bare name would fetch that tag, i.e. the previously built commit.
  await run("git", ["fetch", REPO_URL, qualifiedBranchRef(branch)]);
  const sha = (await capture("git", ["rev-parse", "FETCH_HEAD"])).trim();

  if (dryRun) {
    console.log(`  [dry-run] would build ${branch} @ ${sha} and publish channel "${channel}"`);
    return;
  }

  const worktreeDir = mkdtempSync(join(tmpdir(), "fit-cli-channel-"));
  const distDir = join(worktreeDir, "dist");
  try {
    await run("git", ["worktree", "add", "--detach", worktreeDir, sha]);
    await run("bun", ["install", "--frozen-lockfile"], worktreeDir);

    const buildTime = new Date().toISOString();
    for (const { target, asset } of BUILD_TARGETS) {
      await run(
        "bun",
        [
          "build",
          "--compile",
          `--target=${target}`,
          "--define",
          `__FIT_GIT_SHA="${sha}"`,
          "--define",
          `__FIT_BUILD_TIME="${buildTime}"`,
          "src/fit/main/main.ts",
          "--outfile",
          join(distDir, asset),
        ],
        worktreeDir,
      );
    }

    // Replace any existing release so re-publishing is idempotent. Tolerate a
    // missing release on the first publish (mirrors the release workflows' `|| true`).
    try {
      await run("gh", ["release", "delete", channel, "--yes", "--cleanup-tag"]);
    } catch {
      // no existing release for this channel — fine.
    }
    await run("gh", [
      "release",
      "create",
      channel,
      "--target",
      sha,
      "--prerelease",
      "--title",
      `Branch: ${branch}`,
      "--notes",
      releaseNotes(channel, branch, sha),
      ...BUILD_TARGETS.map(({ asset }) => join(distDir, asset)),
    ]);
    console.log(`✓ Published channel "${channel}" (branch ${branch} @ ${sha})`);
  } finally {
    try {
      await run("git", ["worktree", "remove", "--force", worktreeDir], undefined, { quiet: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/** Guard the build subcommands: they need bun + a source checkout. */
function ensureCanBuild(): void {
  if (isFitBinary()) {
    throw new Error(
      "publish/sync build binaries from source, so they can't run from the installed `fit` binary.\n" +
        "Run them from a fit-cli checkout instead:\n" +
        "  git clone https://github.com/couchbaselabs/fit-cli && cd fit-cli && bun install\n" +
        "  bun run maintenance channels sync",
    );
  }
}

async function cmdList(): Promise<void> {
  const [releases, branches] = await Promise.all([listBranchChannelReleases(), listRemoteBranches()]);
  if (releases.length === 0) {
    console.log("No branch channels published yet.");
    return;
  }
  const branchSha = new Map(branches.map((b) => [b.name, b.sha]));
  console.log(`Branch channels (${releases.length}):\n`);
  for (const { tag, marker } of releases.sort((a, b) => a.tag.localeCompare(b.tag))) {
    const live = branchSha.get(marker.branch);
    const status = !live
      ? "branch deleted — prunable"
      : shasMatch(live, marker.sha)
        ? "up to date"
        : "behind (branch moved) — sync to update";
    console.log(`  ${tag.padEnd(28)} ${marker.branch.padEnd(28)} built ${marker.sha.slice(0, 10)}  ${status}`);
  }
}

async function cmdPublish(branchArg: string | undefined, dryRun: boolean): Promise<void> {
  ensureCanBuild();
  const branch = branchArg ?? (await capture("git", ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (!branch || branch === "HEAD") {
    throw new Error("Could not determine the current branch — pass one explicitly: publish <branch>.");
  }
  if (isReservedChannel(channelNameForBranch(branch))) {
    throw new Error(`"${branch}" maps to reserved channel "${channelNameForBranch(branch)}"; reserved channels are managed separately.`);
  }
  console.log(`Publishing branch "${branch}" as a channel...`);
  await buildAndPublish(branch, dryRun);
}

async function cmdSync(force: boolean, prune: boolean, dryRun: boolean): Promise<void> {
  ensureCanBuild();
  const [releases, branches] = await Promise.all([listBranchChannelReleases(), listRemoteBranches()]);

  for (const [channel, names] of channelCollisions(branches)) {
    console.warn(`⚠ Branches ${names.map((n) => `"${n}"`).join(", ")} all map to channel "${channel}"; whichever publishes last wins.`);
  }

  const plan = planSync(branches, releases, force);
  const toPublish = plan.filter((p) => p.reason !== "up-to-date");
  const skipped = plan.filter((p) => p.reason === "up-to-date");

  for (const p of skipped) {
    console.log(`• ${p.channel}: up to date (${p.sha.slice(0, 10)}) — skipping`);
  }
  if (toPublish.length === 0) {
    console.log("No branches need (re)publishing.");
  }

  // Resilient: this runs unattended nightly, so one branch that fails to build
  // must not block the rest (or the prune). Collect failures and surface them at
  // the end with a non-zero exit.
  const failures: string[] = [];
  for (const p of toPublish) {
    console.log(`\n→ ${p.channel}: ${p.reason} (branch ${p.branch})`);
    try {
      await buildAndPublish(p.branch, dryRun);
    } catch (err) {
      console.error(`✗ Failed to publish channel "${p.channel}": ${err instanceof Error ? err.message : String(err)}`);
      failures.push(p.channel);
    }
  }

  if (prune) {
    console.log("");
    try {
      await runPrune(branches, releases, dryRun);
    } catch (err) {
      console.error(`✗ Prune step failed: ${err instanceof Error ? err.message : String(err)}`);
      failures.push("prune");
    }
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} channel operation(s) failed: ${failures.join(", ")}`);
  }
}

async function cmdPrune(dryRun: boolean): Promise<void> {
  const [releases, branches] = await Promise.all([listBranchChannelReleases(), listRemoteBranches()]);
  await runPrune(branches, releases, dryRun);
}

/** Shared prune step: delete branch channels whose source branch is gone. */
async function runPrune(
  branches: readonly RemoteBranch[],
  releases: readonly BranchChannelRelease[],
  dryRun: boolean,
): Promise<void> {
  // Floor-guard: a successful-but-empty branch list (e.g. a partial/transient API
  // response) would otherwise make planPrune consider every channel orphaned and
  // delete them all. A real repo always has at least its default branch, so an
  // empty list means something went wrong — refuse rather than mass-delete.
  if (branches.length === 0) {
    throw new Error(
      "Refusing to prune: the remote branch list came back empty. A real repo always has " +
        "at least its default branch, so this is almost certainly a failed or partial API response, " +
        "not that every branch was deleted.",
    );
  }
  const plan = planPrune(branches, releases);
  if (plan.length === 0) {
    console.log("Nothing to prune — every branch channel still has a live branch.");
    return;
  }
  let failed = 0;
  for (const { channel, branch } of plan) {
    if (dryRun) {
      console.log(`  [dry-run] would delete channel "${channel}" (branch "${branch}" no longer exists)`);
      continue;
    }
    try {
      await run("gh", ["release", "delete", channel, "--yes", "--cleanup-tag"]);
      console.log(`✓ Pruned channel "${channel}" (branch "${branch}" deleted)`);
    } catch (err) {
      console.error(`✗ Failed to prune channel "${channel}": ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
  if (failed > 0) {
    throw new Error(`Failed to prune ${failed} channel(s).`);
  }
}

export async function runChannelsDispatch(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  const HELP = new Set(["-h", "--help", "help"]);
  if (!subcommand || HELP.has(subcommand)) {
    console.log(helpText());
    if (!subcommand) process.exit(2);
    return;
  }
  const args = parseChannelsArgs(rest);
  if (args.help) {
    console.log(helpText());
    return;
  }

  switch (subcommand) {
    case "list":
      await cmdList();
      return;
    case "publish":
      await cmdPublish(args.positionals[0], args.dryRun);
      return;
    case "sync":
      await cmdSync(args.force, args.prune, args.dryRun);
      return;
    case "prune":
      await cmdPrune(args.dryRun);
      return;
    default:
      console.error(`Unknown subcommand: ${subcommand}\n`);
      console.error(helpText());
      process.exit(2);
  }
}

export function runChannelsMain(): void {
  runChannelsDispatch(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

if (isMain(import.meta.url)) {
  runChannelsMain();
}
