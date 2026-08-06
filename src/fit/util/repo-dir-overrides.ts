/**
 * Tracks which repos had a `--repo-dir <repo>=<path>` override applied for
 * this process. Only local execution honours the override (it's read via
 * `resolveFitPerformerDir`) — a remote/AWS instance always clones fresh from
 * GitHub (see `ensureRemoteRepos`) and silently ignores it. run-from-definition
 * uses this to fast-fail rather than let the override look like it worked.
 */
const activeOverrides = new Set<string>();

/** Record that `--repo-dir <repoName>=<path>` was passed for this run. */
export function recordRepoDirOverride(repoName: string): void {
  activeOverrides.add(repoName);
}

/** Names of repos with an active `--repo-dir` override, if any. */
export function activeRepoDirOverrideNames(): string[] {
  return [...activeOverrides];
}
