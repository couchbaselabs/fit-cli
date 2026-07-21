import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalFitExecutionContext,
  gitCredentialsLine,
  heartbeatShellCommand,
  pathPrefixedCommand,
  redirectToFileCommand,
  remoteDockerWrapperScript,
  remoteFitRepos,
  remoteFitRootDir,
  remotePerformerArgs,
} from "../util/remote-fit-run.js";

test("remoteFitRootDir defaults to the ubuntu home directory", () => {
  assert.equal(remoteFitRootDir(), "/home/ubuntu/fit-workspace");
});

test("remoteFitRepos only includes transactions-fit-performer (jenkins-sdk was removed)", () => {
  assert.deepEqual(
    remoteFitRepos().map((repo) => repo.dir),
    ["transactions-fit-performer"],
  );
});

test("remoteDockerWrapperScript routes docker through passwordless sudo", () => {
  assert.equal(remoteDockerWrapperScript(), "#!/bin/sh\nexec sudo -n /usr/bin/docker \"$@\"\n");
});

test("gitCredentialsLine grants github.com access via the x-access-token user", () => {
  assert.equal(gitCredentialsLine("ghp_secret"), "https://x-access-token:ghp_secret@github.com\n");
});

test("createLocalFitExecutionContext keeps local file paths unchanged", () => {
  const execution = createLocalFitExecutionContext();
  assert.equal(execution.targetFilePath("/tmp/fit-cli/run/driver.log"), "/tmp/fit-cli/run/driver.log");
});

test("createLocalFitExecutionContext builds local docker run args with host-gateway wiring", () => {
  const execution = createLocalFitExecutionContext();
  assert.deepEqual(execution.performerRunArgs("performer-node-main"), [
    "run",
    "--platform",
    "linux/amd64",
    "--detach",
    "--add-host",
    "host.docker.internal:host-gateway",
    "--publish",
    "8060:8060",
    "--env",
    "LOG_LEVEL=debug",
    "performer-node-main",
  ]);
});

test("remotePerformerArgs add the host-gateway alias and publish the performer port", () => {
  assert.deepEqual(remotePerformerArgs("performer-node-main", 8060), [
    "run",
    "--detach",
    "--add-host",
    "host.docker.internal:host-gateway",
    "--publish",
    "8060:8060",
    "--env",
    "LOG_LEVEL=debug",
    "performer-node-main",
  ]);
});

test("performer run args never join another Docker network, so the published port keeps working", () => {
  // The test-driver is a host process dialling localhost:<port>, so it depends on the
  // publish. Joining a cluster's network silently breaks it: --publish does nothing on
  // the ipvlan networks cbdinocluster uses.
  for (const args of [
    remotePerformerArgs("performer-node-main", 18060),
    createLocalFitExecutionContext().performerRunArgs("performer-node-main", 18060),
  ]) {
    assert.ok(!args.includes("--network"), `expected no --network in ${args.join(" ")}`);
    assert.ok(args.includes("18060:8060"), `expected the port to be published in ${args.join(" ")}`);
  }
});

test("pathPrefixedCommand exports PATH before running the command", () => {
  assert.equal(
    pathPrefixedCommand("/home/ubuntu/fit-workspace/bin", "./gradlew", ["buildPerformer"]),
    "export PATH=/home/ubuntu/fit-workspace/bin:$PATH; ./gradlew buildPerformer",
  );
});

test("redirectToFileCommand quotes shell-sensitive args and paths", () => {
  assert.equal(
    redirectToFileCommand("./mvnw", ["-Dtest=a b", "test"], "/tmp/fit logs/driver.log"),
    "./mvnw '-Dtest=a b' test > '/tmp/fit logs/driver.log' 2>&1",
  );
});

test("heartbeatShellCommand redirects full output to file and emits a periodic last-line heartbeat", () => {
  const script = heartbeatShellCommand("export PATH=/tmp/bin:$PATH; ./mvnw test", "/tmp/fit logs/driver.log", 30);
  // Full output goes only to the (quoted) file via a backgrounded subshell.
  assert.match(script, /^\( export PATH=\/tmp\/bin:\$PATH; \.\/mvnw test \) > '\/tmp\/fit logs\/driver\.log' 2>&1 &$/m);
  // No tee: nothing streams the full output to the terminal.
  assert.doesNotMatch(script, /tee/);
  // Heartbeat tails the same quoted file on the configured interval.
  assert.match(script, /tail -n 1 '\/tmp\/fit logs\/driver\.log'/);
  assert.match(script, /-ge 30 \]/);
  // The command's exit code is the script's, preserving failure semantics.
  assert.match(script, /wait "\$cmd_pid"$/m);
});
