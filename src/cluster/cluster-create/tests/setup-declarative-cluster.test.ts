import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";
import type { ClusterCommandExecutor } from "../allocate-cluster.js";
import { CBDINOCLUSTER_REMOVE_ALL_TIMEOUT, CBDINOCLUSTER_RM_TIMEOUT, cbdinoclusterNeedsInit, dockerNetworkFromInitArgs, remoteCbdinoclusterCloudEnabled, removeCluster, removeClusterArgs, removeRunCapellaClustersArgs, setupDeclarativeCluster } from "../setup-declarative-cluster.js";

const STAMP = "fitcli-20260101-000000-0123abcd";

const CLUSTER_PS_OUTPUT = `2026-06-03T13:02:18.157+0100    INFO    logger initialized
Clusters:
  df45d6d0-cfbe-4905-bc8c-989a09c03817 [Type: server, State: ready, Timeout: none, Deployer: docker]
    4e9e2165-6fb6-4114-bf44-aba0ed02a25e                          172.18.0.2           f58b3be1...
`;

function executor(): ClusterCommandExecutor & {
  kind: "remote";
  runCalls: Array<{ command: string; args: string[] }>;
  stagedFiles: Array<{ localPath: string; targetPath: string }>;
} {
  const runCalls: Array<{ command: string; args: string[] }> = [];
  const stagedFiles: Array<{ localPath: string; targetPath: string }> = [];
  let psCalls = 0;

  return {
    kind: "remote",
    description: "remote host",
    runCalls,
    stagedFiles,
    run: (command, args) => {
      runCalls.push({ command, args });
      return Promise.resolve();
    },
    runHiddenUntilFailure: (command, args) => {
      runCalls.push({ command, args });
      return Promise.resolve();
    },
    capture: (_command, args) => {
      if (args[0] === "ps") {
        psCalls += 1;
        if (psCalls === 1 && stagedFiles.length === 0) {
          return Promise.reject(new Error("cbdinocluster exited with code 1: FATAL you must run the `init` command first"));
        }
        return Promise.resolve(CLUSTER_PS_OUTPUT);
      }
      if (args[0] === "connstr") {
        return Promise.resolve("couchbase://172.18.0.2\n");
      }
      return Promise.resolve("");
    },
    streamToTerminalAndFile: () => Promise.resolve(),
    targetFilePath: (path) => path,
    stageFile: (localPath, targetPath = localPath) => {
      stagedFiles.push({ localPath, targetPath });
      return Promise.resolve(targetPath);
    },
    collectFile: (_targetPath: string, localPath: string) => Promise.resolve(localPath),
    commandAvailable: () => Promise.resolve(true),
  };
}

/** The same fake as {@link executor}, run on this machine. */
function localExecutor(): Omit<ReturnType<typeof executor>, "kind"> {
  const { kind: _kind, ...local } = executor();
  return local;
}

test("cbdinoclusterNeedsInit spots the init-required failure", () => {
  assert.equal(cbdinoclusterNeedsInit("FATAL you must run the `init` command first"), true);
  assert.equal(cbdinoclusterNeedsInit("permission denied"), false);
});

test("dockerNetworkFromInitArgs reads --docker-network in both forms", () => {
  assert.equal(dockerNetworkFromInitArgs("--auto --disable-k8s --docker-network fit"), "fit");
  assert.equal(dockerNetworkFromInitArgs("--docker-network=mynet --auto"), "mynet");
  assert.equal(dockerNetworkFromInitArgs("--auto --disable-k8s"), undefined);
});

