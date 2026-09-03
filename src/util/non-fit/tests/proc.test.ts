import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { capture, captureValueSync, createLogFile, streamToFile } from "../proc.js";

test("createLogFile writes under the shared fit-cli temp directory", () => {
  const path = createLogFile("performer");
  assert.match(path, /^\/tmp\/fit-cli\/\d{8}-\d{6}-[0-9a-f]{4}(?:-\d+)?\/performer\.log$/);
});

test("createLogFile appends a numeric suffix when a log name is reused", () => {
  const firstPath = createLogFile("driver");
  writeFileSync(firstPath, "");
  const secondPath = createLogFile("driver");

  assert.match(firstPath, /\/driver\.log$/);
  assert.match(secondPath, /\/driver-2\.log$/);
  assert.notEqual(firstPath, secondPath);
});

test("captureValueSync returns stdout for a successful command", () => {
  const out = captureValueSync(process.execPath, ["-e", "process.stdout.write('the-value')"]);
  assert.equal(out, "the-value");
});

test("captureValueSync throws on a non-zero exit by default", () => {
  assert.throws(() => captureValueSync(process.execPath, ["-e", "process.exit(3)"]), /exited with code 3/);
});

test("captureValueSync with allowFailure yields empty string instead of throwing", () => {
  assert.equal(captureValueSync(process.execPath, ["-e", "process.exit(3)"], { allowFailure: true }), "");
  assert.equal(captureValueSync("definitely-not-a-real-binary-xyz", [], { allowFailure: true }), "");
});

test("captureValueSync allowExitCodes treats a listed code as success", () => {
  const out = captureValueSync(
    process.execPath,
    ["-e", "process.stdout.write('ok'); process.exit(2)"],
    { allowExitCodes: [0, 2] },
  );
  assert.equal(out, "ok");
});

test("streamToFile writes stdout and stderr to a log file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-proc-"));
  const logFile = join(dir, "test-driver.log");

  await streamToFile(
    process.execPath,
    ["-e", "console.log('fit stdout'); console.error('fit stderr');"],
    logFile,
  );

  const output = readFileSync(logFile, "utf8");
  assert.match(output, /fit stdout/);
  assert.match(output, /fit stderr/);
});

test("streamToFile does not echo the command's output to the terminal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-proc-"));
  const logFile = join(dir, "test-driver.log");
  const procModule = new URL("../proc.ts", import.meta.url).href;

  // Run streamToFile in a child process so we can observe its real stdout
  // without monkeypatching this process's streams (which confuses the test
  // runner's own reporter). streamToFile echoes the command line it's about to
  // run, so the grandchild assembles its output marker at runtime — that way the
  // marker never appears in the echoed command, and anything matching it on
  // stdout can only be the grandchild's output leaking through.
  const driver = [
    `import { streamToFile } from ${JSON.stringify(procModule)};`,
    `await streamToFile(${JSON.stringify(process.execPath)}, ["-e", "console.log(['fit','marker'].join('-'))"], ${JSON.stringify(logFile)});`,
  ].join("\n");

  const terminal = await capture(process.execPath, ["--import", "tsx", "--input-type=module", "-e", driver]);

  assert.doesNotMatch(terminal, /fit-marker/);
  assert.match(readFileSync(logFile, "utf8"), /fit-marker/);
});

test("run tees child output into the session log by default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-proc-"));
  const logFile = join(dir, "session.info.log");
  const procModule = new URL("../proc.ts", import.meta.url).href;

  const driver = [
    `import { run, startSessionLog } from ${JSON.stringify(procModule)};`,
    `const sessionLog = startSessionLog(${JSON.stringify(logFile)});`,
    `await run(${JSON.stringify(process.execPath)}, ["-e", "console.log('child stdout'); console.error('child stderr');"]);`,
    "await sessionLog.flush();",
  ].join("\n");

  const terminal = await capture(process.execPath, ["--import", "tsx", "--input-type=module", "-e", driver]);
  const sessionOutput = readFileSync(logFile, "utf8");

  assert.match(terminal, /child stdout/);
  assert.match(sessionOutput, /child stdout/);
  assert.match(sessionOutput, /child stderr/);
});

/**
 * Resolves once `pid` no longer exists. Signal 0 only checks for the process's
 * existence, so this is a poll for "has the kill landed yet" rather than a fixed
 * sleep — it keeps these tests instant while staying robust on a loaded machine.
 */
async function waitForPidGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("capture rejects when a command outlives its timeoutMs", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    // Without a timeout this sits here forever, which is the failure being fixed.
    capture(process.execPath, ["-e", "setInterval(() => {}, 1000)"], undefined, { quiet: true, timeoutMs: 300 }),
    /timed out after/,
  );
  // Rejecting at all isn't enough: it has to reject *on* the timeout rather than
  // wait out the (endless) command.
  assert.ok(Date.now() - startedAt < 4_000, `took ${Date.now() - startedAt}ms`);
});

test("capture's timeout error quotes the real command so it can be rerun by hand", async () => {
  await assert.rejects(
    capture(process.execPath, ["-e", "setInterval(() => {}, 1000)"], undefined, {
      quiet: true,
      timeoutMs: 200,
      // A `display` override must not hide the real command in a timeout error.
      display: "something tidier",
    }),
    (err: Error) => err.message.includes("setInterval") && err.message.includes("Reproduce with"),
  );
});

test("capture's timeout kills the whole process group, not just the direct child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-proc-timeout-"));
  const pidFile = join(dir, "pids.json");
  // Mirrors the real target: `gcloud compute ssh --tunnel-through-iap` is a
  // process tree (a Python tunnel helper plus ssh), so killing only the direct
  // child would leave descendants alive holding the pipes open.
  const script = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");

  await assert.rejects(
    capture(process.execPath, ["-e", script], undefined, { quiet: true, timeoutMs: 500 }),
    /timed out after/,
  );

  const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { child: number; grandchild: number };
  assert.ok(await waitForPidGone(pids.child), `child ${pids.child} survived the timeout`);
  assert.ok(await waitForPidGone(pids.grandchild), `grandchild ${pids.grandchild} survived the timeout`);
});

test("capture with a timeoutMs still returns normally when the command finishes in time", async () => {
  const out = await capture(process.execPath, ["-e", "process.stdout.write('quick')"], undefined, {
    quiet: true,
    timeoutMs: 30_000,
  });
  assert.equal(out, "quick");
});
