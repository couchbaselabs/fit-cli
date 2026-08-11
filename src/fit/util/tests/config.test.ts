import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_CLOUD_INSTANCE_TYPES,
  FIT_CLI_CONFIG_VERSION,
  UnsupportedFitCliConfigVersionError,
  applyFitCliConfigToEnv,
  capellaLogCollectionAvailable,
  ensureFitCliConfigEnv,
  loadFitCliConfig,
  parseFitCliConfig,
  resolveCapellaConfig,
  resolveCloudInstanceType,
  resolveFitPerformerDir,
  resolveGithubToken,
  resolveResultsDbCredentials,
  resolveRosaCredentials,
  saveFitCliConfig,
  type FitCliConfig,
} from "../config.js";

test("parses a version 1 fit-cli config (JSON5)", () => {
  const parsed = parseFitCliConfig(`{
  version: 1,
  cloud: {
    aws: {
      region: 'us-east-1',
      instanceTypes: {
        functional: 'c5.xlarge',
        situational: 'c5.2xlarge',
        perf: 'c5.4xlarge',
      },
    },
  },
}`);

  assert.deepEqual(parsed, {
    version: FIT_CLI_CONFIG_VERSION,
    cloud: {
      aws: {
        instanceTypes: {
          functional: "c5.xlarge",
          situational: "c5.2xlarge",
          perf: "c5.4xlarge",
        },
      },
    },
  });
});

test("parses cloud.gcp instance types", () => {
  const parsed = parseFitCliConfig(`{
  version: 1,
  cloud: {
    gcp: {
      instanceTypes: {
        functional: 'n2-standard-4',
      },
    },
  },
}`);

  assert.deepEqual(parsed, {
    version: FIT_CLI_CONFIG_VERSION,
    cloud: {
      gcp: {
        instanceTypes: { functional: "n2-standard-4" },
      },
    },
  });
});

test("parses a version 1 fit-cli config (YAML, backward compat)", () => {
  const parsed = parseFitCliConfig(
    `version: 1\ncloud:\n  aws:\n    region: us-east-1\n    instanceTypes:\n      perf: c5.4xlarge\n`,
    "yaml",
  );

  // Legacy `region` and `profile` keys are silently ignored.
  assert.deepEqual(parsed, {
    version: FIT_CLI_CONFIG_VERSION,
    cloud: {
      aws: {
        instanceTypes: { perf: "c5.4xlarge" },
      },
    },
  });
});

test("ignores legacy stored AWS credentials, region, and profile in config", () => {
  const parsed = parseFitCliConfig(`{
  version: 1,
  cloud: {
    aws: {
      accessKeyId: 'abc',
      secretAccessKey: 'def',
      region: 'us-east-1',
      profile: 'dev',
    },
  },
}`);

  assert.deepEqual(parsed, { version: FIT_CLI_CONFIG_VERSION });
});

test("parses a stored GitHub token (new localhost.github location)", () => {
  const parsed = parseFitCliConfig(`{ version: 1, localhost: { github: { token: 'ghp_example' } } }`);

  assert.deepEqual(parsed, {
    version: FIT_CLI_CONFIG_VERSION,
    localhost: { github: { token: "ghp_example" } },
  });
});

test("parses a legacy top-level github token and folds it into localhost", () => {
  const parsed = parseFitCliConfig(`{ version: 1, github: { token: 'ghp_legacy' } }`);

  assert.deepEqual(parsed, {
    version: FIT_CLI_CONFIG_VERSION,
    localhost: { github: { token: "ghp_legacy" } },
  });
});

const noFetchSecret = (): Promise<Record<string, string>> => Promise.reject(new Error("should not fetch AWS secret"));

test("resolveGithubToken prefers the config token over the environment", async () => {
  const token = await resolveGithubToken({
    config: { version: FIT_CLI_CONFIG_VERSION, localhost: { github: { token: "from-config" } } },
    env: { GITHUB_TOKEN: "from-env" },
    fetchSecret: noFetchSecret,
  });
  assert.equal(token, "from-config");
});