/** A minimal remote executor whose `capture` returns a fixed `~/.cbdinocluster`. */
function configReadingExecutor(config: string): ClusterCommandExecutor & { kind: "remote" } {
  return {
    kind: "remote",
    description: "remote host",
    run: () => Promise.resolve(),
    runHiddenUntilFailure: () => Promise.resolve(),
    capture: () => Promise.resolve(config),
    streamToTerminalAndFile: () => Promise.resolve(),
    targetFilePath: (path) => path,
    stageFile: (localPath, targetPath = localPath) => Promise.resolve(targetPath),
    collectFile: (_targetPath: string, localPath: string) => Promise.resolve(localPath),
    commandAvailable: () => Promise.resolve(true),
  };
}

test("remoteCbdinoclusterCloudEnabled detects whether init enabled the cloud deployer", async () => {
  const endpoint = "https://api.dev.example.com";
  const withCloud = configReadingExecutor(`capella:\n  endpoint: ${endpoint}\n`);
  const withoutCloud = configReadingExecutor("docker:\n  enabled: true\n");

  assert.equal(await remoteCbdinoclusterCloudEnabled(withCloud, endpoint), true);
  assert.equal(await remoteCbdinoclusterCloudEnabled(withoutCloud, endpoint), false);
  // No endpoint to look for → can't verify, so treat as enabled (skip the guard).
  assert.equal(await remoteCbdinoclusterCloudEnabled(withoutCloud, undefined), true);
});

/** A remote executor that only succeeds at `ps` once `cbdinocluster init` has run. */
function initAwareExecutor(): ClusterCommandExecutor & {
  kind: "remote";
  runCalls: Array<{ command: string; args: string[] }>;
  stagedFiles: Array<{ localPath: string; targetPath: string }>;
} {
  const runCalls: Array<{ command: string; args: string[] }> = [];
  const stagedFiles: Array<{ localPath: string; targetPath: string }> = [];
  let inited = false;
  return {
    kind: "remote",
    description: "remote host",
    runCalls,
    stagedFiles,
    run: (command, args) => {
      runCalls.push({ command, args });
      return Promise.resolve();
    },
    runHiddenUntilFailure: (command, args) => {
      runCalls.push({ command, args });
      // init now runs through a login shell (`bash -lc "cbdinocluster init …"`)
      // so it sources ~/.profile and inherits the forwarded CAPELLA_*/AWS_* vars.
      if (command === "bash" && args[0] === "-lc" && (args[1] ?? "").includes("cbdinocluster init")) {
        inited = true;
      }
      return Promise.resolve();
    },
    capture: (_command, args) => {
      if (args[0] === "ps") {
        return inited
          ? Promise.resolve(CLUSTER_PS_OUTPUT)
          : Promise.reject(new Error("cbdinocluster exited with code 1: FATAL you must run the `init` command first"));
      }
      if (args[0] === "connstr") {
        return Promise.resolve("couchbase://172.18.0.2\n");
      }
      return Promise.resolve("");
    },
    streamToTerminalAndFile: () => Promise.resolve(),
    targetFilePath: (path) => path,
    stageFile: (localPath, targetPath = localPath) => {
      stagedFiles.push({ localPath, targetPath });
      return Promise.resolve(targetPath);
    },
    collectFile: (_targetPath: string, localPath: string) => Promise.resolve(localPath),
    commandAvailable: () => Promise.resolve(true),
  };
}

