import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type Artifact, type Detail } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { LocalTarget } from "../../../util/non-fit/local-target.js";
import { HEARTBEAT_INTERVAL_SECS, run, streamToFile, streamToFileInBackground, type BackgroundStream, type RunOptions } from "../../../util/non-fit/proc.js";
import { formatCommandLine } from "../../../util/non-fit/fit-cli-log.js";
import { createRunFilePath, runRunDir, type DefinitionRunPath } from "../../../util/non-fit/replay.js";
import { posixQuote, teeToFileCommand } from "../../../util/non-fit/remote-target.js";
import type { ExecutionTarget } from "../../../util/non-fit/target.js";
import { fitCliError, runScriptPrefix } from "../../../util/non-fit/fit-cli-log.js";
import { FIT_INSTANCE_USER } from "../../util/aws/fit-instance.js";
import { FIT_PERFORMER, repoPath, type Repo } from "../../util/repos.js";
import { ensureRepo } from "../../util/ensure-repo.js";
import { collectJunitArtifacts } from "../run-test-driver/collect-junit.js";
import type { Sdk } from "../../../util/sdk/sdks.js";
import { DEFAULT_PERFORMER_PORT } from "../../performers/util/performer-port.js";
import { createRemoteFitExecutionContext } from "./remote-fit-execution-context.js";
import { resolveFitPerformerDir, resolveGerritSshKey, type ResolvedCapellaConfig } from "../../util/config.js";

const REMOTE_FIT_WORKSPACE_DIR = "fit-workspace";
const REMOTE_DOCKER_WRAPPER_FILE = "docker";
export const REMOTE_DOCKER_HOST_ALIAS = "host.docker.internal:host-gateway";

export interface FitExecutionContext {
  readonly kind: "local" | "remote";
  readonly description: string;
  readonly target: ExecutionTarget;
  /**
   * Workspace root. On remote contexts this is the remote FIT workspace dir that
   * everything (repos, credentials, artifacts) hangs off. On local contexts it's
   * unused beyond bookkeeping — local paths come from {@link fitPerformerDir}.
   */
  readonly rootDir: string;
  /**
   * The transactions-fit-performer checkout the Maven test-driver runs from.
   * Empty on a local context when localhost testing isn't configured; callers
   * that need it (the test-driver, Gerrit checkout) go through {@link ensureWorkspace}.
   */
  readonly fitPerformerDir: string;
  readonly dockerCommand: string;
  readonly artifacts: Artifact[];
  details: Detail[];
  /**
   * Path (on the execution target) to the SSH private key for Gerrit, or undefined
   * if none was configured. Set on local contexts from resolveFitGerritKey(); set on
   * remote contexts after the key has been staged to the remote machine.
   */
  gerritSshKeyPath?: string;

