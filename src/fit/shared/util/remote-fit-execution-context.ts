import { createReadStream, createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { commandOn, formatBytes, formatCommandLine } from "../../../util/non-fit/fit-cli-log.js";
import { ensureRunDir, instanceInternalRunDir, type DefinitionRunPath } from "../../../util/non-fit/replay.js";
import { announceArtifactStream, type BackgroundStream } from "../../../util/non-fit/proc.js";
import { posixQuote, teeToFileCommand } from "../../../util/non-fit/remote-target.js";
import { SsmTarget, waitForSsmReady } from "../../../util/non-fit/ssm-target.js";
import type { ExecutionTarget } from "../../../util/non-fit/target.js";
import { resolveGithubTokenFromAws } from "../../util/config.js";
import { FIT_PERFORMER, repoPath } from "../../util/repos.js";
import { SDKS, sdkByValue, type Sdk } from "../../../util/sdk/sdks.js";
import { DEFAULT_PERFORMER_PORT } from "../../performers/util/performer-port.js";
import { collectJunitArtifactsFromTarget } from "../run-test-driver/collect-junit.js";
import {
  backgroundShellCommand,
  configureRemoteGitCredentials,
  ensureRemoteRepos,
  heartbeatShellCommand,
  pathPrefixedCommand,
  remoteArtifactsDir,
  remoteDockerWrapperPath,
  remoteDockerWrapperScript,
  remoteFitBinDir,
  remoteFitRepos,
  remoteFitRootDir,
  remoteGerritSshKeyPath,
  remotePerformerArgs,
  remoteRunArtifactsDir,
  stageGerritSshKey,
  type FitExecutionContext,
} from "./remote-fit-run.js";
import { resolveGerritSshKey } from "../../util/config.js";
import { getJsonSecret, AwsSecretError } from "../../../cloud/util/aws/secrets.js";

export const GERRIT_AWS_SECRET_ID = "fit-cli/gerrit/ssh-key";

/**
 * Resolve the Gerrit SSH private key path, falling back to AWS Secrets Manager
 * (`fit-cli/gerrit/ssh-key`, field `sshPrivateKey`) if no local key is found.
 * When the key comes from AWS it is written to a temp file and that path is returned.
 */
export async function resolveGerritKeyWithAwsFallback(): Promise<string | undefined> {
  const local = resolveGerritSshKey();
  if (local) return local;

  try {
    const secret = await getJsonSecret(GERRIT_AWS_SECRET_ID);
    const keyContent = secret.sshPrivateKey;
    if (!keyContent) return undefined;
    const tmpPath = join(tmpdir(), `fit-cli-gerrit-key-${process.pid}.pem`);
    const content = keyContent.endsWith("\n") ? keyContent : keyContent + "\n";
    writeFileSync(tmpPath, content, { mode: 0o600 });
    console.log(`\n→ Loaded Gerrit SSH key from AWS Secrets Manager (${GERRIT_AWS_SECRET_ID})`);
    return tmpPath;
  } catch (err) {
    if (err instanceof AwsSecretError) return undefined;
    throw err;
  }
}

/** Compressed size above which {@link createRemoteFitExecutionContext}'s `collectFile` keeps the file gzipped rather than decompressing it locally. */
export const DEFAULT_MAX_AUTO_DECOMPRESS_BYTES = 250 * 1024 * 1024;

/** Whether a collected file's compressed size is small enough to safely decompress locally. */
export function shouldAutoDecompress(compressedBytes: number, thresholdBytes: number = DEFAULT_MAX_AUTO_DECOMPRESS_BYTES): boolean {
  return compressedBytes <= thresholdBytes;
}

const REMOTE_APT_ENV = "DEBIAN_FRONTEND=noninteractive";

export function remoteAptWaitCommand(): string {
  return `
if command -v cloud-init >/dev/null 2>&1; then
  sudo -n cloud-init status --wait >/dev/null
fi
for _ in $(seq 1 60); do
  if ! pgrep -x apt >/dev/null 2>&1 && ! pgrep -x apt-get >/dev/null 2>&1 && ! pgrep -x dpkg >/dev/null 2>&1; then
    exit 0
  fi
  sleep 2
done
echo 'Timed out waiting for apt/dpkg activity to finish.' >&2
pgrep -a -x apt >&2 || true
pgrep -a -x apt-get >&2 || true
pgrep -a -x dpkg >&2 || true
exit 1`.trim();
}

export function remoteAptCleanupCommand(): string {
  return [
    "sudo -n find /var/lib/apt/lists -mindepth 1 -maxdepth 1 ! -name lock -exec rm -rf -- {} +",
    "sudo -n install -d -m 755 /var/lib/apt/lists/partial",
  ].join("; ");
}

export function remoteAptGetCommand(args: string): string {
  return `sudo -n env ${REMOTE_APT_ENV} apt-get -o DPkg::Lock::Timeout=120 ${args}`;
}

/**
 * Build a FitExecutionContext that runs against a remote box over SSH. Preparing
 * the box installs the FIT dependencies (git, docker, JDK), wires a passwordless
 * `docker` wrapper, configures git credentials, and clones the FIT repos — unless
 * `skipPreparation` is set, in which case the box is assumed to be fully ready
 * from a previous run and the entire preparation step is skipped.
 */
export async function createRemoteFitExecutionContext(
  target: ExecutionTarget,
  // Performers are prebuilt images and the only cloned repo (the test-driver) is
  // SDK-agnostic, so the box layout no longer varies by SDK — kept for the
  // signature shared with the local path and the standalone CLI.
  _sdk: Sdk,
  skipPreparation = false,
  instancePath: DefinitionRunPath | number = 0,
): Promise<FitExecutionContext> {
  const loginUser = await target.resolveLoginUser?.();
  const rootDir = remoteFitRootDir(loginUser);
  const binDir = remoteFitBinDir(rootDir);
  const localGerritKey = await resolveGerritKeyWithAwsFallback();

  if (skipPreparation) {
    console.log(`\n→ resume: reusing existing remote FIT workspace on ${target.description} (skipping preparation).`);
  } else {
    console.log(`\nPreparing a remote FIT workspace on ${target.description}...`);
    await target.run("mkdir", ["-p", rootDir]);

    console.log("\nInstalling the remote FIT dependencies...");
    // Clear stale/corrupt apt lists baked into the AMI before updating — a malformed
    // InRelease file causes GPG signature splitting to fail even on a fresh instance.
    await target.runHiddenUntilFailure("sh", ["-lc", remoteAptWaitCommand()], undefined, {
      display: "wait for cloud-init/apt",
    });
    await target.runHiddenUntilFailure("sh", ["-lc", remoteAptCleanupCommand()], undefined, {
      display: "clear /var/lib/apt/lists contents",
    });
    await target.runHiddenUntilFailure("sh", ["-lc", remoteAptGetCommand("update")], undefined, {
      display: "apt-get update",
    });
    await target.runHiddenUntilFailure("sh", [
      "-lc",
      remoteAptGetCommand("install -y git docker.io lsof openjdk-21-jdk"),
    ], undefined, { display: "apt-get install git docker.io lsof openjdk-21-jdk" });
    // Allow running Docker without sudo
    await target.run("sudo", ["-n", "usermod", "-aG", "docker", loginUser ?? "ubuntu"]);
    await target.run("sudo", ["-n", "systemctl", "enable", "--now", "docker"]);

    await target.run("mkdir", ["-p", binDir]);
    const internalDir = instanceInternalRunDir(instancePath);
    mkdirSync(internalDir, { recursive: true, mode: 0o700 });
    const localDockerWrapper = join(internalDir, "remote-docker-wrapper.sh");
    writeFileSync(localDockerWrapper, remoteDockerWrapperScript(), { mode: 0o700 });
    const wrapperPath = remoteDockerWrapperPath(rootDir);
    await target.putFile(localDockerWrapper, wrapperPath);
    await target.run("chmod", ["755", wrapperPath]);

    const githubToken = await resolveGithubTokenFromAws();
    if (githubToken) {
      await configureRemoteGitCredentials(target, rootDir, githubToken);
    } else {
      console.log(
        "\n⚠ No GitHub token found in AWS Secrets Manager — the private FIT repos will fail to clone.\n" +
          `  Populate the "fit-cli/github/token" AWS secret, or ask #the-fit-stop for help.`,
      );
    }

    await ensureRemoteRepos(target, rootDir, remoteFitRepos());

    if (localGerritKey) {
      console.log(`\n→ Staging Gerrit SSH key to remote instance...`);
      await stageGerritSshKey(target, rootDir, localGerritKey);
    }
  }

  const gerritSshKeyPath = localGerritKey ? remoteGerritSshKeyPath(rootDir) : undefined;

  // Write extra env vars (e.g. FIT_RESULTS_DB_PASSWORD) into a mode-600 file in the
  // never-uploaded _internal dir, stage it to the box, and return the remote path.
  // The driver command then `.`-sources this file, so the secret reaches the remote
  // process's environment without ever appearing on a command line (which would be
  // visible via `ps` / logged in the SSH invocation).
  const stageRemoteEnvFile = async (env: Record<string, string>): Promise<string> => {
    const internalDir = instanceInternalRunDir(instancePath);
    mkdirSync(internalDir, { recursive: true, mode: 0o700 });
    const localEnvFile = join(internalDir, "driver-env.sh");
    const contents = Object.entries(env).map(([k, v]) => `export ${k}=${posixQuote(v)}`).join("\n") + "\n";
    writeFileSync(localEnvFile, contents, { mode: 0o600 });
    const remoteEnvFile = join(rootDir, ".fit-driver-env.sh");
    await target.putFile(localEnvFile, remoteEnvFile);
    await target.run("chmod", ["600", remoteEnvFile]);
    return remoteEnvFile;
  };

  return {
    kind: "remote",
    description: target.description,
    target,
    rootDir,
    fitPerformerDir: repoPath(FIT_PERFORMER, rootDir),
    dockerCommand: "docker",
    artifacts: [],
    details: [{ label: "Remote workspace", value: rootDir }],
    gerritSshKeyPath,
    ensureWorkspace: async () => {
      await ensureRemoteRepos(target, rootDir, remoteFitRepos());
      return true;
    },
    run: (command, args, cwd, opts) =>
      target.run("sh", ["-lc", pathPrefixedCommand(binDir, command, args)], cwd, {
        display: commandOn(formatCommandLine(command, args), target.description),
        ...opts,
      }),
    capture: (command, args, cwd, opts) =>
      target.capture("sh", ["-lc", pathPrefixedCommand(binDir, command, args)], cwd, {
        display: commandOn(formatCommandLine(command, args), target.description),
        ...opts,
      }),
    runHiddenUntilFailure: (command, args, cwd, opts) =>
      target.runHiddenUntilFailure("sh", ["-lc", pathPrefixedCommand(binDir, command, args)], cwd, {
        display: commandOn(formatCommandLine(command, args), target.description),
        ...opts,
      }),
    streamToTerminalAndFile: async (command, args, targetPath, cwd) => {
      // The tee target's parent dir may not exist (per-run targets nest under
      // artifacts/instances/.../runs/N), so ensure it first.
      await target.run("mkdir", ["-p", dirname(targetPath)]);
      return target.run("bash", ["-lc", teeToFileCommand(pathPrefixedCommand(binDir, command, args), targetPath)], cwd, {
        display: commandOn(formatCommandLine(command, args), target.description),
      });
    },
    streamToArtifactFile: async (command, args, targetPath, cwd, env) => {
      // The redirect (`> targetPath`) won't create parent dirs, and per-run
      // targets now nest under artifacts/instances/.../runs/N — so ensure the dir.
      await target.run("mkdir", ["-p", dirname(targetPath)]);
      announceArtifactStream({
        logPath: targetPath,
        command: formatCommandLine(command, args),
        onHost: target.description,
      });
      // Secrets go via a sourced env file (see stageRemoteEnvFile), never on the
      // command line — only the file path appears in the invocation.
      const envSourcePrefix = env ? `. ${posixQuote(await stageRemoteEnvFile(env))} && ` : "";
      const innerCommand = envSourcePrefix + pathPrefixedCommand(binDir, command, args);
      return target.run("bash", ["-lc", heartbeatShellCommand(innerCommand, targetPath)], cwd, {
        display: commandOn(formatCommandLine(command, args), target.description),
        greyTextOutput: true,
      });
    },
    streamToArtifactFileInBackground: async (command, args, targetPath, cwd): Promise<BackgroundStream> => {
      await target.run("mkdir", ["-p", dirname(targetPath)]);
      const fullCommand = pathPrefixedCommand(binDir, command, args);
      const pid = (await target.capture("bash", ["-lc", backgroundShellCommand(fullCommand, targetPath)], cwd, {
        quiet: true,
      })).trim();
      console.log(`Streaming performer logs to:\n  ${targetPath}  (on ${target.description})`);
      return {
        drain: async () => {
          // Wait for the background process to exit (docker logs --follow exits when its container stops).
          await target.capture("bash", ["-lc",
            `pid=${posixQuote(pid)}; while kill -0 "$pid" 2>/dev/null; do sleep 1; done`,
          ], undefined, { quiet: true }).catch(() => {});
        },
      };
    },
    targetFilePath: (localPath) => join(remoteArtifactsDir(rootDir), relative(ensureRunDir(), localPath)),
    stageFile: async (localPath, targetPath) => {
      const destination = targetPath ?? join(rootDir, basename(localPath));
      // scp won't create intermediate dirs; per-run targets nest, so ensure the dir.
      await target.run("mkdir", ["-p", dirname(destination)]);
      await target.putFile(localPath, destination);
      return destination;
    },
    runArtifactsDir: (path) => remoteRunArtifactsDir(rootDir, path),
    collectFile: async (targetPath, localPath) => {
      mkdirSync(dirname(localPath), { recursive: true, mode: 0o700 });
      // Compress on the remote before downloading — log files compress 10:1+,
      // making SCP much faster over WAN. Mirrors the JUnit collect pattern.
      const [sizeLine, remoteGz] = (await target.capture("sh", [
        "-lc",
        `tmp=$(mktemp /tmp/fit-collect-XXXXXX.gz) && gzip -c ${posixQuote(targetPath)} > "$tmp" && stat -c%s "$tmp" && printf '%s\\n' "$tmp"`,
      ], undefined, { quiet: true })).trim().split("\n");
      const compressedBytes = Number(sizeLine);

      if (!shouldAutoDecompress(compressedBytes)) {
        // A GHA-hosted runner (ubuntu-latest) hit ENOSPC mid-decompression on an
        // oversized (802.6 MB compressed) performer log during a real run: expanding
        // needs headroom for both the compressed and raw copies at once, and these
        // runners only have a few GB free to begin with. Past this size, keep the
        // collected file compressed instead of risking the same failure.
        const keptGzPath = `${localPath}.gz`;
        try {
          await target.getFile(remoteGz, keptGzPath, compressedBytes);
          console.log(
            `\n→ Kept ${keptGzPath} compressed (${formatBytes(compressedBytes)}) — exceeds the ` +
              `${formatBytes(DEFAULT_MAX_AUTO_DECOMPRESS_BYTES)} auto-decompress threshold. ` +
              `Expand with: gunzip -k ${keptGzPath}`,
          );
        } finally {
          await target.run("rm", ["-f", remoteGz], undefined, { quiet: true });
        }
        return keptGzPath;
      }

      const localGz = `${localPath}.fit-gz`;
      try {
        await target.getFile(remoteGz, localGz, compressedBytes);
        await pipeline(createReadStream(localGz), createGunzip(), createWriteStream(localPath, { mode: 0o600 }));
      } finally {
        await target.run("rm", ["-f", remoteGz], undefined, { quiet: true });
        rmSync(localGz, { force: true });
      }
      return localPath;
    },
    removeTree: (path) => target.run("rm", ["-rf", path]),
    collectJunitArtifacts: async (sourceDir, path) =>
      await collectJunitArtifactsFromTarget(target, sourceDir, path),
    pathExists: (path) => target.run("test", ["-e", path], undefined, { quiet: true }).then(() => true).catch(() => false),
    commandAvailable: (command) =>
      target
        .capture("sh", ["-lc", `command -v ${posixQuote(command)} >/dev/null && printf yes || printf no`], undefined, { quiet: true })
        .then((output) => output.trim() === "yes")
        .catch(() => false),
    performerRunArgs: (imageName, hostPort = DEFAULT_PERFORMER_PORT) => remotePerformerArgs(imageName, hostPort),
  };
}

/**
 * Mini CLI: prepare a remote FIT execution context against an EC2 instance
 * (over SSM) and, optionally, run one operation against it. Run with --help
 * for the flags, or:
 *
 *   bun src/fit/shared/util/remote-fit-execution-context.ts --help
 *   # Prepare (full flow): install deps + clone repos on the box.
 *   bun src/fit/shared/util/remote-fit-execution-context.ts --instance i-0123456789abcdef0 --sdk python
 *   # Reuse an already-prepared box, then run one command against the context.
 *   bun src/fit/shared/util/remote-fit-execution-context.ts --instance i-0123456789abcdef0 --sdk python --skip-preparation capture -- ls
 *
 * Needs an EC2 instance registered with SSM (e.g. a box left running). This is
 * for debugging/development of createRemoteFitExecutionContext, not end-users.
 */
const REMOTE_CLI_ACTIONS = ["run", "capture", "path-exists", "command-available", "remove-tree"] as const;
type RemoteCliAction = (typeof REMOTE_CLI_ACTIONS)[number];

function isRemoteCliAction(value: string | undefined): value is RemoteCliAction {
  return REMOTE_CLI_ACTIONS.includes(value as RemoteCliAction);
}

const REMOTE_CLI_HELP = `Prepare a remote FIT execution context (createRemoteFitExecutionContext) over SSM.

Usage:
  tsx src/workflows/fit-shared/util/remote-fit-execution-context.ts --instance <ec2-id> --sdk <sdk> [options] [<subcommand> [args]]

Required:
  --instance <ec2-id>               EC2 instance id to prepare the FIT workspace on.
  --sdk <${SDKS.map((s) => s.value).join("|")}>
                                   Which SDK's repos to clone.

Options:
  --user <name>                    Login user on the box (default: ubuntu).
  --skip-preparation               Reuse an already-prepared box (skip apt install + clones).
  --help, -h                       Show this help.

Subcommands (run after the context is prepared; omit to just prepare and report):
  run <command> [args...]          Run a command on the box, streaming its output.
  capture <command> [args...]      Run a command on the box and print its captured stdout.
  path-exists <path>               Print true/false for whether <path> exists on the box.
  command-available <command>      Print true/false for whether <command> is on the box's PATH.
  remove-tree <path>               Recursively remove <path> on the box (rm -rf).

Put a \`--\` before the forwarded command so its own flags aren't parsed by fit-cli, e.g.
  ... capture -- ls -la`;

/** Pull the named string flag (`--name <value>`) out of argv, returning the rest. */
function takeFlag(argv: string[], name: string): { value?: string; rest: string[] } {
  const i = argv.indexOf(name);
  if (i === -1) return { rest: argv };
  return { value: argv[i + 1], rest: [...argv.slice(0, i), ...argv.slice(i + 2)] };
}

/** Pull a boolean flag (`--name`) out of argv, returning the rest. */
function takeBoolFlag(argv: string[], name: string): { present: boolean; rest: string[] } {
  const i = argv.indexOf(name);
  if (i === -1) return { present: false, rest: argv };
  return { present: true, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const rawArgs = process.argv.slice(2);
    if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
      console.log(REMOTE_CLI_HELP);
      return;
    }

    const instanceFlag = takeFlag(rawArgs, "--instance");
    const sdkFlag = takeFlag(instanceFlag.rest, "--sdk");
    const userFlag = takeFlag(sdkFlag.rest, "--user");
    const skipFlag = takeBoolFlag(userFlag.rest, "--skip-preparation");

    const instanceId = instanceFlag.value;
    const sdk = sdkFlag.value ? sdkByValue(sdkFlag.value) : undefined;
    if (!instanceId || !sdk) {
      console.error(`Missing --instance and/or a valid --sdk.\n\n${REMOTE_CLI_HELP}`);
      process.exit(2);
    }

    process.stdout.write(`Waiting for ${instanceId} to register with SSM...`);
    if (!(await waitForSsmReady(instanceId))) {
      console.log(" unreachable");
      console.error(`Couldn't reach ${instanceId} over SSM. Check the instance id and that it's up.`);
      process.exit(1);
    }
    console.log(" ready");

    const target = new SsmTarget(instanceId, userFlag.value);
    const execution = await createRemoteFitExecutionContext(target, sdk, skipFlag.present);

    // Drop the optional `--` separator so its only job is shielding the inner
    // command's flags from fit-cli's argv parsing, not becoming an argument.
    const [action, ...rest] = skipFlag.rest;
    if (action === undefined) {
      console.log(`\n✓ Prepared remote FIT context on ${execution.description} (rootDir: ${execution.rootDir}).`);
      return;
    }
    if (!isRemoteCliAction(action)) {
      console.error(`Unknown subcommand "${action}".\n\n${REMOTE_CLI_HELP}`);
      process.exit(2);
    }

    const args = rest[0] === "--" ? rest.slice(1) : rest;
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