test("setupDeclarativeCluster runs `cbdinocluster init` for the docker args path", async () => {
  const execution = initAwareExecutor();

  const result = await setupDeclarativeCluster(
    {
      init: { args: "--auto --disable-k8s --docker-network fit" },
      config: { nodes: [{ count: 1, version: "8.1.0", services: ["kv"] }] },
      onClusterExists: "useExisting",
      purpose: STAMP,
      githubCredentials: { user: "alice", token: "ghtoken" },
    },
    execution,
  );

  const initCall = execution.runCalls.find(
    (c) => c.command === "bash" && c.args[0] === "-lc" && (c.args[1] ?? "").includes("cbdinocluster init"),
  );
  assert.ok(initCall, "expected a `cbdinocluster init` call");
  // init runs in a login shell so it picks up forwarded CAPELLA_*/AWS_* env; the
  // editable args are passed through and the GitHub credentials are appended.
  // The run's Capella key pool flags follow, named after the run stamp. Nothing
  // else is added.
  assert.match(
    initCall.args[1] ?? "",
    new RegExp(
      `^cbdinocluster init --auto --disable-k8s --docker-network fit --github-user alice --github-token ghtoken ` +
        `--capella-create-pool --capella-pool-name ${STAMP} --capella-pool-size \\d+ --capella-pool-expiry \\S+$`,
    ),
  );
  assert.equal(result.capellaKeyPool, true);
  assert.equal(result.capellaCredentials, true);
  // The stale `~/.cbdinocluster` is removed before init so `init --auto` keys off
  // the forwarded env/flags, not a previous execution group's config (which may
  // have left Capella disabled — see runCbdinoclusterInit).
  const rmIndex = execution.runCalls.findIndex(
    (c) => c.command === "sh" && (c.args[1] ?? "") === "rm -f ~/.cbdinocluster",
  );
  const initIndex = execution.runCalls.findIndex(
    (c) => c.command === "bash" && (c.args[1] ?? "").includes("cbdinocluster init"),
  );
  assert.ok(rmIndex !== -1, "expected a clean-slate `rm -f ~/.cbdinocluster` before init");
  assert.ok(rmIndex < initIndex, "the config must be removed before `cbdinocluster init` runs");
  // The docker network the args name is created, and no config file is uploaded.
  assert.ok(execution.runCalls.some((c) => c.command === "docker" && c.args.join(" ") === "network create fit"));
  assert.equal(execution.stagedFiles.length, 0);
  assert.equal(result.cluster?.defaultHostname, "172.18.0.2");
});

test("setupDeclarativeCluster falls back to --disable-github when no credentials are given", async () => {
  const execution = initAwareExecutor();
  await setupDeclarativeCluster(
    {
      init: { args: "--auto --docker-network fit" },
      config: { nodes: [{ count: 1, version: "8.1.0", services: ["kv"] }] },
      onClusterExists: "useExisting",
      purpose: STAMP,
    },
    execution,
  );
  const initCall = execution.runCalls.find(
    (c) => c.command === "bash" && c.args[0] === "-lc" && (c.args[1] ?? "").includes("cbdinocluster init"),
  );
  assert.match(initCall?.args[1] ?? "", /^cbdinocluster init --auto --docker-network fit --disable-github /);
});

test("setupDeclarativeCluster adds no key pool flags when the init args disable Capella", async () => {
  const execution = initAwareExecutor();
  const result = await setupDeclarativeCluster(
    {
      init: { args: "--auto --disable-capella --docker-network fit" },
      config: { nodes: [{ count: 1, version: "8.1.0", services: ["kv"] }] },
      onClusterExists: "useExisting",
      purpose: STAMP,
    },
    execution,
  );
  const initCall = execution.runCalls.find(
    (c) => c.command === "bash" && c.args[0] === "-lc" && (c.args[1] ?? "").includes("cbdinocluster init"),
  );
  assert.match(
    initCall?.args[1] ?? "",
    /^cbdinocluster init --auto --disable-capella --docker-network fit --disable-github$/,
  );
  assert.equal(result.capellaKeyPool, undefined);
  assert.equal(result.capellaCredentials, undefined);
});

test("setupDeclarativeCluster records Capella credentials for a cloud plan, also on a failed result", async () => {
  const result = await setupDeclarativeCluster(
    {
      config: { nodes: [{ count: 1, version: "8.1.0", services: ["kv"] }] },
      onClusterExists: "fail",
      deployer: "cloud",
      purpose: STAMP,
    },
    executor(),
  );
  assert.equal(result.cluster, undefined);
  assert.equal(result.cbdinocluster, "cbdinocluster");
  assert.equal(result.capellaCredentials, true);
});

