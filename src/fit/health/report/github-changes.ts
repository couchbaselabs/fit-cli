/**
 * `ChangeSource` over the GitHub API, through `gh` (which brings the token: the org token in
 * CI, the user's own login on a laptop). Every call is quiet and bounded.
 */
import { capture } from "../../../util/non-fit/proc.js";
import type { ChangeSource, Commit } from "./changes.js";

const TIMEOUT_MS = 60_000;

async function lines(args: string[]): Promise<string[]> {
  const out = await capture("gh", ["api", ...args], process.cwd(), { quiet: true, timeoutMs: TIMEOUT_MS });
  return out.split("\n").filter((l) => l.trim());
}

export const githubChanges: ChangeSource = {
  async compare(repo, base, head) {
    const out = await lines([`repos/${repo}/compare/${base}...${head}`, "--jq", '.commits[] | {sha, title: (.commit.message | split("\\n")[0])} | tojson']);
    return out.map((l) => JSON.parse(l) as Commit);
  },
  async files(repo, sha) {
    return lines(["--paginate", `repos/${repo}/commits/${sha}`, "--jq", ".files[].filename"]);
  },
  async history(repo, branch, since, until) {
    const q = `sha=${encodeURIComponent(branch)}&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&per_page=100`;
    const out = await lines(["--paginate", `repos/${repo}/commits?${q}`, "--jq", ".[] | {sha, landedAt: .commit.committer.date} | tojson"]);
    return out
      .map((l) => JSON.parse(l) as { sha: string; landedAt: string })
      .map((c) => ({ sha: c.sha, landedAt: new Date(c.landedAt).toISOString() }))
      .sort((a, b) => b.landedAt.localeCompare(a.landedAt));
  },
  async tree(repo, branch) {
    const [truncated, ...paths] = await lines([`repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, "--jq", '(.truncated | tostring), (.tree[] | select(.type == "blob") | .path)']);
    if (truncated === "true") throw new Error(`the ${repo} tree listing was truncated`);
    return paths;
  },
};
