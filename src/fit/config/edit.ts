import JSON5 from "json5";
import {
  CBDINOCLUSTER_URL,
  CLOUD_INSTANCE_PURPOSES,
  DEFAULT_CLOUD_INSTANCE_TYPES,
  DEFAULT_OUTPUT_FORMAT,
  FIT_CLI_CONFIG_VERSION,
  OUTPUT_FORMATS,
  defaultFitCliConfigPath,
  loadFitCliConfig,
  saveFitCliConfig,
  type CloudInstancePurpose,
  type FitCliAwsConfig,
  type FitCliCapellaConfig,
  type FitCliCloudConfig,
  type FitCliConfig,
  type FitCliInstanceTypes,
  type FitCliLocalhostConfig,
  type FitCliOutputConfig,
  type OutputFormat,
} from "../util/config.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { confirm, input, password, pathInput, select } from "../../util/non-fit/prompts.js";
import { findOnPath } from "../../util/non-fit/which.js";
import { runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import type { AutoInitCliArgs } from "./config.js";
import {
  resolveGerritUserFromGhCli,
  resolveGerritUserFromGitConfig,
} from "../performers/checkout-fit-gerrit-ref/checkout-fit-gerrit-ref.js";

/** The AWS default instance types, keyed by testing purpose. */
const DEFAULT_EC2_INSTANCE_TYPES = DEFAULT_CLOUD_INSTANCE_TYPES.aws;

/** Human-friendly label for a purpose, used in prompts. */
const PURPOSE_LABELS: Record<CloudInstancePurpose, string> = {
  functional: "functional",
  situational: "situational (SIT)",
  perf: "performance (PERF)",
};

/** Env var carrying a per-purpose instance-type override (e.g. FIT_EC2_INSTANCE_TYPE_PERF). */
function purposeEnvVar(purpose: CloudInstancePurpose): string {
  return `FIT_EC2_INSTANCE_TYPE_${purpose.toUpperCase()}`;
}

export type AwsInstanceTypeAnswers = Record<CloudInstancePurpose, string>;

export interface AwsInitAnswers {
  instanceTypes: AwsInstanceTypeAnswers;
}

/** Every Capella field as a (possibly empty) string, ready to write to config. */
export type CapellaInitAnswers = Required<Record<keyof FitCliCapellaConfig, string>>;

export interface InitAnswers {
  configureAws: boolean;
  aws?: AwsInitAnswers;
  /** GitHub username for GHCR image pulls; empty/undefined to skip. */
  githubUser?: string;
  /** GitHub token for cloning the private FIT repos; empty/undefined to skip. */
  githubToken?: string;
  /** Default format generated definition files are written in. */
  outputFormat?: OutputFormat;
  /** Gerrit username; defaults to github.user when blank. */
  gerritUser?: string;
  configureCapella: boolean;
  capella?: CapellaInitAnswers;
  /** Whether the user wants to run FIT tests on this machine (gates the localhost fields). */
  configureLocalhost: boolean;
  /** Local transactions-fit-performer checkout dir for localhost runs; empty/undefined to skip. */
  fitPerformerDir?: string;
  /** Absolute path to the cbdinocluster binary, for non-PATH installs (localhost only). */
  cbdinoclusterPath?: string;
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Fill every purpose, preferring saved values then the baked-in defaults. */
function instanceTypeDefaults(saved?: FitCliInstanceTypes): AwsInstanceTypeAnswers {
  const result = {} as AwsInstanceTypeAnswers;
  for (const purpose of CLOUD_INSTANCE_PURPOSES) {
    result[purpose] = saved?.[purpose] ?? DEFAULT_EC2_INSTANCE_TYPES[purpose];
  }
  return result;
}

export function initDefaultsFromConfig(config?: FitCliConfig): AwsInitAnswers {
  const aws = config?.cloud?.aws;
  return { instanceTypes: instanceTypeDefaults(aws?.instanceTypes) };
}

export function initDefaultsFromEnv(env: NodeJS.ProcessEnv): AwsInitAnswers {
  const instanceTypes = {} as AwsInstanceTypeAnswers;
  for (const purpose of CLOUD_INSTANCE_PURPOSES) {
    instanceTypes[purpose] =
      env[purposeEnvVar(purpose)] ?? env.FIT_EC2_INSTANCE_TYPE ?? DEFAULT_EC2_INSTANCE_TYPES[purpose];
  }
  return { instanceTypes };
}

/** Keep only the purposes with a non-empty value. */
function compactInstanceTypes(types: AwsInstanceTypeAnswers): FitCliInstanceTypes | undefined {
  const parts: FitCliInstanceTypes = {};
  for (const purpose of CLOUD_INSTANCE_PURPOSES) {
    const value = trimOptional(types[purpose]);
    if (value) parts[purpose] = value;
  }
  return Object.keys(parts).length > 0 ? parts : undefined;
}

function awsAnswersToConfig(answers: AwsInitAnswers, existingInstanceTypes?: FitCliInstanceTypes): FitCliAwsConfig | undefined {
  // When instanceTypes is empty the user chose not to configure them — preserve
  // any previously saved values rather than silently wiping them.
  const instanceTypes = compactInstanceTypes(answers.instanceTypes) ?? existingInstanceTypes;
  return instanceTypes ? { instanceTypes } : undefined;
}

/** Capella prompt defaults from a saved config; blank means "no personal override". */
function capellaDefaultsFromConfig(config?: FitCliConfig): CapellaInitAnswers {
  const c = config?.capella;
  return {
    username: c?.username ?? "",
    password: c?.password ?? "",
    apiKey: c?.apiKey ?? "",
    apiSecret: c?.apiSecret ?? "",
  };
}

/** Keep only the Capella fields with a non-empty value. */
function capellaAnswersToConfig(answers: CapellaInitAnswers): FitCliCapellaConfig | undefined {
  const parts: FitCliCapellaConfig = {};
  for (const key of Object.keys(answers) as (keyof CapellaInitAnswers)[]) {
    const value = trimOptional(answers[key]);
    if (value) parts[key] = value;
  }
  return Object.keys(parts).length > 0 ? parts : undefined;
}

export function initAnswersToConfig(answers: InitAnswers, existing?: FitCliConfig): FitCliConfig {
  // Declining the AWS prompt leaves any saved cloud settings untouched rather
  // than wiping them, so re-running edit is non-destructive.
  const aws =
    answers.configureAws && answers.aws
      ? awsAnswersToConfig(answers.aws, existing?.cloud?.aws?.instanceTypes)
      : existing?.cloud?.aws;
  const cloud: FitCliCloudConfig | undefined = aws ? { aws } : undefined;
  // Definition output format lives under `output`. Results-DB credentials are no
  // longer stored in config — they come from AWS Secrets Manager at run time.
  const outputFormat = answers.outputFormat ?? existing?.output?.format;
  const output: FitCliOutputConfig | undefined = outputFormat ? { format: outputFormat } : undefined;

  // Declining the Capella prompt leaves any saved capella settings untouched.
  const capella =
    answers.configureCapella && answers.capella ? capellaAnswersToConfig(answers.capella) : existing?.capella;

  // Declining the localhost prompt leaves any saved localhost settings untouched.
  // github and gerrit creds live under localhost — they are not used for EC2 runs
  // (those always pull from AWS Secrets Manager).
  const localhost = answers.configureLocalhost
    ? buildLocalhostConfig(answers, existing?.localhost)
    : existing?.localhost;

  return {
    version: FIT_CLI_CONFIG_VERSION,
    ...(cloud ? { cloud } : {}),
    ...(output ? { output } : {}),
    ...(capella ? { capella } : {}),
    ...(localhost ? { localhost } : {}),
  };
}

/** Assemble the localhost config from answers, keeping existing values for blanks. */
function buildLocalhostConfig(
  answers: InitAnswers,
  existing?: FitCliLocalhostConfig,
): FitCliLocalhostConfig | undefined {
  const dir = trimOptional(answers.fitPerformerDir) ?? existing?.repos?.["transactions-fit-performer"]?.dir;
  const cbdinoclusterPath = trimOptional(answers.cbdinoclusterPath) ?? existing?.cbdinoclusterPath;
  const repos = dir ? { "transactions-fit-performer": { dir } } : undefined;

  const githubUser = trimOptional(answers.githubUser) ?? existing?.github?.user;
  const githubToken = trimOptional(answers.githubToken) ?? existing?.github?.token;
  const github = githubUser || githubToken
    ? { ...(githubUser ? { user: githubUser } : {}), ...(githubToken ? { token: githubToken } : {}) }
    : undefined;

  const gerritUser = trimOptional(answers.gerritUser);
  const gerrit = gerritUser ? { user: gerritUser } : existing?.gerrit;

  if (!repos && !cbdinoclusterPath && !github && !gerrit) return undefined;
  return {
    ...(repos ? { repos } : {}),
    ...(cbdinoclusterPath ? { cbdinoclusterPath } : {}),
    ...(github ? { github } : {}),
    ...(gerrit ? { gerrit } : {}),
  };
}

function buildInitialDefaults(existing?: FitCliConfig): AwsInitAnswers {
  return existing ? initDefaultsFromConfig(existing) : initDefaultsFromEnv(process.env);
}

async function promptForGithubUser(existing?: FitCliConfig): Promise<string | undefined> {
  const existingUser = existing?.localhost?.github?.user;
  console.log(
    `\nGitHub — used to pull Docker images from GHCR and clone private FIT repos.`,
  );
  const detected = existingUser ?? resolveGerritUserFromGhCli() ?? resolveGerritUserFromGitConfig();
  const entered = await input({
    promptId: "init.github.user",
    message: existingUser
      ? "GitHub username for GHCR image pulls (leave blank to keep the current one):"
      : detected
        ? `GitHub username for GHCR image pulls (detected: ${detected}):`
        : "GitHub username for GHCR image pulls:",
    default: detected ?? "",
  });
  return trimOptional(entered) ?? existingUser;
}

async function promptForGithubToken(existing?: FitCliConfig): Promise<string | undefined> {
  const existingToken = existing?.localhost?.github?.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  console.log(
    "\nA GitHub Personal Access Token (PAT) is a password substitute for API/CLI access." +
    "\nCreate one at https://github.com/settings/tokens — needs read:packages scope (for GHCR) and repo access (for private FIT repos)." +
    `\nCan alternatively use environment variables $GITHUB_TOKEN or $GH_TOKEN.`,
  );
  const entered = await password({
    promptId: "init.github.token",
    message: existingToken
      ? "GitHub PAT (leave blank to keep the current one):"
      : "GitHub PAT (leave blank to skip):",
    mask: "*",
  });
  // A blank entry keeps whatever is already configured, so re-running edit
  // doesn't force the user to retype the token.
  return trimOptional(entered) ?? existingToken;
}

async function promptForGerritUser(existing?: FitCliConfig): Promise<string | undefined> {
  const existingUser = existing?.localhost?.gerrit?.user;
  const githubUser = existing?.localhost?.github?.user;
  const defaultUser = existingUser ?? githubUser;
  console.log("\nGerrit — used to fetch FIT performer code from review.couchbase.org when running against a Gerrit change ref. Set $FIT_GERRIT_USER to avoid storing here.");
  const entered = await input({
    promptId: "init.gerrit.user",
    message: defaultUser
      ? `Gerrit username (leave blank to use "${defaultUser}"):`
      : "Gerrit username (leave blank to use your GitHub username):",
    default: existingUser ?? "",
  });
  return trimOptional(entered) ?? existingUser;
}

async function promptForOutputFormat(existing?: FitCliConfig): Promise<OutputFormat> {
  const current = existing?.output?.format ?? DEFAULT_OUTPUT_FORMAT;
  return select<OutputFormat>({
    promptId: "init.output.format",
    message: "Default format to write generated definition files in:",
    choices: OUTPUT_FORMATS.map((format) => ({ name: format, value: format })),
    default: current,
  });
}

async function promptForCbdinoclusterPath(existing?: FitCliConfig): Promise<string | undefined> {
  const existingPath = existing?.localhost?.cbdinoclusterPath;
  const onPath = findOnPath("cbdinocluster");

  if (onPath) {
    console.log(`  cbdinocluster: found on PATH at ${onPath}`);
  } else {
    console.log(`  cbdinocluster: not found on PATH — get it from: ${CBDINOCLUSTER_URL}`);
  }

  const entered = await pathInput({
    promptId: "init.cbdinocluster.path",
    message: existingPath
      ? `Path to cbdinocluster binary (leave blank to keep "${existingPath}"):`
      : onPath
        ? "cbdinocluster path override (leave blank to use the PATH one):"
        : "Path to cbdinocluster binary (leave blank to skip — required for local cluster runs):",
    default: existingPath ?? "",
  });
  return trimOptional(entered) ?? existingPath;
}

/** Path to the transactions-fit-performer checkout used for localhost runs. */
async function promptForFitPerformerDir(existing?: FitCliConfig): Promise<string | undefined> {
  const existingDir = existing?.localhost?.repos?.["transactions-fit-performer"]?.dir;
  console.log(
    "\ntransactions-fit-performer — fit-cli runs the FIT test-driver from this checkout:" +
      "\non localhost it runs `./mvnw test` in <dir>/test-driver against your SDK + Couchbase and reads" +
      "\nthe JUnit results from there, and checks out a Gerrit patchset there when you pass a gerritRef." +
      "\nNot needed for EC2 runs — the remote box clones it itself.",
  );
  const sibling = resolve(process.cwd(), "..", "transactions-fit-performer");
  const suggested = existingDir ?? (existsSync(sibling) ? sibling : "");
  const entered = await pathInput({
    promptId: "init.localhost.fit-performer-dir",
    message: existingDir
      ? `Path to your transactions-fit-performer checkout (leave blank to keep "${existingDir}"):`
      : suggested
        ? `Path to your transactions-fit-performer checkout (detected: ${suggested}):`
        : "Path to your transactions-fit-performer checkout (leave blank to skip — fit-cli clones it when a localhost run needs it):",
    default: suggested,
  });
  return trimOptional(entered) ?? existingDir;
}

/**
 * The upfront localhost gate: ask whether the user runs FIT on this machine, and
 * if so gather the source checkout, cbdinocluster path, and GitHub/Gerrit creds.
 * EC2-only users skip all of it.
 */
async function promptForLocalhost(existing?: FitCliConfig): Promise<{
  configureLocalhost: boolean;
  githubUser?: string;
  githubToken?: string;
  gerritUser?: string;
  fitPerformerDir?: string;
  cbdinoclusterPath?: string;
}> {
  const hasExisting = existing?.localhost !== undefined;
  const configureLocalhost = await confirm({
    promptId: "init.localhost.configure",
    message: hasExisting
      ? "Edit test settings used to run fit-cli on localhost?"
      : "Do you plan to run FIT tests on this machine (localhost)?",
    default: false,
  });
  if (!configureLocalhost) return { configureLocalhost: false };
  const githubUser = await promptForGithubUser(existing);
  const githubToken = await promptForGithubToken(existing);
  const gerritUser = await promptForGerritUser(existing);
  const fitPerformerDir = await promptForFitPerformerDir(existing);
  const cbdinoclusterPath = await promptForCbdinoclusterPath(existing);
  return {
    configureLocalhost: true,
    ...(githubUser ? { githubUser } : {}),
    ...(githubToken ? { githubToken } : {}),
    ...(gerritUser ? { gerritUser } : {}),
    ...(fitPerformerDir ? { fitPerformerDir } : {}),
    ...(cbdinoclusterPath ? { cbdinoclusterPath } : {}),
  };
}

async function promptForConfig(existing?: FitCliConfig, configPath?: string): Promise<InitAnswers> {
  const { configureLocalhost, githubUser, githubToken, gerritUser, fitPerformerDir, cbdinoclusterPath } =
    await promptForLocalhost(existing);
  const outputFormat = await promptForOutputFormat(existing);
  const defaults = buildInitialDefaults(existing);
  const hasExistingAws = existing?.cloud?.aws !== undefined;
  const configureAws = await confirm({
    promptId: "init.aws.configure",
    message: hasExistingAws
      ? "Edit AWS settings? The defaults are generally fine."
      : "Configure AWS settings? The defaults are generally fine.",
    default: false,
  });

  let aws: AwsInitAnswers | undefined;
  if (configureAws) {
    const configureInstanceTypes = await confirm({
      promptId: "init.aws.configure-instance-types",
      message: "Configure default EC2 instance types? (the defaults are fine for most uses)",
      default: false,
    });
    const instanceTypes = configureInstanceTypes
      ? await promptForInstanceTypes(defaults.instanceTypes)
      : ({} as AwsInstanceTypeAnswers);
    aws = { instanceTypes };
  }

  const { configureCapella, capella } = await promptForCapella(existing, configPath);

  return {
    configureAws,
    ...(aws ? { aws } : {}),
    githubUser,
    githubToken,
    outputFormat,
    gerritUser,
    configureCapella,
    ...(capella ? { capella } : {}),
    configureLocalhost,
    ...(fitPerformerDir ? { fitPerformerDir } : {}),
    ...(cbdinoclusterPath ? { cbdinoclusterPath } : {}),
  };
}

/**
 * Ask whether to configure Capella (situational/SIT only), and if so, the
 * personal username/password and v4 organization API key/secret overrides.
 */
async function promptForCapella(
  existing?: FitCliConfig,
  configPath?: string,
): Promise<{ configureCapella: boolean; capella?: CapellaInitAnswers }> {
  const hasExisting = existing?.capella !== undefined;
  const configureCapella = await confirm({
    promptId: "init.capella.configure",
    message: hasExisting
      ? "Edit Capella settings? Optional: only used for situational (FIT/SIT) runs, and only to login with a custom Capella user."
      : "Configure Capella settings? Optional: only used for situational (FIT/SIT) runs, and only to login with a custom Capella user.",
    default: false,
  });
  if (!configureCapella) {
    return { configureCapella: false };
  }

  // Only your PERSONAL credentials are stored; the endpoint/org id are per-environment
  // and come from environments.json5 (selected by the definition's capellaEnvironment).
  const defaults = capellaDefaultsFromConfig(existing);
  const username = await input({
    promptId: "init.capella.username",
    message: defaults.username
        ? `Capella username (leave blank to keep "${defaults.username}"):`
        : "Capella username (usually your Couchbase email for the dev Capella environment):",
    default: defaults.username,
  });

  console.warn(
    `\nWarning: Capella secrets will be saved in plaintext in ${configPath ?? "~/.fit-cli/config.json5"}.\n` +
    `Set CAPELLA_PASS / CAPELLA_API_SECRET in your environment to avoid storing them on disk.\n`,
  );
  const capellaPassword = await password({
    promptId: "init.capella.password",
    message: defaults.password
      ? "Capella password (leave blank to keep the current one):"
      : "Capella password (leave blank to skip — set CAPELLA_PASS env var instead):",
    mask: "*",
  });

  const apiKey = await password({
    promptId: "init.capella.api-key",
    message: defaults.apiKey
      ? "Capella v4 organization API key (leave blank to keep the current one):"
      : "Capella v4 organization API key (leave blank to use the shared one from AWS Secrets Manager):",
    mask: "*",
  });
  const apiSecret = await password({
    promptId: "init.capella.api-secret",
    message: defaults.apiSecret
      ? "Capella v4 organization API secret (leave blank to keep the current one):"
      : "Capella v4 organization API secret (leave blank to skip; set CAPELLA_API_SECRET env var instead):",
    mask: "*",
  });

  return {
    configureCapella: true,
    capella: {
      username,
      password: trimOptional(capellaPassword) ?? defaults.password,
      apiKey: trimOptional(apiKey) ?? defaults.apiKey,
      apiSecret: trimOptional(apiSecret) ?? defaults.apiSecret,
    },
  };
}

/** Ask for a default EC2 instance type per testing purpose. */
async function promptForInstanceTypes(defaults: AwsInstanceTypeAnswers): Promise<AwsInstanceTypeAnswers> {
  const answers = {} as AwsInstanceTypeAnswers;
  for (const purpose of CLOUD_INSTANCE_PURPOSES) {
    answers[purpose] = await input({
      promptId: `init.aws.instance-type.${purpose}`,
      message: `Default EC2 instance type for ${PURPOSE_LABELS[purpose]} tests:`,
      default: defaults[purpose],
    });
  }
  return answers;
}

/** Placeholder shown in place of secrets when echoing the config. */
const ELIDED = "********";

/**
 * Render the config as JSON5 with secrets (the GitHub token and results-DB
 * password) elided, so the saved config can be echoed to the terminal without
 * leaking credentials into scrollback or session logs.
 */
export function formatConfigForDisplay(config: FitCliConfig): string {
  const localhostGithub = config.localhost?.github;
  const redacted: FitCliConfig = {
    ...config,
    ...(config.localhost
      ? {
          localhost: {
            ...config.localhost,
            ...(localhostGithub
              ? { github: { ...localhostGithub, ...(localhostGithub.token ? { token: ELIDED } : {}) } }
              : {}),
          },
        }
      : {}),
    ...(config.capella
      ? {
          capella: {
            ...config.capella,
            ...(config.capella.password ? { password: ELIDED } : {}),
            ...(config.capella.apiSecret ? { apiSecret: ELIDED } : {}),
          },
        }
      : {}),
  };
  return JSON5.stringify(redacted, null, 2).trimEnd();
}

export async function runEditWorkflow(path: string = defaultFitCliConfigPath()): Promise<string> {
  const existing = loadFitCliConfig(path);
  const answers = await promptForConfig(existing.config, existing.path);
  const config = initAnswersToConfig(answers, existing.config);
  const savedPath = saveFitCliConfig(config, existing.path);
  console.log(`Saved fit-cli config to ${savedPath}`);
  console.log(`\nConfig (secrets elided):\n\n${formatConfigForDisplay(config)}\n`);
  console.log(`Next steps:\n  ${runScriptPrefix("wizard")}   # interactive walkthrough\n  ${runScriptPrefix("help")}     # all commands`);
  return savedPath;
}

// ─── Auto (non-interactive) edit ────────────────────────────────────────────

/**
 * Describes a single resolution attempt: where we looked and what we found.
 */
export interface ResolutionEntry {
  field: string;
  source: string;
  found: boolean;
  value?: string;
  /** If true, this entry is a diagnostic-only env check — not written to config. */
  diagnosticOnly?: boolean;
}

export interface AutoInitOptions {
  args: AutoInitCliArgs;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve a config field from CLI arg → env var(s) → default. Records each
 * source checked into `log` for display.
 */
function resolveField(
  log: ResolutionEntry[],
  field: string,
  cliValue: string | undefined,
  cliLabel: string,
  envVars: { name: string; value: string | undefined }[],
  fallback?: string,
): string | undefined {
  // CLI arg
  if (cliValue !== undefined) {
    log.push({ field, source: cliLabel, found: true, value: cliValue });
    return cliValue;
  }
  log.push({ field, source: cliLabel, found: false });

  // Env vars
  for (const { name, value } of envVars) {
    if (value !== undefined && value !== "") {
      log.push({ field, source: `$${name}`, found: true, value });
      return value;
    }
    log.push({ field, source: `$${name}`, found: false });
  }

  // Default
  if (fallback !== undefined) {
    log.push({ field, source: "default", found: true, value: fallback });
    return fallback;
  }
  log.push({ field, source: "(none)", found: false });
  return undefined;
}

/** Mask a secret value for display. */
function mask(value: string | undefined): string {
  if (!value) return "";
  if (value.length <= 4) return "****";
  return value.slice(0, 4) + "****";
}

const SECRET_FIELDS = new Set([
  "github.token",
  "capella.password",
  "capella.apiKey",
  "capella.apiSecret",
]);

/** Check whether a diagnostic-only env var is present, appending an entry to the log. */
function checkDiagnosticVar(log: ResolutionEntry[], envName: string, value: string | undefined): void {
  const found = value !== undefined && value !== "";
  log.push({ field: `$${envName}`, source: `$${envName}`, found, ...(found ? { value } : {}), diagnosticOnly: true });
}

/**
 * Print the resolution log as a compact table: one row per config field with
 * one cell per source checked (CLI arg, env vars, default), plus a separate
 * diagnostic section for env-only checks that are not written to the config.
 */
export function printResolutionLog(log: ResolutionEntry[]): void {
  console.log("\nConfiguration resolution:\n");

  const regularEntries = log.filter((e) => !e.diagnosticOnly);
  const diagnosticEntries = log.filter((e) => e.diagnosticOnly);

  // Group regular entries by field, preserving insertion order
  const fieldGroups = new Map<string, ResolutionEntry[]>();
  for (const entry of regularEntries) {
    if (!fieldGroups.has(entry.field)) fieldGroups.set(entry.field, []);
    fieldGroups.get(entry.field)!.push(entry);
  }

  // One column per source position; width = longest source name at that position + 2 (for "✓ " / "· ")
  const maxSources = Math.max(...[...fieldGroups.values()].map((g) => g.length), 0);
  const srcWidths: number[] = [];
  for (let i = 0; i < maxSources; i++) {
    let w = 0;
    for (const group of fieldGroups.values()) {
      if (i < group.length) w = Math.max(w, group[i].source.length + 2);
    }
    srcWidths.push(w);
  }

  const fieldWidth = Math.max(...[...fieldGroups.keys()].map((k) => k.length), 5);
  const srcTotalWidth = srcWidths.length > 0 ? srcWidths.reduce((s, w) => s + w + 2, 0) - 2 : 0;
  const col = (s: string, w: number) => s.padEnd(w);

  console.log(`  ${col("Field", fieldWidth)}  ${col("Sources", srcTotalWidth)}  Value`);
  console.log(`  ${"─".repeat(fieldWidth)}  ${"─".repeat(srcTotalWidth)}  ${"─".repeat(20)}`);

  for (const [field, entries] of fieldGroups) {
    const cells = entries.map((e, i) => col(`${e.found ? "✓" : "·"} ${e.source}`, srcWidths[i]));
    for (let i = entries.length; i < maxSources; i++) cells.push(col("", srcWidths[i]));

    const resolved = entries.find((e) => e.found);
    const finalValue = resolved
      ? SECRET_FIELDS.has(field) ? mask(resolved.value) : (resolved.value ?? "")
      : "";

    console.log(`  ${col(field, fieldWidth)}  ${cells.join("  ")}  ${finalValue}`);
  }

  if (diagnosticEntries.length > 0) {
    const diagLabel = "─── env-only (not saved to config) ";
    const diagWidth = Math.max(...diagnosticEntries.map((e) => e.source.length));
    const divWidth = fieldWidth + 2 + srcTotalWidth + 2 + 20;
    console.log();
    console.log(`  ${diagLabel}${"─".repeat(Math.max(0, divWidth - diagLabel.length))}`);
    for (const entry of diagnosticEntries) {
      const marker = entry.found ? "~" : "✗";
      const displayValue = entry.found ? mask(entry.value) : "";
      console.log(`  ${col(entry.source, diagWidth)}  ${marker}  ${displayValue}`);
    }
  }

  console.log();
}

/**
 * Build a FitCliConfig from CLI args and env vars without any prompts.
 * Returns the config and the resolution log.
 */
export function buildAutoConfig(
  options: AutoInitOptions,
): { config: FitCliConfig; log: ResolutionEntry[] } {
  const { args, env = process.env } = options;
  const log: ResolutionEntry[] = [];

  // Cloud (AWS) section
  let cloud: FitCliCloudConfig | undefined;
  if (!args.disableAws) {
    const instanceTypes: FitCliInstanceTypes = {};
    for (const purpose of CLOUD_INSTANCE_PURPOSES) {
      const type = resolveField(
        log,
        `cloud.aws.instanceTypes.${purpose}`,
        args.awsInstanceTypes?.[purpose],
        `--aws-instance-type-${purpose}`,
        [
          { name: purposeEnvVar(purpose), value: env[purposeEnvVar(purpose)] },
          { name: "FIT_EC2_INSTANCE_TYPE", value: env.FIT_EC2_INSTANCE_TYPE },
        ],
        DEFAULT_EC2_INSTANCE_TYPES[purpose],
      );
      if (type) instanceTypes[purpose] = type;
    }

    const parts: FitCliAwsConfig = {
      ...(Object.keys(instanceTypes).length > 0 ? { instanceTypes } : {}),
    };
    if (Object.keys(parts).length > 0) cloud = { aws: parts };

    // Diagnostic: AWS credentials (must be set in env; not written to config)
    checkDiagnosticVar(log, "AWS_ACCESS_KEY_ID", env.AWS_ACCESS_KEY_ID);
    checkDiagnosticVar(log, "AWS_SECRET_ACCESS_KEY", env.AWS_SECRET_ACCESS_KEY);
    checkDiagnosticVar(log, "AWS_SESSION_TOKEN", env.AWS_SESSION_TOKEN);
  } else {
    log.push({ field: "cloud.aws.*", source: "--disable-aws", found: false });
  }

  // Output section: default definition format. Results-DB credentials come from
  // AWS Secrets Manager now (keyed by the definition's resultsEnvironment), not config.
  const formatValue = resolveField(log, "output.format", args.outputFormat, "--output-format", [
    { name: "FIT_OUTPUT_FORMAT", value: env.FIT_OUTPUT_FORMAT },
  ]);
  const format =
    formatValue && (OUTPUT_FORMATS as readonly string[]).includes(formatValue)
      ? (formatValue as OutputFormat)
      : undefined;
  const output: FitCliOutputConfig | undefined = format ? { format } : undefined;

  // Capella section: PERSONAL credentials only (username/password and the v4
  // organization API key/secret). The endpoints and org id are per-environment and
  // come from environments.json5 at run time. With neither a username nor an API
  // key there is nothing personal to store, so we skip the section.
  let capella: FitCliConfig["capella"] | undefined;
  if (args.disableCapella) {
    log.push({ field: "capella.*", source: "--disable-capella", found: false });
  } else {
    const username = resolveField(log, "capella.username", args.capellaUsername, "--capella-username", [
      { name: "CAPELLA_USER", value: env.CAPELLA_USER },
      { name: "CAP_USER", value: env.CAP_USER },
    ]);
    const apiKey = resolveField(log, "capella.apiKey", args.capellaApiKey, "--capella-api-key", [
      { name: "CAPELLA_API_KEY", value: env.CAPELLA_API_KEY },
    ]);
    if (!username && !apiKey) {
      log.push({ field: "capella.*", source: "(no username or API key)", found: false });
    } else {
      const capellaPassword = resolveField(log, "capella.password", args.capellaPassword, "--capella-password", [
        { name: "CAPELLA_PASS", value: env.CAPELLA_PASS },
        { name: "CAP_PASS", value: env.CAP_PASS },
      ]);
      const apiSecret = resolveField(log, "capella.apiSecret", args.capellaApiSecret, "--capella-api-secret", [
        { name: "CAPELLA_API_SECRET", value: env.CAPELLA_API_SECRET },
      ]);

      capella = {
        ...(username ? { username } : {}),
        ...(capellaPassword ? { password: capellaPassword } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(apiSecret ? { apiSecret } : {}),
      };
    }
  }

  // Localhost section: source checkout, cbdinocluster path, and GitHub/Gerrit creds
  // for running on this machine. EC2 runs pull creds from AWS Secrets Manager instead.
  let localhost: FitCliConfig["localhost"] | undefined;
  if (args.disableLocalhost) {
    log.push({ field: "localhost.*", source: "--disable-localhost", found: false });
  } else {
    const fitPerformerDir = resolveField(
      log,
      "localhost.repos.transactions-fit-performer.dir",
      args.fitPerformerDir,
      "--fit-performer-dir",
      [{ name: "FIT_PERFORMER_DIR", value: env.FIT_PERFORMER_DIR }],
    );
    const cbdinoclusterPath = resolveField(log, "localhost.cbdinoclusterPath", args.cbdinoclusterPath, "--cbdinocluster-path", [
      { name: "CBDINOCLUSTER_PATH", value: env.CBDINOCLUSTER_PATH },
    ]);

    let github: FitCliLocalhostConfig["github"] | undefined;
    if (!args.disableGithub) {
      const user = resolveField(log, "localhost.github.user", args.githubUser, "--github-user", [
        { name: "GITHUB_USER", value: env.GITHUB_USER },
      ], resolveGerritUserFromGhCli(env) ?? resolveGerritUserFromGitConfig(env));
      const token = resolveField(log, "localhost.github.token", args.githubToken, "--github-token", [
        { name: "GITHUB_TOKEN", value: env.GITHUB_TOKEN },
        { name: "GH_TOKEN", value: env.GH_TOKEN },
      ]);
      const parts = { ...(user ? { user } : {}), ...(token ? { token } : {}) };
      if (Object.keys(parts).length > 0) github = parts;
    } else {
      log.push({ field: "localhost.github.*", source: "--disable-github", found: false });
    }

    // Gerrit: only the username is stored in config; the SSH key is auto-discovered
    // from env vars or ~/.ssh/ at runtime (with an AWS Secrets Manager fallback for
    // clean EC2 instances).
    let gerrit: FitCliLocalhostConfig["gerrit"] | undefined;
    if (!args.disableGerrit) {
      const user = resolveField(log, "localhost.gerrit.user", args.gerritUser, "--gerrit-user", [
        { name: "FIT_GERRIT_USER", value: env.FIT_GERRIT_USER },
        { name: "GERRIT_USER", value: env.GERRIT_USER },
      ]);
      if (user) gerrit = { user };
    } else {
      log.push({ field: "localhost.gerrit.*", source: "--disable-gerrit", found: false });
    }

    const parts: FitCliConfig["localhost"] = {
      ...(fitPerformerDir ? { repos: { "transactions-fit-performer": { dir: fitPerformerDir } } } : {}),
      ...(cbdinoclusterPath ? { cbdinoclusterPath } : {}),
      ...(github ? { github } : {}),
      ...(gerrit ? { gerrit } : {}),
    };
    if (Object.keys(parts).length > 0) localhost = parts;
  }

  const config: FitCliConfig = {
    version: FIT_CLI_CONFIG_VERSION,
    ...(cloud ? { cloud } : {}),
    ...(output ? { output } : {}),
    ...(capella ? { capella } : {}),
    ...(localhost ? { localhost } : {}),
  };

  return { config, log };
}

/**
 * Run the non-interactive auto-edit flow: resolve config, display resolution
 * table, and write the config file (unless --dry-run).
 */
export function runAutoEdit(args: AutoInitCliArgs): Promise<void> {
  const { config, log } = buildAutoConfig({ args, env: process.env });

  printResolutionLog(log);

  console.log("Config (secrets elided):\n");
  console.log(formatConfigForDisplay(config));
  console.log();

  if (args.dryRun) {
    console.log(`[dry-run] Would write to: ${args.configPath}`);
    console.log("[dry-run] No changes made.");
    return Promise.resolve();
  }

  const savedPath = saveFitCliConfig(config, args.configPath);
  console.log(`Saved fit-cli config to ${savedPath}`);
  return Promise.resolve();
}