test("resolveGithubToken falls back to GITHUB_TOKEN then GH_TOKEN", async () => {
  assert.equal(
    await resolveGithubToken({
      config: { version: FIT_CLI_CONFIG_VERSION },
      env: { GITHUB_TOKEN: "gh-token" },
      fetchSecret: noFetchSecret,
    }),
    "gh-token",
  );
  assert.equal(
    await resolveGithubToken({
      config: { version: FIT_CLI_CONFIG_VERSION },
      env: { GH_TOKEN: "fallback" },
      fetchSecret: noFetchSecret,
    }),
    "fallback",
  );
});

test("resolveFitPerformerDir prefers FIT_PERFORMER_DIR env var over config", () => {
  assert.equal(
    resolveFitPerformerDir({
      config: { version: FIT_CLI_CONFIG_VERSION, localhost: { repos: { "transactions-fit-performer": { dir: "/from/config" } } } },
      env: { FIT_PERFORMER_DIR: "/from/env" },
    }),
    "/from/env",
  );
});

test("resolveFitPerformerDir falls back to config when FIT_PERFORMER_DIR is unset", () => {
  assert.equal(
    resolveFitPerformerDir({
      config: { version: FIT_CLI_CONFIG_VERSION, localhost: { repos: { "transactions-fit-performer": { dir: "/from/config" } } } },
      env: {},
    }),
    "/from/config",
  );
});

test("resolveFitPerformerDir returns undefined when neither is set", () => {
  assert.equal(resolveFitPerformerDir({ config: { version: FIT_CLI_CONFIG_VERSION }, env: {} }), undefined);
});

test("resolveGithubToken falls back to AWS secret when no local config or env", async () => {
  assert.equal(
    await resolveGithubToken({
      config: { version: FIT_CLI_CONFIG_VERSION },
      env: {},
      fetchSecret: () => Promise.resolve({ token: "aws-pat", user: "aws-user" }),
    }),
    "aws-pat",
  );
  assert.equal(
    await resolveGithubToken({
      config: { version: FIT_CLI_CONFIG_VERSION },
      env: {},
      fetchSecret: noFetchSecret,
    }),
    undefined,
  );
});

const STUB_DEFAULTS = {
  clusterVersion: "8.0-stable",
  previousClusterVersion: "7.6-stable",
  cngClusterVersion: "8.0.2-5503",
  enterpriseAnalyticsVersion: "2.2.0-1166",
  caoOperatorVersion: "2.9.2",
  cngVersion: "1.1.0-135",
  capellaClusterVersion: "8.0",
  capellaPreviousClusterVersion: "7.6",
  defaultCapellaEnvironment: "dev",
  defaultResultsEnvironment: "dev",
  aws: { region: "us-west-2", vpcId: "vpc-stub", subnetId: "subnet-stub" },
};

const STUB_TEST_SETS = {
  SITUATIONAL_SET_SANITY: "com.couchbase.situational.tests.SanityTest",
  SITUATIONAL_CNG_SET_SANITY: "com.couchbase.situational.tests.CngTest#rebalance3To4NodesDuringMixedKv",
  SITUATIONAL_SET_LITE: "standard-qe",
  SITUATIONAL_SET_RELEASE: "standard-qe",
  FUNCTIONAL_SET_SANITY: "com.couchbase.client.kv.SanityTest",
  FUNCTIONAL_SET_LITE: "all",
  FUNCTIONAL_SET_RELEASE: "all",
};

