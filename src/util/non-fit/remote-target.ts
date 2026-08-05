/**
 * remote-target — command-string building helpers shared by every "run this on
 * a remote box" transport (SsmTarget today; formerly also an SSH-backed
 * RemoteTarget, removed once nothing used it). To honour `cwd` the command and
 * its arguments are POSIX-quoted into a single remote command string, since a
 * remote transport has no native cwd of its own.
 */

/**
 * Quote a single token for a POSIX shell. Bare tokens made of safe characters
 * are left alone; anything else is wrapped in single quotes (with embedded
 * single quotes escaped). Exported for unit testing (see tests/remote-target.test.ts).
 */
export function posixQuote(token: string): string {
  if (token.length > 0 && /^[A-Za-z0-9_./:=@%+-]+$/.test(token)) {
    return token;
  }
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/** Build the remote command string for `command args...`, optionally inside `cwd`. */
export function buildRemoteCommand(command: string, args: readonly string[], cwd?: string): string {
  const cmdline = [command, ...args].map(posixQuote).join(" ");
  return cwd ? `cd ${posixQuote(cwd)} && ${cmdline}` : cmdline;
}

/**
 * Wrap a command so its output streams live (to the terminal, via the caller's
 * `run`) *and* is saved to `path` — the L1 + saved-to-file model used for
 * `cbdinocluster allocate`. `pipefail` makes the pipeline exit non-zero when the
 * command (not `tee`) fails, preserving the non-zero-means-failure contract.
 * `command` is the already-assembled inner command string (from
 * {@link buildRemoteCommand} / pathPrefixedCommand remotely, or the quoted
 * command+args locally).
 */
export function teeToFileCommand(command: string, path: string): string {
  return `set -o pipefail; ${command} 2>&1 | tee ${posixQuote(path)}`;
}
