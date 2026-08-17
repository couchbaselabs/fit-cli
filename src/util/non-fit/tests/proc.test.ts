import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { capture, captureValueSync, createLogFile, SMALL_LOG_INTRO, SMALL_LOG_MAX_BYTES, streamToFile } from "../proc.js";

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

/**
 * Run streamToFile in a child process so we can observe its real stdout without
 * monkeypatching this process's streams (which confuses the test runner's own
 * reporter). streamToFile echoes the command line it's about to run, so the
 * grandchild assembles its output marker at runtime — that way the marker never
 * appears in the echoed command, and anything matching it on stdout can only be
 * the grandchild's own output.
 */
async function streamToFileInChild(childSource: string, logFile: string): Promise<string> {
  const procModule = new URL("../proc.ts", import.meta.url).href;
  // Swallow the rejection inside the child: a non-zero grandchild is one of the
  // cases under test, and letting it propagate would fail `capture` and take the
  // terminal output we came here to inspect with it.
  const driver = [
    `import { streamToFile } from ${JSON.stringify(procModule)};`,
    `await streamToFile(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(childSource)}], ${JSON.stringify(logFile)}).catch(() => {});`,
  ].join("\n");
  return capture(process.execPath, ["--import", "tsx", "--input-type=module", "-e", driver]);
}

test("streamToFile does not echo the command's output to the terminal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-proc-"));
  const logFile = join(dir, "test-driver.log");

  // Deliberately over SMALL_LOG_MAX_BYTES: a log this size is the case L3 exists
  // for, and must stay in the file. (Small logs are dumped — see the next test.)
  const terminal = await streamToFileInChild(
    "for (let i = 0; i < 4000; i++) console.log(['fit','marker'].join('-'))",
    logFile,
  );

  assert.ok(readFileSync(logFile, "utf8").length > SMALL_LOG_MAX_BYTES);
  assert.doesNotMatch(terminal, /fit-marker/);
  assert.match(readFileSync(logFile, "utf8"), /fit-marker/);
});

test("streamToFile prints the whole log to the terminal when it is under the size threshold", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-proc-"));
  const logFile = join(dir, "test-driver.log");

  const terminal = await streamToFileInChild("console.log(['fit','marker'].join('-'))", logFile);

  assert.ok(readFileSync(logFile, "utf8").length <= SMALL_LOG_MAX_BYTES);
  assert.match(terminal, new RegExp(SMALL_LOG_INTRO));
  assert.match(terminal, /fit-marker/);
});

test("streamToFile prints a short log even when the command fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-proc-"));
  const logFile = join(dir, "test-driver.log");

  // The failure case is the one that motivated this: a process that dies early
  // leaves a log that is nothing but the stack trace, and the reader wants it
  // in front of them rather than in a file.
  const terminal = await streamToFileInChild(
    "console.error(['fit','marker'].join('-')); process.exit(1)",
    logFile,
  );

  assert.match(terminal, new RegExp(SMALL_LOG_INTRO));
  assert.match(terminal, /fit-marker/);
});

test("streamToFile stays quiet when the command produced no output at all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-proc-"));
  const logFile = join(dir, "test-driver.log");

  const terminal = await streamToFileInChild("", logFile);

  // The log still holds streamToFile's own `# <timestamp> <command>` header, so
  // "empty" here means "the command said nothing" — don't print a bare header.
  assert.doesNotMatch(terminal, new RegExp(SMALL_LOG_INTRO));
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

test("getCurrentSessionTail exposes the active session log's tail as a module-level singleton", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-proc-"));
  const logFile = join(dir, "session.info.log");
  const procModule = new URL("../proc.ts", import.meta.url).href;

  const driver = [
    `import { run, startSessionLog, getCurrentSessionTail } from ${JSON.stringify(procModule)};`,
    `const sessionLog = startSessionLog(${JSON.stringify(logFile)});`,
    `await run(${JSON.stringify(process.execPath)}, ["-e", "console.log('boom: something broke')"]);`,
    "console.log(`TAIL:${getCurrentSessionTail()}`);",
    "await sessionLog.flush();",
  ].join("\n");

  const terminal = await capture(process.execPath, ["--import", "tsx", "--input-type=module", "-e", driver]);
  assert.match(terminal, /TAIL:.*boom: something broke/s);
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

test("capture gives the child EOF on stdin rather than an open pipe", () => {
  // The 5h GCP hang: `gcloud compute ssh` generates an SSH key on a host with
  // none, and ssh-keygen's passphrase prompt blocked forever on a stdin pipe
  // that nothing ever wrote to or closed. Reading stdin must see EOF at once.
  const reader = "const fs=require('node:fs');let d='';try{d=fs.readFileSync(0,'utf8')}catch(e){d='ERR'};process.stdout.write('stdin=['+d+']')";
  return capture(process.execPath, ["-e", reader], undefined, { quiet: true, timeoutMs: 10_000 }).then((out) => {
    assert.equal(out, "stdin=[]");
  });
});
