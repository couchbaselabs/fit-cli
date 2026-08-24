import assert from "node:assert/strict";
import { test } from "node:test";
import { capture } from "../proc.js";
import {
  colourEnabled,
  formatFitCliError,
  formatFitCliWarn,
  formatTimestampedChunk,
} from "../fit-cli-log.js";

test("colourEnabled: FORCE_COLOR forces colour on even without a TTY", () => {
  assert.equal(colourEnabled({ FORCE_COLOR: "1" }, false), true);
});

test("colourEnabled: FORCE_COLOR overrides NO_COLOR", () => {
  assert.equal(colourEnabled({ FORCE_COLOR: "1", NO_COLOR: "1" }, false), true);
});

test("colourEnabled: FORCE_COLOR=0 does not force colour on", () => {
  assert.equal(colourEnabled({ FORCE_COLOR: "0" }, false), false);
  // ...and with a TTY it falls through to the TTY result rather than forcing off.
  assert.equal(colourEnabled({ FORCE_COLOR: "0" }, true), true);
});

test("colourEnabled: NO_COLOR forces colour off even with a TTY", () => {
  assert.equal(colourEnabled({ NO_COLOR: "" }, true), false);
});

test("colourEnabled: GitHub Actions enables colour despite no TTY", () => {
  assert.equal(colourEnabled({ GITHUB_ACTIONS: "true" }, false), true);
});

test("colourEnabled: falls back to the TTY flag when no env signal is set", () => {
  assert.equal(colourEnabled({}, true), true);
  assert.equal(colourEnabled({}, false), false);
});

test("formatFitCliError prefixes and colours errors", () => {
  assert.equal(
    formatFitCliError("\n✗ Something broke"),
    "\nFitCliError: \u001b[31mSomething broke\u001b[0m",
  );
});

test("formatFitCliWarn prefixes and colours warnings", () => {
  assert.equal(
    formatFitCliWarn("\n→ Skipping this step"),
    "\nFitCliWarn: \u001b[33mSkipping this step\u001b[0m",
  );
});

test("formatFitCliWarn puts the label on its own line for multi-line bodies", () => {
  // ANSI-tolerant: colour is gated on isTTY, so strip codes before comparing.
  const stripAnsi = (s: string) =>
    s.replace(new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, "g"), "");
  assert.equal(
    stripAnsi(formatFitCliWarn("====\n= hi =\n====")),
    "FitCliWarn:\n====\n= hi =\n====",
  );
});

test("formatFitCliError avoids duplicating an existing prefix", () => {
  assert.equal(
    formatFitCliError("FitCliError: already prefixed"),
    "FitCliError: \u001b[31malready prefixed\u001b[0m",
  );
});

test("formatFitCliError surfaces an Error's message even when its stack doesn't include it", () => {
  // Simulates the compiled Bun binary, where an Error's .stack can render as just
  // the bare error name with the message dropped.
  const err = new Error("performer does not match run type");
  Object.defineProperty(err, "stack", { value: "Error" });
  assert.equal(
    formatFitCliError(err),
    "FitCliError: \u001b[31mperformer does not match run type\u001b[0m",
  );
});

test("formatFitCliError appends a failure classification to the label", () => {
  assert.equal(
    formatFitCliError({ classification: "FatalToRun" }, "\n✗ No JUnit reports"),
    "\nFitCliError/FatalToRun: [31mNo JUnit reports[0m",
  );
});

test("formatFitCliWarn appends a failure classification to the label", () => {
  assert.equal(
    formatFitCliWarn({ classification: "FatalToCluster" }, "Cluster sanity check failed"),
    "FitCliWarn/FatalToCluster: [33mCluster sanity check failed[0m",
  );
});

test("formatTimestampedChunk prefixes each non-empty line", () => {
  assert.deepEqual(
    formatTimestampedChunk("\nhello\nworld", true, () => "12:34:56"),
    { text: "\n[12:34:56] hello\n[12:34:56] world", atLineStart: false },
  );
});

test("formatTimestampedChunk joins context fields with a dot separator", () => {
  const ctx = { env: "aws1", cluster: "cbdino1", performer: "java:main", run: "functional" };
  assert.deepEqual(
    formatTimestampedChunk("hello\nworld", true, () => "12:34:56", () => ctx),
    {
      text: "[12:34:56·aws1·cbdino1·java:main·functional] hello\n[12:34:56·aws1·cbdino1·java:main·functional] world",
      atLineStart: false,
    },
  );
});

test("formatTimestampedChunk omits missing context fields", () => {
  const ctx = { env: "aws1" };
  assert.deepEqual(
    formatTimestampedChunk("hello", true, () => "12:34:56", () => ctx),
    { text: "[12:34:56·aws1] hello", atLineStart: false },
  );
});

test("formatTimestampedChunk puts the global progress segment right after the timestamp", () => {
  const ctx = { progress: "5/13", env: "aws1", cluster: "cbdino1", performer: "java:main", run: "functional" };
  assert.deepEqual(
    formatTimestampedChunk("hello", true, () => "12:34:56", () => ctx),
    { text: "[12:34:56·5/13·aws1·cbdino1·java:main·functional] hello", atLineStart: false },
  );
});

test("installFitCliConsoleFormatting timestamps console output and direct stdout writes", async () => {
  const fitCliLogModule = new URL("../fit-cli-log.ts", import.meta.url).href;
  const driver = [
    `import { installFitCliConsoleFormatting, setFitCliTimestampProvider } from ${JSON.stringify(fitCliLogModule)};`,
    `setFitCliTimestampProvider(() => "12:34:56");`,
    "installFitCliConsoleFormatting();",
    `console.log("hello");`,
    `process.stdout.write("Checking SSH...");`,
    `console.log(" ready");`,
  ].join("\n");

  const output = await capture(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", driver],
  );

  assert.equal(output, "[12:34:56] hello\n[12:34:56] Checking SSH... ready\n");
});

test("withRawTerminalWrites bypasses timestamp prefixes while preserving later line state", async () => {
  const fitCliLogModule = new URL("../fit-cli-log.ts", import.meta.url).href;
  const driver = [
    `import { installFitCliConsoleFormatting, setFitCliTimestampProvider, withRawTerminalWrites } from ${JSON.stringify(fitCliLogModule)};`,
    `setFitCliTimestampProvider(() => "12:34:56");`,
    "installFitCliConsoleFormatting();",
    `console.log("before");`,
    `await withRawTerminalWrites(async () => { process.stdout.write("? "); console.log("(Y/n)"); });`,
    `console.log("after");`,
  ].join("\n");

  const output = await capture(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", driver],
  );

  assert.equal(output, "[12:34:56] before\n? (Y/n)\n[12:34:56] after\n");
});