const TEST_ENVIRONMENTS = {
  defaults: STUB_DEFAULTS,
  testSets: STUB_TEST_SETS,
  capella: {
    dev: {
      endpoint: "https://dev.example",
      v4Endpoint: "https://cloudapi.dev.example",
      oid: "oid-dev",
      username: "sdk_qe@couchbase.com",
      secretId: "cap/dev",
    },
  },
  results: {
    dev: { host: "dev.db.example", secretId: "res/dev" },
    prod: { host: "prod.db.example", username: "results_writer", secretId: "res/prod" },
  },
  awsTenants: { "cb-sdk": { accountId: "958525475024" } },
  fitCliRole: { accountId: "958525475024", roleName: "fit-cli-role" },
};
const noFetch = (): Promise<Record<string, string>> => Promise.reject(new Error("should not fetch the AWS secret"));

test("ignores results-database credentials in config (now resolved from AWS Secrets Manager)", () => {
  assert.deepEqual(parseFitCliConfig(`{ version: 1, output: { resultsDb: { password: 's' } } }`), {
    version: FIT_CLI_CONFIG_VERSION,
  });
  assert.deepEqual(parseFitCliConfig(`{ version: 1, resultsDb: { password: 's' } }`), {
    version: FIT_CLI_CONFIG_VERSION,
  });
});

test("parses the default output format", () => {
  const parsed = parseFitCliConfig(`{ version: 1, output: { format: 'yaml' } }`);
  assert.deepEqual(parsed, { version: FIT_CLI_CONFIG_VERSION, output: { format: "yaml" } });
});

test("rejects an invalid output format", () => {
  assert.throws(() => parseFitCliConfig(`{ version: 1, output: { format: 'toml' } }`), /output\.format/);
});

test("resolveResultsDbCredentials takes the host from the registry and the password from the secret", async () => {
  const creds = await resolveResultsDbCredentials({
    block: "dev",
    environments: TEST_ENVIRONMENTS,
    fetchSecret: () => Promise.resolve({ password: "s3cret" }),
  });
  assert.deepEqual(creds, { host: "dev.db.example", username: "postgres", password: "s3cret" });
});

test("resolveResultsDbCredentials takes the username from the registry when the secret has none", async () => {
  const creds = await resolveResultsDbCredentials({
    block: "prod",
    environments: TEST_ENVIRONMENTS,
    fetchSecret: () => Promise.resolve({ password: "s3cret" }),
  });
  assert.deepEqual(creds, { host: "prod.db.example", username: "results_writer", password: "s3cret" });
});

test("resolveResultsDbCredentials lets the secret's username override the registry", async () => {
  const creds = await resolveResultsDbCredentials({
    block: "prod",
    environments: TEST_ENVIRONMENTS,
    fetchSecret: () => Promise.resolve({ password: "p", username: "emergency_role" }),
  });
  assert.equal(creds.username, "emergency_role");
});

test("resolveResultsDbCredentials uses the secret's username when present", async () => {
  const creds = await resolveResultsDbCredentials({
    block: "dev",
    environments: TEST_ENVIRONMENTS,
    fetchSecret: () => Promise.resolve({ password: "p", username: "readonly" }),
  });
  assert.equal(creds.username, "readonly");
});

test("resolveResultsDbCredentials rejects an unknown results environment", async () => {
  await assert.rejects(
    resolveResultsDbCredentials({ block: "nope", environments: TEST_ENVIRONMENTS, fetchSecret: noFetch }),
    /Unknown results environment "nope"/,
  );
});

test("resolveRosaCredentials reads url + password from the secret, defaulting the username", async () => {
  const creds = await resolveRosaCredentials({
    fetchSecret: () => Promise.resolve({ url: "https://api.rosa.example:6443", password: "pw" }),
  });
  assert.deepEqual(creds, { url: "https://api.rosa.example:6443", username: "cluster-admin", password: "pw" });
});

test("resolveRosaCredentials uses the secret's username when present", async () => {
  const creds = await resolveRosaCredentials({
    fetchSecret: () => Promise.resolve({ url: "https://api.rosa.example:6443", password: "pw", username: "kubeadmin" }),
  });
  assert.equal(typeof creds === "string" ? creds : creds.username, "kubeadmin");
});