  /** Ensure the FIT performer checkout is present (cloning it if missing). */
  ensureWorkspace(): Promise<boolean>;
  /** StreamToTerminal process model (LogType1): stdout/stderr stream into this process's own stdout/stderr. */
  run(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<void>;
  /** CaptureValue process model (no LogType): run a process to parse a value (SHA, username, file list), not to produce log noise. */
  capture(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<string>;
  /** HiddenUntilFailure process model (LogType2): output hidden as noise and only shown on failure (also kept in the session.debug.log artifact). */
  runHiddenUntilFailure(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<void>;
  /**
   * StreamToTerminal + saved-to-file (LogType1 + artifact): stream output live to
   * the terminal (and the session log) AND tee a copy to `targetPath`. For steps
   * we want to watch live but whose output we also need on disk to parse/collect
   * (cbdinocluster allocate).
   */
  streamToTerminalAndFile(command: string, args: string[], targetPath: string, cwd?: string): Promise<void>;
  /**
   * StreamToArtifact process model (LogType3): full output sent to `targetPath`
   * only, with the last line surfaced every N seconds for proof-of-life. For
   * genuinely huge logs (the FIT test-driver, performer docker logs).
   */
  streamToArtifactFile(command: string, args: string[], targetPath: string, cwd?: string, env?: Record<string, string>): Promise<void>;
  /**
   * BackgroundStreamToArtifact process model (LogType4): start a background
   * process that streams to `targetPath` without blocking. Call
   * {@link BackgroundStream.drain} after stopping the subject process (e.g. the
   * performer container) to wait for the final bytes to flush before collecting
   * the file.
   */
  streamToArtifactFileInBackground(command: string, args: string[], targetPath: string, cwd?: string): Promise<BackgroundStream>;
  targetFilePath(localPath: string): string;
  stageFile(localPath: string, targetPath?: string): Promise<string>;
  /**
   * Collect `targetPath` (on the execution target) to `localPath`. Returns the
   * actual local path written — normally `localPath`, but remote contexts may
   * return `${localPath}.gz` instead when the collected file was too large to
   * safely decompress locally (see {@link createRemoteFitExecutionContext}).
   */
  collectFile(targetPath: string, localPath: string): Promise<string>;
  removeTree(path: string): Promise<void>;
  /**
   * Directory (on the execution target) that holds this run's per-run I/O —
   * FITConfiguration.json, driver.log and surefire-reports. Local contexts use
   * the same per-run tree the artifacts are collected into; remote contexts use
   * a mirror of it under the box's `artifacts/` dir, so per-run files never
   * collide in the flat workspace root. See {@link remoteRunArtifactsDir}.
   */
  runArtifactsDir(path: DefinitionRunPath): string;
  collectJunitArtifacts(sourceDir: string, path: DefinitionRunPath): Promise<Artifact[]>;
  pathExists(path: string): Promise<boolean>;
  commandAvailable(command: string): Promise<boolean>;
  performerRunArgs(imageName: string, hostPort?: number): string[];
}

export function remoteFitRootDir(user: string = FIT_INSTANCE_USER): string {
  return `/home/${user}/${REMOTE_FIT_WORKSPACE_DIR}`;
}

export function remoteFitBinDir(rootDir: string): string {
  return join(rootDir, "bin");
}

/**
 * Root of the per-run artifact mirror on a remote box. The shared checkout and
 * build stay flat under the workspace root; only per-run I/O lives here, mirroring
 * the local artifact tree so collection is a pure path rebase.
 */
export function remoteArtifactsDir(rootDir: string): string {
  return join(rootDir, "artifacts");
}

/**
 * Directory on a remote box for one run's per-run I/O, mirroring the local
 * `runRunDir` layout (`instances/N/clusters/C/sessions/S/runs/R`, or the
 * clusterless variant) rooted at {@link remoteArtifactsDir}.
 */
export function remoteRunArtifactsDir(rootDir: string, path: DefinitionRunPath): string {
  return runRunDir(path, remoteArtifactsDir(rootDir));
}

export function remoteDockerWrapperPath(rootDir: string): string {
  return join(remoteFitBinDir(rootDir), REMOTE_DOCKER_WRAPPER_FILE);
}

/**
 * Repos cloned onto a remote box: just transactions-fit-performer, which holds
 * the FIT test driver. Performers themselves are always pulled as prebuilt
 * images, never built from source.
 */
export function remoteFitRepos(): Repo[] {
  return [FIT_PERFORMER];
}

export function remoteDockerWrapperScript(): string {
  return "#!/bin/sh\nexec sudo -n /usr/bin/docker \"$@\"\n";
}

/** Where the remote git credentials file lives, under the FIT workspace root. */
export function remoteGitCredentialsPath(rootDir: string): string {
  return join(rootDir, ".git-credentials");
}

async function remoteRepoExists(target: ExecutionTarget, rootDir: string, repo: Repo): Promise<boolean> {
  return target.run("test", ["-d", repoPath(repo, rootDir)], undefined, { quiet: true }).then(() => true).catch(() => false);
}

export async function ensureRemoteRepos(target: ExecutionTarget, rootDir: string, repos: readonly Repo[]): Promise<void> {
  await target.run("mkdir", ["-p", rootDir]);
  for (const repo of repos) {
    if (await remoteRepoExists(target, rootDir, repo)) {
      console.log(`✓ Found ${repo.name} on ${target.description} at ${repoPath(repo, rootDir)}`);
      continue;
    }
    const branchArgs = repo.branch ? ["--branch", repo.branch] : [];
    console.log(`\nCloning ${repo.name}${repo.branch ? ` (branch ${repo.branch})` : ""} onto ${target.description}...\n`);
    await target.run("git", ["clone", ...branchArgs, repo.httpsUrl, repo.dir], rootDir);
  }
}

/**
 * A line for git's `store` credential helper, granting HTTPS access to all of
 * github.com with the given token. `x-access-token` is GitHub's conventional
 * username for token auth (works for both classic and fine-grained PATs).
 */
export function gitCredentialsLine(token: string): string {
  return `https://x-access-token:${token}@github.com\n`;
}

/**
 * Put a git credentials file on the remote and point git's `store` helper at it,
 * so the private FIT repos clone over HTTPS without prompting. The token is
 * written via scp (not passed on a command line or baked into a clone URL), so
 * it never lands in process listings or the local session log; it does sit in
 * the credentials file on the box, which is fine — the instance is throwaway and
 * only reachable with the per-run SSH key.
 */
export async function configureRemoteGitCredentials(
  target: ExecutionTarget,
  rootDir: string,
  token: string,
): Promise<void> {
  const credentialsPath = remoteGitCredentialsPath(rootDir);
  const localCredentials = createRunFilePath("git-credentials");
  writeFileSync(localCredentials, gitCredentialsLine(token), { mode: 0o600 });
  await target.putFile(localCredentials, credentialsPath);
  await target.run("chmod", ["600", credentialsPath]);
  await target.run("git", ["config", "--global", "credential.helper", `store --file=${credentialsPath}`]);
  rmSync(localCredentials, { force: true });
}

const REMOTE_GERRIT_SSH_KEY_FILENAME = "gerrit-ssh-key";

export function remoteGerritSshKeyPath(rootDir: string): string {
  return join(rootDir, REMOTE_GERRIT_SSH_KEY_FILENAME);
}

/**
 * Copy the local Gerrit SSH private key to the remote instance with chmod 600.
 * Returns the path on the remote machine where the key was written.
 */
export async function stageGerritSshKey(
  target: ExecutionTarget,
  rootDir: string,
  localKeyPath: string,
): Promise<string> {
  const remotePath = remoteGerritSshKeyPath(rootDir);
  await target.putFile(localKeyPath, remotePath);
  await target.run("chmod", ["600", remotePath]);
  return remotePath;
}

// AWS credentials for the box live in remote-aws-creds.ts: they need a refreshing
// source rather than a one-off env file, so they get their own module.

const REMOTE_CAPELLA_CONFIG_FILENAME = "fit-capella-config.sh";

function remoteCapellaConfigPath(rootDir: string): string {
  return join(rootDir, REMOTE_CAPELLA_CONFIG_FILENAME);
}

function capellaConfigScript(capella: ResolvedCapellaConfig): string {
  // The env var names cbdinocluster's `init` reads (see its cmd/init.go). With
  // CAPELLA_USER present, `init --auto` enables Capella and fills the block from
  // these; the situational init args leave Capella enabled for exactly this.
  const lines = [
    `export CAPELLA_USER=${posixQuote(capella.username ?? "")}`,
    `export CAPELLA_ENDPOINT=${posixQuote(capella.endpoint)}`,
    `export CAPELLA_OID=${posixQuote(capella.organizationId)}`,
    `export CAPELLA_PASS=${posixQuote(capella.password)}`,
  ];
  // Optional: only present for environments the Capella team has issued them for
  // (currently just "dev"). Both have env-var fallbacks in cbdinocluster's `init`,
  // unlike --upload-server-logs-host-name (which has none, so it's passed as an
  // explicit init flag instead — see default-cbdinocluster-init-config.ts).
  if (capella.internalSupportToken) {
    lines.push(`export CAPELLA_INTERNAL_SUPPORT_TOKEN=${posixQuote(capella.internalSupportToken)}`);
  }
  if (capella.overrideToken) {
    lines.push(`export CAPELLA_OVERRIDE_TOKEN=${posixQuote(capella.overrideToken)}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Write the Capella control-plane settings to the remote instance as a sourced
 * env file, so `cbdinocluster init --auto` (run later via a login shell) inherits
 * the `CAPELLA_*` vars and bakes the `capella` block into `~/.cbdinocluster`.
 * Must run before the init step. Like `uploadRemoteAwsCredentials` (remote-aws-creds.ts)
 * the file is uploaded via SCP, never on a command line. Unlike it, these credentials are
 * still sourced from `~/.profile`: Capella creds come from AWS Secrets Manager and don't
 * expire mid-run, so they don't need a refreshing source on the box.
 */
export async function uploadRemoteCapellaConfig(
  target: ExecutionTarget,
  rootDir: string,
  capella: ResolvedCapellaConfig,
): Promise<void> {
  const remotePath = remoteCapellaConfigPath(rootDir);
  const localFile = createRunFilePath(REMOTE_CAPELLA_CONFIG_FILENAME);
  writeFileSync(localFile, capellaConfigScript(capella), { mode: 0o600 });
  console.log(
    `→ setup-capella: uploading Capella settings to ${remotePath} on ${(target as { description?: string }).description ?? "remote"}`,
  );
  await target.putFile(localFile, remotePath);
  rmSync(localFile, { force: true });
  await target.run("chmod", ["600", remotePath]);
  // Source from ~/.profile idempotently so every login shell inherits the vars.
  await target.run(
    "sh",
    ["-lc",
      `grep -qF ${posixQuote(basename(remotePath))} ~/.profile 2>/dev/null` +
      ` || printf '\\n. ${posixQuote(remotePath)}\\n' >> ~/.profile`],
    undefined,
    { display: `add Capella settings to ~/.profile (idempotent)` },
  );
}

function shellCommand(command: string, args: readonly string[] = []): string {
  return [command, ...args].map(posixQuote).join(" ");
}

export function pathPrefixedCommand(binDir: string, command: string, args: readonly string[] = []): string {
  return `export PATH=${posixQuote(binDir)}:$PATH; ${shellCommand(command, args)}`;
}

export function redirectToFileCommand(command: string, args: readonly string[], path: string): string {
  return `${shellCommand(command, args)} > ${posixQuote(path)} 2>&1`;
}

/**
 * Remote equivalent of {@link streamToFile}'s proof-of-life heartbeat. The full
 * output of a long-running remote command (e.g. the FIT test-driver) goes only
 * to `path`; over the SSH stdout we emit just the last log line every
 * `intervalSecs` so the terminal isn't silent for hours yet isn't flooded.
 *
 * The command runs backgrounded in a subshell (so a compound `a; b` redirects
 * as a whole) with stdout+stderr to the file; we poll for liveness and tail the
 * file. The final `wait` is the last statement, so the script's exit code is the
 * command's — preserving the non-zero-means-failure contract.
 */
export function heartbeatShellCommand(
  command: string,
  path: string,
  intervalSecs: number = HEARTBEAT_INTERVAL_SECS,
): string {
  const quotedPath = posixQuote(path);
  const pollSecs = Math.min(5, intervalSecs);
  return [
    `( ${command} ) > ${quotedPath} 2>&1 &`,
    `cmd_pid=$!`,
    `elapsed=0`,
    `while kill -0 "$cmd_pid" 2>/dev/null; do`,
    `  sleep ${pollSecs}`,
    `  elapsed=$((elapsed+${pollSecs}))`,
    `  if [ "$elapsed" -ge ${intervalSecs} ]; then`,
    `    elapsed=0`,
    `    line=$(tail -n 1 ${quotedPath} 2>/dev/null)`,
    `    [ -n "$line" ] && printf '[%s] %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$line"`,
    `  fi`,
    `done`,
    `wait "$cmd_pid"`,
  ].join("\n");
}

/**
 * Start a command in the background on the remote shell, redirect its
 * stdout+stderr to `path`, and print the background process PID on stdout so
 * the caller can wait for it later. `disown` removes the job from the shell's
 * job table so it survives when the SSH session that launched it ends.
 */
export function backgroundShellCommand(command: string, path: string): string {
  const quotedPath = posixQuote(path);
  return `( ${command} ) >> ${quotedPath} 2>&1 & bg_pid=$! && disown $bg_pid && printf '%s\\n' "$bg_pid"`;
}

export function remotePerformerArgs(
  imageName: string,
  hostPort: number = DEFAULT_PERFORMER_PORT,
): string[] {
  return [
    "run",
    "--detach",
    "--add-host",
    REMOTE_DOCKER_HOST_ALIAS,
    "--publish",
    `${hostPort}:${DEFAULT_PERFORMER_PORT}`,
    "--env",
    "LOG_LEVEL=debug",
    imageName,
  ];
}

export function createLocalFitExecutionContext(): FitExecutionContext {
  const target = new LocalTarget();
  // The performer checkout location comes from the localhost config. It can be
  // empty (localhost testing not configured) — that's fine for flows that only
  // pull/run a prebuilt performer image; flows that need the source go through
  // ensureWorkspace, which fails fast with guidance when it's unset.
  const fitPerformerDir = resolveFitPerformerDir() ?? "";
  return {
    kind: "local",
    description: target.description,
    target,
    rootDir: fitPerformerDir ? dirname(fitPerformerDir) : "",
    fitPerformerDir,
    dockerCommand: "docker",
    artifacts: [],
    details: [],
    gerritSshKeyPath: resolveGerritSshKey(),
    ensureWorkspace: async (): Promise<boolean> => {
      if (!fitPerformerDir) {
        fitCliError(
          "No local transactions-fit-performer checkout is configured.\n" +
            `  Run \`${runScriptPrefix("config")} edit\` and enable localhost testing ` +
            "(sets localhost.repos.\"transactions-fit-performer\".dir),\n" +
            `  or pass --repo-dir transactions-fit-performer=<path> to \`${runScriptPrefix("run")}\` for a one-off override.`,
        );
        return false;
      }
      if (!(await ensureRepo(FIT_PERFORMER, fitPerformerDir))) {
        console.log("\nOnce transactions-fit-performer is in place, run fit-cli again.");
        return false;
      }
      return true;
    },
    run: (command, args, cwd, opts) => target.run(command, args, cwd, opts),
    capture: (command, args, cwd, opts) => target.capture(command, args, cwd, opts),
    runHiddenUntilFailure: (command, args, cwd, opts) => target.runHiddenUntilFailure(command, args, cwd, opts),
    streamToTerminalAndFile: (command, args, targetPath, cwd) => {
      mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
      return run("bash", ["-lc", teeToFileCommand(shellCommand(command, args), targetPath)], cwd, {
        display: formatCommandLine(command, args),
      });
    },
    streamToArtifactFile: (command, args, targetPath, cwd, env) => streamToFile(command, args, targetPath, cwd, undefined, env),
    streamToArtifactFileInBackground: (command, args, targetPath, cwd) =>
      Promise.resolve(streamToFileInBackground(command, args, targetPath, cwd)),
    targetFilePath: (localPath) => localPath,
    stageFile: (localPath) => Promise.resolve(localPath),
    collectFile: (targetPath, localPath) => {
      mkdirSync(dirname(localPath), { recursive: true, mode: 0o700 });
      if (targetPath !== localPath) {
        copyFileSync(targetPath, localPath);
      }
      return Promise.resolve(localPath);
    },
    removeTree: (path) => {
      rmSync(path, { recursive: true, force: true });
      return Promise.resolve();
    },
    runArtifactsDir: (path) => runRunDir(path),
    collectJunitArtifacts: async (sourceDir, path) => await collectJunitArtifacts(sourceDir, path),
    pathExists: async (path) => target.capture("test", ["-e", path], undefined, { quiet: true }).then(() => true).catch(() => false),
    commandAvailable: async (command) =>
      target
        .capture("sh", ["-lc", `command -v ${posixQuote(command)} >/dev/null && printf yes || printf no`], undefined, { quiet: true })
        .then((output) => output.trim() === "yes")
        .catch(() => false),
    // Performer images are only published for linux/amd64; pin the platform explicitly
    // so Docker pulls/runs it under emulation on an Arm host instead of erroring with
    // "no matching manifest" (a no-op on a native amd64 host).
    performerRunArgs: (imageName, hostPort = DEFAULT_PERFORMER_PORT) => [
      "run",
      "--platform",
      "linux/amd64",
      "--detach",
      "--add-host",
      REMOTE_DOCKER_HOST_ALIAS,
      "--publish",
      `${hostPort}:${DEFAULT_PERFORMER_PORT}`,
      "--env",
      "LOG_LEVEL=debug",
      imageName,
    ],
  };
}

export async function createFitExecutionContext(
  target: ExecutionTarget,
  sdk: Sdk,
  options: { skipRemotePreparation?: boolean; instancePath?: DefinitionRunPath } = {},
): Promise<FitExecutionContext> {
  return target.kind === "local"
    ? createLocalFitExecutionContext()
    : await createRemoteFitExecutionContext(target, sdk, options.skipRemotePreparation, options.instancePath);
}

/**
 * Mini CLI: run a local FIT execution context on its own, to poke at its
 * operations during development. Run with --help for the subcommands, or:
 *
 *   bun src/fit/shared/util/remote-fit-run.ts --help
 *   bun src/fit/shared/util/remote-fit-run.ts run -- ls -la
 *   bun src/fit/shared/util/remote-fit-run.ts capture -- git status
 *   bun src/fit/shared/util/remote-fit-run.ts path-exists /tmp
 *   bun src/fit/shared/util/remote-fit-run.ts command-available docker
 *
 * The `--` separates the action from the command/args it should forward, so flags
 * meant for the inner command aren't eaten by fit-cli's own argv parsing.
 */
const LOCAL_CLI_ACTIONS = ["run", "capture", "path-exists", "command-available", "remove-tree"] as const;
type LocalCliAction = (typeof LOCAL_CLI_ACTIONS)[number];

function isLocalCliAction(value: string | undefined): value is LocalCliAction {
  return LOCAL_CLI_ACTIONS.includes(value as LocalCliAction);
}

const LOCAL_CLI_HELP = `Drive a local FIT execution context (createLocalFitExecutionContext) directly.

Usage:
  tsx src/fit/shared/util/remote-fit-run.ts <subcommand> [args]

Subcommands:
  run <command> [args...]          Run a command locally, streaming its output.
  capture <command> [args...]      Run a command locally and print its captured stdout.
  path-exists <path>               Print true/false for whether <path> exists.
  command-available <command>      Print true/false for whether <command> is on PATH.
  remove-tree <path>               Recursively remove <path> (rm -rf).

Put a \`--\` before the forwarded command so its own flags aren't parsed by fit-cli, e.g.
  ... run -- ls -la

Options:
  --help, -h                       Show this help.`;

if (isMain(import.meta.url)) {
  runCli(async () => {
    const rawArgs = process.argv.slice(2);
    if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
      console.log(LOCAL_CLI_HELP);
      return;
    }

    const [action, ...rest] = rawArgs;
    if (!isLocalCliAction(action)) {
      console.error(`Unknown or missing subcommand.\n\n${LOCAL_CLI_HELP}`);
      process.exit(2);
    }

    // Drop the optional `--` separator so its only job is shielding the inner
    // command's flags from fit-cli's argv parsing, not becoming an argument.
    const args = rest[0] === "--" ? rest.slice(1) : rest;
    const execution = createLocalFitExecutionContext();
    switch (action) {
      case "run":
        await execution.run(args[0], args.slice(1));
        return;
      case "capture":
        console.log(await execution.capture(args[0], args.slice(1)));
        return;
      case "path-exists":
        console.log(await execution.pathExists(args[0]));
        return;
      case "command-available":
        console.log(await execution.commandAvailable(args[0]));
        return;
      case "remove-tree":
        await execution.removeTree(args[0]);
        return;
    }
  });
}
