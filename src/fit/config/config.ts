#!/usr/bin/env node
/**
 * Top-level dispatcher for the `config` bun script.
 *
 * bun run config edit [--auto] [--dry-run] [--disable-aws] [--disable-github]
 *                     [--aws-instance-type <t>]
 *                     [--github-user <u>] [--github-token <t>]
 *                     [--config-path <path>]
 * bun run config show [--config-path <path>]
 * bun run config --help
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { installFitCliConsoleFormatting, runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import { runAutoEdit, runEditWorkflow, formatConfigForDisplay, buildAutoConfig, printResolutionLog } from "./edit.js";
import {
  CLOUD_INSTANCE_PURPOSES,
  defaultFitCliConfigPath,
  loadFitCliConfig,
  type FitCliInstanceTypes,
} from "../util/config.js";

function helpText(): string {
  const p = runScriptPrefix("config");
  return `Manage fit-cli configuration.

Usage:
  ${p} edit [options]
  ${p} show [--config-path <path>]
  ${p} --help

Subcommands:
  edit   Create or update the fit-cli config file (interactive by default).
  show   Print the current config with secrets elided.

Edit options:
  --auto                 Non-interactive mode. Reads from env vars and CLI args only.
  --dry-run              Show what would be written without touching the config file.
  --suppress-artifacts   Skip creating a fit-cli artifact directory. Use this on CI config
                         steps to avoid polluting the run's artifact directory.
  --disable-aws          Skip writing the aws section.
  --disable-github       Skip writing the github section.
  --disable-gerrit       Skip writing the gerrit section.
  --disable-capella      Skip writing the capella section.
  --disable-localhost    Skip writing the localhost section (source checkout + cbdinocluster path).
  --aws-instance-type-functional <t>  EC2 instance type for functional tests
                         (env: FIT_EC2_INSTANCE_TYPE_FUNCTIONAL / FIT_EC2_INSTANCE_TYPE, default: c5.2xlarge).
  --aws-instance-type-situational <t> EC2 instance type for situational (SIT) tests
                         (env: FIT_EC2_INSTANCE_TYPE_SITUATIONAL / FIT_EC2_INSTANCE_TYPE, default: c5.xlarge).
  --aws-instance-type-perf <t>        EC2 instance type for performance (PERF) tests
                         (env: FIT_EC2_INSTANCE_TYPE_PERF / FIT_EC2_INSTANCE_TYPE, default: c5.4xlarge).
  --github-user <u>      GitHub username (env: GITHUB_USER).
                         Optional: on EC2 test instances the "fit-cli/github/token" AWS secret is used instead.
  --github-token <t>     GitHub PAT (env: GITHUB_TOKEN / GH_TOKEN).
                         Optional: falls back to the "fit-cli/github/token" AWS secret for EC2 use.
  --output-format <fmt>  Default format for generated definition files: json5 or yaml (env: FIT_OUTPUT_FORMAT; default: json5).
  --gerrit-user <u>      Gerrit username (env: FIT_GERRIT_USER / GERRIT_USER; defaults to github.user).
                         Gerrit SSH key is auto-discovered from env vars or ~/.ssh/ at runtime
                         (AWS secret "fit-cli/gerrit/ssh-key" used as fallback on EC2).
  --capella-username <u> Your Capella username for situational/SIT runs (env: CAPELLA_USER / CAP_USER).
  --capella-password <p> Your Capella password (env: CAPELLA_PASS / CAP_PASS).
  --capella-api-key <k>  Your Capella v4 organization API key (env: CAPELLA_API_KEY).
                         Optional: falls back to the shared per-environment key in AWS Secrets Manager.
  --capella-api-secret <s> Your Capella v4 organization API secret (env: CAPELLA_API_SECRET).
  --fit-performer-dir <path>  Path to your local transactions-fit-performer checkout, for localhost runs
                         (env: FIT_PERFORMER_DIR). Stored under localhost.repos.
  --cbdinocluster-path <path> Absolute path to the cbdinocluster binary, for non-PATH installs (localhost runs)
                         (env: CBDINOCLUSTER_PATH). Stored under localhost.
  --config-path <path>   Override config file path (default: ~/.fit-cli/config.json5).
                         (Capella endpoint/oid and the results-DB credentials are no longer set here —
                          they come from environments.json5 + AWS Secrets Manager, keyed by the
                          environment selected in the definition file.)
  -h, --help             Show this help.`;
}

export interface AutoInitCliArgs {
  auto: boolean;
  dryRun: boolean;
  disableAws: boolean;
  disableGithub: boolean;
  disableGerrit: boolean;
  disableCapella: boolean;
  disableLocalhost: boolean;
  /** Default EC2 instance type per testing purpose. */
  awsInstanceTypes?: FitCliInstanceTypes;
  githubUser?: string;
  githubToken?: string;
  outputFormat?: string;
  gerritUser?: string;
  capellaUsername?: string;
  capellaPassword?: string;
  capellaApiKey?: string;
  capellaApiSecret?: string;
  /** Local transactions-fit-performer checkout dir (localhost runs). */
  fitPerformerDir?: string;
  cbdinoclusterPath?: string;
  configPath: string;
  /** Skip creating a fit-cli artifact directory for this run. Used for the CI config step. */
  suppressArtifacts: boolean;
}

function consumeFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

function consumeValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`Missing value for ${flag}`);
    process.exit(2);
  }
  args.splice(idx, 2);
  return value;
}

export function parseEditArgs(argv: string[]): AutoInitCliArgs {
  const args = [...argv];

  const auto = consumeFlag(args, "--auto");
  const dryRun = consumeFlag(args, "--dry-run");
  const suppressArtifacts = consumeFlag(args, "--suppress-artifacts");
  const disableAws = consumeFlag(args, "--disable-aws");
  const disableGithub = consumeFlag(args, "--disable-github");
  const disableGerrit = consumeFlag(args, "--disable-gerrit");
  const disableCapella = consumeFlag(args, "--disable-capella");
  const disableLocalhost = consumeFlag(args, "--disable-localhost");

  const awsInstanceTypes: FitCliInstanceTypes = {};
  for (const purpose of CLOUD_INSTANCE_PURPOSES) {
    const value = consumeValue(args, `--aws-instance-type-${purpose}`);
    if (value !== undefined) awsInstanceTypes[purpose] = value;
  }
  const githubUser = consumeValue(args, "--github-user");
  const githubToken = consumeValue(args, "--github-token");
  const outputFormat = consumeValue(args, "--output-format");
  const gerritUser = consumeValue(args, "--gerrit-user");
  const capellaUsername = consumeValue(args, "--capella-username");
  const capellaPassword = consumeValue(args, "--capella-password");
  const capellaApiKey = consumeValue(args, "--capella-api-key");
  const capellaApiSecret = consumeValue(args, "--capella-api-secret");
  const fitPerformerDir = consumeValue(args, "--fit-performer-dir");
  const cbdinoclusterPath = consumeValue(args, "--cbdinocluster-path");
  const configPath = consumeValue(args, "--config-path") ?? defaultFitCliConfigPath();

  // Warn about unknown flags
  for (const arg of args) {
    if (arg.startsWith("--") || (arg.startsWith("-") && arg.length > 1)) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(2);
    }
  }

  return {
    auto,
    dryRun,
    suppressArtifacts,
    disableAws,
    disableGithub,
    disableGerrit,
    disableCapella,
    disableLocalhost,
    ...(Object.keys(awsInstanceTypes).length > 0 ? { awsInstanceTypes } : {}),
    githubUser,
    githubToken,
    outputFormat,
    gerritUser,
    capellaUsername,
    capellaPassword,
    capellaApiKey,
    capellaApiSecret,
    fitPerformerDir,
    cbdinoclusterPath,
    configPath,
  };
}

export function runConfigMain(): void {
  const argv = process.argv.slice(2);
  const [subcommand, ...rest] = argv;

  // --suppress-artifacts: run auto-edit without creating a fit-cli artifact
  // directory, so CI config steps don't leave an extra directory in /tmp/fit-cli/
  // that would be picked up by the upload-artifact step.
  const suppressArtifacts = rest.includes("--suppress-artifacts");

  if (suppressArtifacts && subcommand === "edit" && rest.includes("--auto")) {
    installFitCliConsoleFormatting();
    const args = parseEditArgs(rest);
    runAutoEdit(args).catch((err) => {
      process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
      process.exit(1);
    });
  } else {
    runCli(async () => {
      if (!subcommand || subcommand === "--help" || subcommand === "-h") {
        console.log(helpText());
        if (!subcommand) process.exit(2);
        return;
      }

      if (subcommand === "show") {
        const configPath = consumeValue([...rest], "--config-path") ?? defaultFitCliConfigPath();
        const { config } = loadFitCliConfig(configPath);
        if (!config) {
          console.error(`No config found at ${configPath}`);
          process.exit(1);
        }
        console.log(`Config file: ${configPath}`);
        console.log();
        console.log(formatConfigForDisplay(config));
        console.log();
        const { log } = buildAutoConfig({
          args: {
            auto: false, dryRun: false, suppressArtifacts: false,
            disableAws: false, disableGithub: false, disableGerrit: false, disableCapella: false,
            disableLocalhost: false,
            configPath,
          },
        });
        printResolutionLog(log);
        return;
      }

      if (subcommand !== "edit") {
        console.error(`Unknown subcommand: ${subcommand}\n`);
        console.error(helpText());
        process.exit(2);
      }

      // edit subcommand
      if (rest.includes("--help") || rest.includes("-h")) {
        console.log(helpText());
        return;
      }

      const args = parseEditArgs(rest);

      if (args.auto) {
        await runAutoEdit(args);
      } else {
        await runEditWorkflow(args.configPath);
      }
    });
  }
}

if (isMain(import.meta.url)) {
  runConfigMain();
}
