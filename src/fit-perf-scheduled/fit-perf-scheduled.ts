/**
 * fit-perf-scheduled — run FIT/PERF (SDK performance testing) on a clean, throwaway
 * EC2 instance.
 *
 * Run on its own:
 *   bun src/fit-perf-scheduled/fit-perf-scheduled.ts [--config <path>] [--dry-run]
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { isMain } from "../util/non-fit/cli.js";
import { posixQuote, teeToFileCommand } from "../util/non-fit/remote-target.js";
import { parseAllocatedId } from "../cluster/cluster-create/parse-allocated-id.js";
import { parseConnstr } from "../cluster/cluster-select/parse-connstr.js";
import { buildCbdinoclusterFromPr, installCbdinoclusterRemote } from "../cluster/cluster-create/install-cbdinocluster.js";
import { defaultCbdinoclusterInitArgs } from "../cluster/cluster-create/default-cbdinocluster-init-config.js";
import { resolveGithubTokenFromAws } from "../fit/util/config.js";
import { loadEnvironments } from "../fit/util/environments.js";
import { provisionFitInstance, FIT_INSTANCE_USER } from "../fit/util/aws/fit-instance.js";
import { FIT_PERFORMER, repoPath, type Repo } from "../fit/util/repos.js";
import { checkAwsCredentials } from "../cloud/util/aws/identity.js";
import { AWS_REGION } from "../cloud/util/aws/aws-target.js";
import { GHCR_REGISTRY } from "../fit/performers/util/performer-image.js";
import {
  configureRemoteGitCredentials,
  ensureRemoteRepos,
  remoteGerritSshKeyPath,
  stageGerritSshKey,
} from "../fit/shared/util/remote-fit-run.js";
import { uploadRemoteAwsCredentials } from "../fit/shared/util/remote-aws-creds.js";
import {
  remoteAptCleanupCommand,
  remoteAptGetCommand,
  remoteAptWaitCommand,
  resolveGerritKeyWithAwsFallback,
} from "../fit/shared/util/remote-fit-execution-context.js";
import {
  checkoutFetchHeadArgs,
  fitPerformerGerritFetchArgs,
  gerritSshCommand,
  requireGerritUser,
} from "../fit/performers/checkout-fit-gerrit-ref/checkout-fit-gerrit-ref.js";

const DEFAULT_CONFIG_PATH = join(import.meta.dirname, "config", "fit-perf-scheduled.yaml");
const INSTANCE_INFO_PATH = "fit-perf-scheduled-instance.json";
const DB_PASSWORD_ENV_VAR = "FIT_PERF_DB_PASSWORD";
const REMOTE_ROOT_DIR = `/home/${FIT_INSTANCE_USER}/fit-perf-scheduled`;

// jenkins-sdk hardcodes `--network perf` for the driver/performer containers it starts
// itself (a legacy assumption from its original Jenkins CI environment) - it isn't
// configurable. So the cluster cbdinocluster allocates has to live on a network of
// that same name, overriding fit-cli's usual "fit" default, or the driver/performer
// can't reach it.
const DOCKER_NETWORK = "perf";

function jenkinsSdkRepo(branch?: string): Repo {
  return {
    name: "jenkins-sdk",
    dir: "jenkins-sdk",
    sshUrl: "git@github.com:couchbaselabs/jenkins-sdk.git",
    httpsUrl: "https://github.com/couchbaselabs/jenkins-sdk/",
    branch,
  };
}

const COUCHBASE_JVM_CLIENTS: Repo = {
  name: "couchbase-jvm-clients",
  dir: "couchbase-jvm-clients",
  sshUrl: "git@github.com:couchbase/couchbase-jvm-clients.git",
  httpsUrl: "https://github.com/couchbase/couchbase-jvm-clients/",
};

function parseArgs(argv: string[]): {
  configPath: string;
  dryRun: boolean;
  keepOnFailure: boolean;
  jenkinsSdkBranch: string | undefined;
  transactionsFitPerformerRef: string | undefined;
  cbdinoclusterPr: number | undefined;
  help: boolean;
} {
  const configIndex = argv.indexOf("--config");
  const branchIndex = argv.indexOf("--jenkins-sdk-branch");
  const transactionsFitPerformerRefIndex = argv.indexOf("--transactions-fit-performer-ref");
  const cbdinoclusterPrIndex = argv.indexOf("--cbdinocluster-pr");
  const cbdinoclusterPrStr = cbdinoclusterPrIndex !== -1 ? argv[cbdinoclusterPrIndex + 1] : undefined;
  if (cbdinoclusterPrStr !== undefined && (!/^\d+$/.test(cbdinoclusterPrStr) || Number(cbdinoclusterPrStr) <= 0)) {
    throw new Error(`--cbdinocluster-pr must be a positive integer, got: ${cbdinoclusterPrStr}`);
  }
  return {
    configPath: configIndex !== -1 ? argv[configIndex + 1] : DEFAULT_CONFIG_PATH,
    dryRun: argv.includes("--dry-run"),
    keepOnFailure: argv.includes("--keep-on-failure"),
    jenkinsSdkBranch: branchIndex !== -1 ? argv[branchIndex + 1] : undefined,
    transactionsFitPerformerRef:
      transactionsFitPerformerRefIndex !== -1 ? argv[transactionsFitPerformerRefIndex + 1] : undefined,
    cbdinoclusterPr: cbdinoclusterPrStr !== undefined ? Number(cbdinoclusterPrStr) : undefined,
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

function printHelp(): void {
  console.log(`Usage: bun src/fit-perf-scheduled/fit-perf-scheduled.ts [--config <path>] [--dry-run] [--keep-on-failure] [--jenkins-sdk-branch <branch>] [--transactions-fit-performer-ref <ref>] [--cbdinocluster-pr <n>]

Launches a clean EC2 instance, allocates a Couchbase cluster with cbdinocluster,
builds and runs jenkins-sdk against the config, and writes results to the
production perf results database (performance-sdk.couchbase.com).

  --config <path>            Path to the jenkins-sdk config YAML (default: config/fit-perf-scheduled.yaml
                             next to this script — a copy of fit-as-a-service's config).
  --dry-run                  Force variables.dryRun=true regardless of what the config says.
  --keep-on-failure          Leave the EC2 instance running for debugging if the run fails.
                             Default is to terminate it on failure too — only this flag keeps it up.
  --jenkins-sdk-branch <branch>
                             Clone this branch of jenkins-sdk instead of its default branch, e.g.
                             --jenkins-sdk-branch prebuilt-container-rollout.
  --transactions-fit-performer-ref <ref>
                             Fetch and check out this Gerrit ref (e.g. refs/changes/29/246329/1) in the
                             transactions-fit-performer checkout before building it.
  --cbdinocluster-pr <n>     Build cbdinocluster from this couchbaselabs/cbdinocluster PR instead of
                             installing the latest release.
  --help, -h                 Show this help.
`);
}

/** Everything from the config we actually inspect/mutate; the rest passes through untouched. */
interface JenkinsSdkConfig {
  servers?: { driver?: { source?: string } };
  variables?: { dryRun?: boolean; [key: string]: unknown };
  matrix?: { clusters?: Array<Record<string, unknown>> };
  [key: string]: unknown;
}