test("resolveRosaCredentials returns an error string when fields are missing", async () => {
  const result = await resolveRosaCredentials({
    fetchSecret: () => Promise.resolve({ url: "https://api.rosa.example:6443" }),
  });
  assert.equal(typeof result, "string");
  assert.match(result as string, /missing password/);
});

test("resolveRosaCredentials returns an error string when the secret can't be read", async () => {
  const result = await resolveRosaCredentials({
    fetchSecret: () => Promise.reject(new Error("access denied")),
  });
  assert.equal(typeof result, "string");
  assert.match(result as string, /Could not read the ROSA credentials/);
});

test("parses a stored capella section (personal credentials only)", () => {
  const parsed = parseFitCliConfig(
    `{ version: 1, capella: { username: "graham.pople@couchbase.com", password: "pw", apiKey: "key", apiSecret: "sec" } }`,
  );
  assert.deepEqual(parsed.capella, {
    username: "graham.pople@couchbase.com",
    password: "pw",
    apiKey: "key",
    apiSecret: "sec",
  });
});

test("resolveCapellaConfig prefers personal config credentials, with registry endpoints/oid", async () => {
  const resolved = await resolveCapellaConfig({
    block: "dev",
    environments: TEST_ENVIRONMENTS,
    config: {
      version: FIT_CLI_CONFIG_VERSION,
      capella: { username: "me@cb.com", password: "pw", apiKey: "my-key", apiSecret: "my-secret" },
    },
    env: {},
    fetchSecret: noFetch,
  });
  assert.deepEqual(resolved, {
    username: "me@cb.com",
    password: "pw",
    endpoint: "https://dev.example",
    v4Endpoint: "https://cloudapi.dev.example",
    organizationId: "oid-dev",
    apiKey: "my-key",
    apiSecret: "my-secret",
  });
});

test("resolveCapellaConfig prefers CAPELLA_*/CAP_* env over the shared account", async () => {
  const resolved = await resolveCapellaConfig({
    block: "dev",
    environments: TEST_ENVIRONMENTS,
    config: { version: FIT_CLI_CONFIG_VERSION },
    env: { CAPELLA_USER: "envuser", CAPELLA_PASS: "envpass", CAPELLA_API_KEY: "envkey", CAPELLA_API_SECRET: "envsec" },
    fetchSecret: noFetch,
  });
  assert.equal(resolved.username, "envuser");
  assert.equal(resolved.password, "envpass");
  assert.equal(resolved.apiKey, "envkey");
  assert.equal(resolved.apiSecret, "envsec");
  assert.equal(resolved.endpoint, "https://dev.example");
  assert.equal(resolved.v4Endpoint, "https://cloudapi.dev.example");
});

test("resolveCapellaConfig uses the shared registry username + the secret's credentials when no personal creds", async () => {
  const resolved = await resolveCapellaConfig({
    block: "dev",
    environments: TEST_ENVIRONMENTS,
    config: { version: FIT_CLI_CONFIG_VERSION },
    env: {},
    fetchSecret: () => Promise.resolve({ password: "svc-pw", apiKey: "svc-key", apiSecret: "svc-sec" }),
  });
  assert.equal(resolved.username, "sdk_qe@couchbase.com"); // from environments.json5, not the secret
  assert.equal(resolved.password, "svc-pw");
  assert.equal(resolved.apiKey, "svc-key");
  assert.equal(resolved.apiSecret, "svc-sec");
});

test("resolveCapellaConfig keeps personal values and fills the rest from the secret", async () => {
  const resolved = await resolveCapellaConfig({
    block: "dev",
    environments: TEST_ENVIRONMENTS,
    config: { version: FIT_CLI_CONFIG_VERSION, capella: { password: "my-pw" } },
    env: {},
    fetchSecret: () => Promise.resolve({ password: "svc-pw", apiKey: "svc-key", apiSecret: "svc-sec" }),
  });
  assert.equal(resolved.username, "sdk_qe@couchbase.com");
  assert.equal(resolved.password, "my-pw");
  assert.equal(resolved.apiKey, "svc-key");
  assert.equal(resolved.apiSecret, "svc-sec");
});

