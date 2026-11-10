#!/usr/bin/env node
/**
 * fit upgrade — compare the installed fit-cli binary against the latest released
 * build for a channel, and upgrade in place if it's out of date.
 *
 *   fit upgrade                 # check the `latest` channel, upgrade if outdated (asks first)
 *   fit upgrade --channel ci    # use the more stable `ci` channel instead
 *   fit upgrade --check         # only report whether an upgrade is available; never upgrade
 *   fit upgrade --yes           # don't ask before upgrading
 *
 * The upgrade itself just re-runs the canonical install.sh (the same script the
 * README points users at) with CHANNEL/INSTALL_DIR set, so there's a single
 * source of truth for how the binary is downloaded and placed.
 *
 * Debug a single piece directly (these aren't stable CLI commands):
 *   bun src/fit/upgrade/upgrade.ts --check
 *   bun src/fit/upgrade/upgrade.ts --channel ci --check
 */
import { dirname } from "node:path";
import { confirm } from "../../util/non-fit/prompts.js";
import { isMain } from "../../util/non-fit/cli.js";
import { run } from "../../util/non-fit/proc.js";
import { isFitBinary, runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import { resolvedGitSha } from "../version/version.js";

const REPO = "couchbaselabs/fit-cli";
const INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${REPO}/main/install.sh`;

export const CHANNELS = ["latest", "ci"] as const;
export type Channel = (typeof CHANNELS)[number];
const DEFAULT_CHANNEL: Channel = "latest";

/**
 * URL of one released binary, e.g. `releaseAssetUrl("ci", "fit-linux-x64")`.
 *
 * A channel tag and its assets are recreated on every publish, so this always names that
 * channel's current build. Same scheme install.sh downloads from — the two have to agree,
 * and the asset names come from build-binaries.yaml.
 */
export function releaseAssetUrl(channel: Channel, asset: string): string {
  return `https://github.com/${REPO}/releases/download/${channel}/${asset}`;
}

export interface UpgradeArgs {
  channel: Channel;
  check: boolean;
  yes: boolean;
  help: boolean;
}

function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value);
}

/**
 * Parse the upgrade flags. Pure so it can be unit-tested. Throws on an unknown
 * flag or an invalid channel value.
 */
export function parseUpgradeArgs(argv: readonly string[]): UpgradeArgs {
  let channel: Channel = DEFAULT_CHANNEL;
  let check = false;
  let yes = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg === "--channel") {
      const value = argv[++i];
      if (!value || !isChannel(value)) {
        throw new Error(`--channel must be one of: ${CHANNELS.join(", ")}; got "${value ?? ""}"`);
      }
      channel = value;
    } else if (arg.startsWith("--channel=")) {
      const value = arg.slice("--channel=".length);
      if (!isChannel(value)) {
        throw new Error(`--channel must be one of: ${CHANNELS.join(", ")}; got "${value}"`);
      }
      channel = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { channel, check, yes, help };
}

export function helpText(): string {
  const p = runScriptPrefix("upgrade");
  return `Check the installed fit-cli against the latest released build and upgrade in place.

Usage:
  ${p} [--channel latest|ci] [--check] [--yes]
  ${p} --help

Flags:
  --channel <latest|ci>  Release channel to check against (default: ${DEFAULT_CHANNEL}).
                         latest = tip of main (every push); ci = stable, manually promoted.
  --check                Only report whether an upgrade is available; don't upgrade.
  --yes, -y              Upgrade without asking for confirmation.`;
}

/** True when two git SHAs refer to the same commit, tolerating short vs full forms. */
export function shasMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter);
}

/**
 * Resolve the commit SHA that a release-channel tag (`latest` / `ci`) currently
 * points at. The release workflows recreate the tag at the built commit, so the
 * tag's commit is exactly the SHA baked into that channel's binary. Dereferences
 * annotated tags to the underlying commit. The repo is public so no auth is needed.
 */
export async function resolveRemoteSha(channel: Channel): Promise<string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const fetchJson = async (url: string): Promise<{ object: { sha: string; type: string; url: string } }> => {
    // github.com/api serves the occasional 504 ("Unicorn"). Retry those: callers treat a
    // failure here as "this channel isn't it", so a blip would otherwise read as an answer.
    // 404 is an answer — the tag genuinely doesn't exist — so it is never retried.
    let lastError = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      // Bounded: a hung connection here must not outlast whatever it's being asked about.
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (res.status === 404) {
        throw new Error(`No release found for channel "${channel}" — the "${channel}" tag does not exist.`);
      }
      if (res.ok) {
        return (await res.json()) as { object: { sha: string; type: string; url: string } };
      }
      const text = await res.text().catch(() => "");
      // Truncated: GitHub's 5xx body is a full HTML error page.
      lastError = `GitHub API returned ${res.status} for ${url}${text ? `: ${text.slice(0, 200)}` : ""}`;
      if (res.status < 500 || attempt === 3) break;
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
    throw new Error(lastError);
  };

  const ref = await fetchJson(`https://api.github.com/repos/${REPO}/git/refs/tags/${channel}`);
  // Annotated tag → the ref points at a tag object; follow it to the commit.
  if (ref.object.type === "tag") {
    const tag = await fetchJson(ref.object.url);
    return tag.object.sha;
  }
  return ref.object.sha;
}

/** Re-run install.sh for the channel, installing over the current binary's directory. */
async function performUpgrade(channel: Channel): Promise<void> {
  const installDir = dirname(process.execPath);
  // channel is validated to latest|ci; installDir is shell-quoted in case of spaces.
  const quotedDir = `'${installDir.replace(/'/g, `'\\''`)}'`;
  const pipeline = `curl -fsSL ${INSTALL_SCRIPT_URL} | CHANNEL=${channel} INSTALL_DIR=${quotedDir} bash`;
  console.log(`\nUpgrading via the install script (channel "${channel}", into ${installDir})...`);
  await run("bash", ["-c", pipeline]);
}

export async function runUpgrade(args: UpgradeArgs): Promise<void> {
  if (!isFitBinary()) {
    console.log(
      "You're running fit-cli from source (via `bun run`), not the installed binary, so there's\n" +
        "nothing to upgrade. To update the source, pull the latest changes:\n" +
        "  git -C <fit-cli checkout> pull",
    );
    return;
  }

  const localSha = resolvedGitSha();
  console.log(`Checking the "${args.channel}" channel for updates...`);
  const remoteSha = await resolveRemoteSha(args.channel);

  console.log(`  installed: ${localSha}`);
  console.log(`  ${args.channel}:   ${remoteSha}`);

  if (shasMatch(localSha, remoteSha)) {
    console.log(`\n✓ Already up to date with the "${args.channel}" channel.`);
    return;
  }

  console.log(`\nAn upgrade is available on the "${args.channel}" channel.`);
  if (args.check) {
    console.log(`Run '${runScriptPrefix("upgrade")}${args.channel === DEFAULT_CHANNEL ? "" : ` --channel ${args.channel}`}' to install it.`);
    return;
  }

  if (!args.yes) {
    const ok = await confirm({
      promptId: "upgrade.confirm",
      message: `Upgrade now from the "${args.channel}" channel?`,
      default: true,
    });
    if (!ok) {
      console.log("Upgrade cancelled.");
      return;
    }
  }

  await performUpgrade(args.channel);
}

export function runUpgradeMain(): void {
  const args = parseUpgradeArgs(process.argv.slice(2));
  if (args.help) {
    console.log(helpText());
    return;
  }
  runUpgrade(args).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

if (isMain(import.meta.url)) {
  runUpgradeMain();
}