test("setupDeclarativeCluster initializes cbdinocluster before retrying ps", async () => {
  const execution = executor();

  const result = await setupDeclarativeCluster(
    {
      init: {
        config: {
          version: 6,
          docker: { enabled: "true", network: "fit" },
        },
      },
      config: { nodes: [{ count: 1, version: "8.1.0", services: ["kv"] }] },
      onClusterExists: "useExisting",
      purpose: STAMP,
    },
    execution,
  );

  assert.equal(execution.stagedFiles.length, 1);
  assert.match(execution.stagedFiles[0].localPath, /cbdinocluster-init\.yaml$/);
  assert.deepEqual(execution.runCalls, [
    {
      command: "sh",
      args: ["-lc", `cp ${execution.stagedFiles[0].targetPath} ~/.cbdinocluster && chmod 600 ~/.cbdinocluster`],
    },
    {
      command: "docker",
      args: ["network", "create", "fit"],
    },
  ]);
  assert.equal(result.allocated, false);
  assert.equal(result.cluster?.defaultHostname, "172.18.0.2");
  // The uploaded config is the definition's own, with nothing added.
  const uploaded = YAML.parse(readFileSync(execution.stagedFiles[0].localPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(uploaded, { version: 6, docker: { enabled: "true", network: "fit" } });
});

test("setupDeclarativeCluster runs a bare `init --auto` on a remote box", async () => {
  const execution = executor();
  const result = await setupDeclarativeCluster(
    {
      config: { nodes: [{ count: 1, version: "8.1.0", services: ["kv"] }] },
      onClusterExists: "useExisting",
      purpose: STAMP,
    },
    execution,
  );
  assert.deepEqual(execution.runCalls, [
    { command: "cbdinocluster", args: ["init", "--auto"] },
  ]);
  assert.equal(result.cluster?.defaultHostname, "172.18.0.2");
});

test("setupDeclarativeCluster runs a bare `init --auto` on this machine", async () => {
  const execution = localExecutor();
  const result = await setupDeclarativeCluster(
    {
      config: { nodes: [{ count: 1, version: "8.1.0", services: ["kv"] }] },
      onClusterExists: "useExisting",
      purpose: STAMP,
    },
    execution,
  );
  assert.deepEqual(execution.runCalls, [{ command: "cbdinocluster", args: ["init", "--auto"] }]);
  assert.equal(result.cluster?.defaultHostname, "172.18.0.2");
});

test("removeClusterArgs bounds the removal and accepts a cluster that is already gone", () => {
  assert.deepEqual(removeClusterArgs("abc123"), ["rm", "--timeout", CBDINOCLUSTER_RM_TIMEOUT, "--ignore-missing", "abc123"]);
});

test("removeCluster reports the cluster gone when rm exits 0", async () => {
  const execution = executor();
  assert.equal(await removeCluster("cbdinocluster", "abc123", execution), true);
  assert.deepEqual(execution.runCalls, [{ command: "cbdinocluster", args: removeClusterArgs("abc123") }]);
});

test("removeCluster reports a failure when rm exits non-zero", async () => {
  const execution = {
    ...executor(),
    run: () => Promise.reject(new Error("cbdinocluster exited with code 1")),
  };
  assert.equal(await removeCluster("cbdinocluster", "abc123", execution), false);
});

test("removeRunCapellaClustersArgs targets the cloud deployer with the run's exact stamp", () => {
  assert.deepEqual(removeRunCapellaClustersArgs("fitcli-20260615-090000-ab12"), [
    "remove-all",
    "cloud",
    "--purpose",
    "fitcli-20260615-090000-ab12",
    "--timeout",
    CBDINOCLUSTER_REMOVE_ALL_TIMEOUT,
  ]);
});

test("removeRunCapellaClustersArgs bounds the removal", () => {
  assert.ok(removeRunCapellaClustersArgs("fitcli-20260615-090000-ab12").includes("--timeout"));
});