async function main(): Promise<void> {
  const { configPath, dryRun, keepOnFailure, jenkinsSdkBranch, transactionsFitPerformerRef, cbdinoclusterPr, help } = parseArgs(
    process.argv.slice(2),
  );
  if (help) {
    printHelp();
    return;
  }

  console.log(`Loading jenkins-sdk config from ${configPath}...`);
  const config = parseYaml(readFileSync(configPath, "utf8")) as JenkinsSdkConfig;

  const cluster0 = config.matrix?.clusters?.[0];
  const cbdinoDef = cluster0?.cbdino;
  if (!cluster0 || !cbdinoDef) {
    throw new Error(`${configPath}: matrix.clusters[0].cbdino is required to allocate a cluster.`);
  }

  if (dryRun) {
    config.variables = { ...config.variables, dryRun: true };
    console.log("--dry-run: forcing variables.dryRun=true");
  }

  // The results-DB password is never resolved here, written into the config file, or handled by
  // this process at all — it's fetched by the instance itself, directly from AWS Secrets Manager,
  // once AWS credentials have been forwarded to it (see below). perf-driver reads it from the
  // DB_PASSWORD_ENV_VAR environment variable.
  const resultsSecretId = loadEnvironments().results.prod?.secretId;
  if (!resultsSecretId) {
    throw new Error(`No secretId configured for the "prod" results environment in environments.json5.`);
  }

  // Must match wherever we actually clone the repos below (REMOTE_ROOT_DIR), not whatever
  // the config file happens to say — overridden here rather than trusted from the file.
  config.servers = { ...config.servers, driver: { ...config.servers?.driver, source: REMOTE_ROOT_DIR } };

  console.log("Provisioning a clean EC2 instance for the run...");
  const provisioned = await provisionFitInstance({ interactive: false });
  const { target } = provisioned;
  const scratchDir = mkdtempSync(join(tmpdir(), "fit-perf-scheduled-"));

  // Written before anything else so an external cleanup step (the GHA workflow's
  // "Terminate instance if cancelled") can find and terminate this instance even if this
  // process is killed outright rather than getting to run its own catch/cleanup below.
  writeFileSync(INSTANCE_INFO_PATH, JSON.stringify({ instanceId: provisioned.instanceId }));

  try {
    console.log("\nInstalling FIT/PERF dependencies...");
    await target.runHiddenUntilFailure("sh", ["-lc", remoteAptWaitCommand()], undefined, { display: "wait for cloud-init/apt" });
    await target.runHiddenUntilFailure("sh", ["-lc", remoteAptCleanupCommand()], undefined, { display: "clear /var/lib/apt/lists contents" });
    await target.runHiddenUntilFailure("sh", ["-lc", remoteAptGetCommand("update")], undefined, { display: "apt-get update" });
    await target.runHiddenUntilFailure(
      "sh",
      ["-lc", remoteAptGetCommand("install -y git docker.io lsof openjdk-21-jdk maven awscli jq")],
      undefined,
      { display: "apt-get install git docker.io lsof openjdk-21-jdk maven awscli jq" },
    );
    await target.runHiddenUntilFailure("sudo", ["usermod", "-aG", "docker", FIT_INSTANCE_USER]);
    await target.runHiddenUntilFailure("sudo", ["-n", "systemctl", "enable", "--now", "docker"]);

    console.log("\nInstalling cbdinocluster...");
    const cbdinocluster =
      cbdinoclusterPr !== undefined
        ? await buildCbdinoclusterFromPr(target, { pr: cbdinoclusterPr })
        : await installCbdinoclusterRemote(target);

    console.log("\nInitializing cbdinocluster...");
    const initArgs = defaultCbdinoclusterInitArgs(DOCKER_NETWORK).trim().split(/\s+/).filter(Boolean);
    await target.runHiddenUntilFailure("bash", ["-lc", [cbdinocluster, "init", ...initArgs, "--disable-github"].map(posixQuote).join(" ")], undefined, {
      display: `cbdinocluster init ${initArgs.join(" ")} --disable-github`,
    });
    await target.runHiddenUntilFailure(
      "sh",
      ["-lc", `docker network inspect ${posixQuote(DOCKER_NETWORK)} >/dev/null 2>&1 || docker network create ${posixQuote(DOCKER_NETWORK)}`],
      undefined,
      { display: `ensure docker network ${DOCKER_NETWORK} exists` },
    );

    console.log("\nCloning repositories...");
    await target.runHiddenUntilFailure("mkdir", ["-p", REMOTE_ROOT_DIR]);
    const githubToken = await resolveGithubTokenFromAws();
    if (!githubToken) {
      throw new Error(
        `No GitHub token found in AWS Secrets Manager (fit-cli/github/token) — can't clone the private repos.`,
      );
    }
    await configureRemoteGitCredentials(target, REMOTE_ROOT_DIR, githubToken);
    if (jenkinsSdkBranch) {
      console.log(`Using jenkins-sdk branch: ${jenkinsSdkBranch}`);
    }
    await ensureRemoteRepos(target, REMOTE_ROOT_DIR, [FIT_PERFORMER, jenkinsSdkRepo(jenkinsSdkBranch), COUCHBASE_JVM_CLIENTS]);

    if (transactionsFitPerformerRef) {
      console.log(`\nChecking out transactions-fit-performer Gerrit ref ${transactionsFitPerformerRef}...`);
      const gerritUser = await requireGerritUser();
      const localGerritKey = await resolveGerritKeyWithAwsFallback();
      if (!localGerritKey) {
        throw new Error(
          `--gerrit-ref was set but no Gerrit SSH key was found (checked gerrit.sshKey in config and the ` +
            `fit-cli/gerrit/ssh-key AWS secret).`,
        );
      }
      await stageGerritSshKey(target, REMOTE_ROOT_DIR, localGerritKey);
      const remoteGerritKeyPath = remoteGerritSshKeyPath(REMOTE_ROOT_DIR);
      const sshCmd = gerritSshCommand(remoteGerritKeyPath);
      const fetchArgs = fitPerformerGerritFetchArgs(transactionsFitPerformerRef, gerritUser);
      const fitPerformerDir = repoPath(FIT_PERFORMER, REMOTE_ROOT_DIR);
      await target.runHiddenUntilFailure(
        "sh",
        ["-c", `GIT_SSH_COMMAND=${posixQuote(sshCmd)} git ${fetchArgs.map(posixQuote).join(" ")}`],
        fitPerformerDir,
        { display: `GIT_SSH_COMMAND=<gerrit-key> git ${fetchArgs.join(" ")}` },
      );
      await target.runHiddenUntilFailure("git", checkoutFetchHeadArgs(), fitPerformerDir);
      console.log(`✓ Checked out transactions-fit-performer at Gerrit ref ${transactionsFitPerformerRef}`);
    }

    // jenkins-sdk's prebuilt-container-rollout branch has most SDKs `docker pull` their
    // performer image straight from ghcr.io/couchbase (the same private packages fit-cli's
    // own performer commands use) instead of building from source, so Docker on the
    // instance needs to be authenticated to GHCR too, not just git.
    console.log("\nAuthenticating Docker to GHCR (for jenkins-sdk's prebuilt performer image pulls)...");
    const ghcrTokenLocalPath = join(scratchDir, "ghcr-token");
    writeFileSync(ghcrTokenLocalPath, `${githubToken}\n`, { mode: 0o600 });
    const ghcrTokenRemotePath = `${REMOTE_ROOT_DIR}/.ghcr-token`;
    await target.putFile(ghcrTokenLocalPath, ghcrTokenRemotePath);
    await target.runHiddenUntilFailure("chmod", ["600", ghcrTokenRemotePath]);
    await target.runHiddenUntilFailure(
      "sh",
      ["-lc", `cat ${posixQuote(ghcrTokenRemotePath)} | docker login ${posixQuote(GHCR_REGISTRY)} --username x-access-token --password-stdin`],
      undefined,
      { display: `docker login ${GHCR_REGISTRY}` },
    );
    await target.runHiddenUntilFailure("rm", ["-f", ghcrTokenRemotePath]);

    console.log("\nForwarding AWS credentials to the instance (so it can fetch the results-DB password itself)...");
    const awsCreds = await checkAwsCredentials();
    if (!awsCreds.ok) throw new Error(`AWS credentials are not usable: ${awsCreds.message}`);
    await uploadRemoteAwsCredentials(target, REMOTE_ROOT_DIR, awsCreds.credentials);

    console.log("\nAllocating the Couchbase cluster with cbdinocluster...");
    const defLocalPath = join(scratchDir, "cbdino-def.yaml");
    writeFileSync(defLocalPath, stringifyYaml(cbdinoDef));
    const defRemotePath = `${REMOTE_ROOT_DIR}/cbdino-def.yaml`;
    await target.putFile(defLocalPath, defRemotePath);

    const allocateOutput = await target.capture(cbdinocluster, ["--verbose", "allocate", "--deployer", "docker", `--def-file=${defRemotePath}`]);
    const clusterId = parseAllocatedId(allocateOutput);
    if (!clusterId) throw new Error(`Could not find an allocated cluster id in:\n${allocateOutput}`);
    console.log(`✓ Allocated cluster ${clusterId}`);

    const connstrOutput = await target.capture(cbdinocluster, ["connstr", clusterId]);
    const connstr = parseConnstr(connstrOutput);
    if (!connstr) throw new Error(`Could not find a connection string in:\n${connstrOutput}`);
    const nodeIp = connstr.replace(/^couchbases?:\/\//i, "");
    console.log(`✓ Cluster node at ${nodeIp}`);

    console.log("\nFinalizing config with cluster connection details...");
    delete cluster0.cbdino;
    cluster0.hostname = nodeIp;
    cluster0.hostname_docker = nodeIp;
    cluster0.hostname_rest = `http://${nodeIp}:8091`;
    cluster0.hostname_rest_docker = `http://${nodeIp}:8091`;
    cluster0.connection_string_driver = `couchbase://${nodeIp}`;
    cluster0.connection_string_driver_docker = `couchbase://${nodeIp}`;
    cluster0.connection_string_performer = `couchbase://${nodeIp}`;
    cluster0.connection_string_performer_docker = `couchbase://${nodeIp}`;

    const jenkinsSdkDir = repoPath(jenkinsSdkRepo(jenkinsSdkBranch), REMOTE_ROOT_DIR);
    const configLocalPath = join(scratchDir, "job-config.yaml");
    writeFileSync(configLocalPath, stringifyYaml(config));
    await target.runHiddenUntilFailure("mkdir", ["-p", `${jenkinsSdkDir}/config`]);
    await target.putFile(configLocalPath, `${jenkinsSdkDir}/config/job-config.yaml`);

    console.log("\nBuilding transactions-fit-performer (mvn clean install -Dmaven.test.skip)...");
    await target.run("mvn", ["clean", "install", "-Dmaven.test.skip"], repoPath(FIT_PERFORMER, REMOTE_ROOT_DIR));

    console.log("\nBuilding jenkins-sdk (./gradlew shadowJar)...");
    await target.run("./gradlew", ["shadowJar"], jenkinsSdkDir);

    console.log("\nRunning jenkins-sdk against the config (this can take a long time)...");
    // Resolve the shadowJar output by glob rather than a hardcoded name — the exact jar
    // name is a jenkins-sdk build detail this script shouldn't have to track by hand.
    const jarListing = (await target.capture("sh", ["-lc", "ls build/libs/*-all.jar 2>/dev/null"], jenkinsSdkDir))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (jarListing.length !== 1) {
      throw new Error(
        `Expected exactly one build/libs/*-all.jar after ./gradlew shadowJar, found: ${jarListing.join(", ") || "(none)"}`,
      );
    }
    const [jarPath] = jarListing;

    // Fetch the results-DB password directly on the instance — it never passes through this
    // process or over SCP, only through the box's own (encrypted) call to Secrets Manager.
    // `@sh` shell-quotes the value so it's safe to source regardless of its contents.
    const envFileRemote = `${REMOTE_ROOT_DIR}/.fit-perf-driver-env.sh`;
    await target.runHiddenUntilFailure(
      "bash",
      [
        "-lc",
        `set -o pipefail; aws secretsmanager get-secret-value --secret-id ${posixQuote(resultsSecretId)} ` +
          `--region ${posixQuote(AWS_REGION)} --query SecretString --output text ` +
          `| jq -r '"export ${DB_PASSWORD_ENV_VAR}=" + (.password | @sh)' > ${posixQuote(envFileRemote)}`,
      ],
      undefined,
      { display: `fetch ${DB_PASSWORD_ENV_VAR} from AWS Secrets Manager (${resultsSecretId}) on the instance` },
    );
    // jenkins-sdk's Java code itself (not just `docker pull`) checks GITHUB_TOKEN when
    // pulling prebuilt performer images from ghcr.io, so the java process needs it exported
    // too, alongside DB_PASSWORD_ENV_VAR.
    const githubTokenEnvLocalPath = join(scratchDir, "github-token-env.sh");
    writeFileSync(githubTokenEnvLocalPath, `export GITHUB_TOKEN=${posixQuote(githubToken)}\n`, { mode: 0o600 });
    const githubTokenEnvRemotePath = `${REMOTE_ROOT_DIR}/.github-token-env.sh`;
    await target.putFile(githubTokenEnvLocalPath, githubTokenEnvRemotePath);
    await target.runHiddenUntilFailure("sh", ["-lc", `cat ${posixQuote(githubTokenEnvRemotePath)} >> ${posixQuote(envFileRemote)}`]);
    await target.runHiddenUntilFailure("rm", ["-f", githubTokenEnvRemotePath]);
    await target.runHiddenUntilFailure("chmod", ["600", envFileRemote]);

    const remoteLogPath = `${jenkinsSdkDir}/logs/jenkins_sdk_run.log`;
    await target.runHiddenUntilFailure("mkdir", ["-p", `${jenkinsSdkDir}/logs`]);
    await target.run("bash", ["-lc", teeToFileCommand(`. ${envFileRemote} && java -jar ${jarPath}`, remoteLogPath)], jenkinsSdkDir);

    const localLogPath = join(scratchDir, "jenkins_sdk_run.log");
    await target.getFile(remoteLogPath, localLogPath);
    console.log(`\n✓ jenkins-sdk run succeeded. Log saved to ${localLogPath}`);

    console.log(`\nTerminating instance ${provisioned.instanceId} (run succeeded)...`);
    await provisioned.terminate();
    rmSync(INSTANCE_INFO_PATH, { force: true });
  } catch (err) {
    if (keepOnFailure) {
      console.error(
        `\n✗ FIT/PERF run failed — --keep-on-failure was passed, so instance ${provisioned.instanceId} is ` +
          `being left running for debugging (see the SSH command printed above). Terminate it yourself when done.`,
      );
    } else {
      console.error(`\n✗ FIT/PERF run failed — terminating instance ${provisioned.instanceId}...`);
      try {
        await provisioned.terminate();
        rmSync(INSTANCE_INFO_PATH, { force: true });
      } catch (terminateErr) {
        console.error(
          `✗ Also failed to terminate instance ${provisioned.instanceId} — you'll need to clean it up yourself: ` +
            (terminateErr instanceof Error ? terminateErr.message : String(terminateErr)),
        );
      }
    }
    throw err;
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