test("resolveCapellaConfig throws when the secret has no v4 API key", async () => {
  await assert.rejects(
    resolveCapellaConfig({
      block: "dev",
      environments: TEST_ENVIRONMENTS,
      config: { version: FIT_CLI_CONFIG_VERSION },
      env: {},
      fetchSecret: () => Promise.resolve({ password: "svc-pw" }),
    }),
    /Could not resolve Capella apiKey, apiSecret/,
  );
});

test("resolveCapellaConfig picks up internalSupportToken/overrideToken from the shared secret", async () => {
  const resolved = await resolveCapellaConfig({
    block: "dev",
    environments: TEST_ENVIRONMENTS,
    config: { version: FIT_CLI_CONFIG_VERSION },
    env: {},
    fetchSecret: () =>
      Promise.resolve({
        password: "svc-pw",
        apiKey: "svc-key",
        apiSecret: "svc-sec",
        internalSupportToken: "support-tok",
        overrideToken: "override-tok",
      }),
  });
  assert.equal(resolved.internalSupportToken, "support-tok");
  assert.equal(resolved.overrideToken, "override-tok");
});

test("resolveCapellaConfig omits internalSupportToken/overrideToken and never touches AWS when personal creds are set", async () => {
  const resolved = await resolveCapellaConfig({
    block: "dev",
    environments: TEST_ENVIRONMENTS,
    config: {
      version: FIT_CLI_CONFIG_VERSION,
      capella: { username: "me@cb.com", password: "pw", apiKey: "my-key", apiSecret: "my-sec" },
    },
    env: {},
    fetchSecret: noFetch,
  });
  assert.equal(resolved.internalSupportToken, undefined);
  assert.equal(resolved.overrideToken, undefined);
});

test("capellaLogCollectionAvailable is true from just internalSupportToken", async () => {
  const available = await capellaLogCollectionAvailable("dev", {
    environments: TEST_ENVIRONMENTS,
    env: {},
    fetchSecret: () => Promise.resolve({ internalSupportToken: "support-tok" }),
  });
  assert.equal(available, true);
});

test("capellaLogCollectionAvailable is false when the secret has no internalSupportToken", async () => {
  const available = await capellaLogCollectionAvailable("dev", {
    environments: TEST_ENVIRONMENTS,
    env: {},
    fetchSecret: () => Promise.resolve({ password: "svc-pw" }),
  });
  assert.equal(available, false);
});

test("capellaLogCollectionAvailable is false for an environment with no secretId at all", async () => {
  const available = await capellaLogCollectionAvailable("prod", {
    environments: {
      ...TEST_ENVIRONMENTS,
      capella: { ...TEST_ENVIRONMENTS.capella, prod: { endpoint: "https://prod.example", oid: "oid-prod" } },
    },
    env: {},
    fetchSecret: noFetch,
  });
  assert.equal(available, false);
});

test("resolveCapellaConfig throws for an unprovisioned environment", async () => {
  await assert.rejects(
    resolveCapellaConfig({
      block: "stage",
      environments: {
        defaults: STUB_DEFAULTS,
        testSets: STUB_TEST_SETS,
        capella: { stage: { endpoint: null, oid: null, secretId: "cap/stage" } },
        results: {},
        awsTenants: {},
        fitCliRole: { accountId: "958525475024", roleName: "fit-cli-role" },
      },
      config: { version: FIT_CLI_CONFIG_VERSION },
      env: {},
      fetchSecret: noFetch,
    }),
    /isn't fully provisioned/,
  );
});

test("rejects unsupported newer config versions", () => {
  assert.throws(
    () => parseFitCliConfig("{ version: 2 }"),
    UnsupportedFitCliConfigVersionError,
  );
});

test("applyFitCliConfigToEnv applies nothing (config no longer exports env vars)", () => {
  const env: NodeJS.ProcessEnv = {};
  const applied = applyFitCliConfigToEnv(
    {
      version: FIT_CLI_CONFIG_VERSION,
      cloud: { aws: { instanceTypes: { functional: "c5.xlarge" } } },
    },
    env,
  );

  assert.deepEqual(applied, []);
  assert.deepEqual(env, {});
});

test("resolveCloudInstanceType prefers config, then the baked default", () => {
  const config: FitCliConfig = {
    version: FIT_CLI_CONFIG_VERSION,
    cloud: { aws: { instanceTypes: { perf: "m6i.8xlarge" } } },
  };
  assert.equal(resolveCloudInstanceType("perf", { config }), "m6i.8xlarge");
  // functional not set in config → baked default.
  assert.equal(resolveCloudInstanceType("functional", { config }), DEFAULT_CLOUD_INSTANCE_TYPES.aws.functional);
  // no config at all → baked default.
  assert.equal(
    resolveCloudInstanceType("situational", { config: { version: FIT_CLI_CONFIG_VERSION } }),
    DEFAULT_CLOUD_INSTANCE_TYPES.aws.situational,
  );
});

test("saves and reloads config.json5", () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-config-"));
  const path = join(dir, "config.json5");
  saveFitCliConfig(
    {
      version: FIT_CLI_CONFIG_VERSION,
      cloud: {
        aws: {
          instanceTypes: { functional: "c5.xlarge", perf: "c5.4xlarge" },
        },
      },
    },
    path,
  );

  assert.match(readFileSync(path, "utf8"), /version: 1/);
  assert.deepEqual(loadFitCliConfig(path), {
    loaded: true,
    path,
    config: {
      version: FIT_CLI_CONFIG_VERSION,
      cloud: {
        aws: {
          instanceTypes: { functional: "c5.xlarge", perf: "c5.4xlarge" },
        },
      },
    },
  });
});

test("saves and reloads config.yaml (YAML format, backward compat)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-config-"));
  const path = join(dir, "config.yaml");
  saveFitCliConfig(
    {
      version: FIT_CLI_CONFIG_VERSION,
      cloud: {
        aws: {
          instanceTypes: { functional: "c5.xlarge" },
        },
      },
    },
    path,
  );

  assert.match(readFileSync(path, "utf8"), /version: 1/);
  assert.deepEqual(loadFitCliConfig(path), {
    loaded: true,
    path,
    config: {
      version: FIT_CLI_CONFIG_VERSION,
      cloud: {
        aws: {
          instanceTypes: { functional: "c5.xlarge" },
        },
      },
    },
  });
});

test("ensureFitCliConfigEnv can run init and apply the created config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-config-"));
  const path = join(dir, "config.json5");
  const env: NodeJS.ProcessEnv = {};
  const result = await ensureFitCliConfigEnv({
    path,
    env,
    confirmCreate: () => Promise.resolve(true),
    runInitWorkflow: (configPath) => {
      saveFitCliConfig(
        {
          version: FIT_CLI_CONFIG_VERSION,
          cloud: { aws: { instanceTypes: { functional: "c5.xlarge" } } },
        },
        configPath,
      );
      return Promise.resolve();
    },
  });

  assert.equal(result.loaded, true);
  assert.equal(result.created, true);
  assert.deepEqual(result.applied, []);
});

test("ensureFitCliConfigEnv returns without creating when the user declines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-config-"));
  const path = join(dir, "config.json5");
  const result = await ensureFitCliConfigEnv({
    path,
    confirmCreate: () => Promise.resolve(false),
  });

  assert.equal(result.loaded, false);
  assert.equal(result.created, false);
});
