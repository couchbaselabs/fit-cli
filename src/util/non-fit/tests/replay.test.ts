import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  PromptSession,
  REPO_ROOT,
  clusterRunDir,
  defaultsToNonInteractive,
  extractInteractiveFlag,
  extractReplayFlag,
  markNonInteractiveByDefault,
  sanitizePathSeg,
  sessionRunDir,
} from "../replay.js";

const DEFINITION_ENTRYPOINT = join(
  REPO_ROOT,
  "src/fit/functional/run-from-definition/run-from-definition.ts",
);

async function captureLogs(run: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
  return logs;
}

test("extractReplayFlag pulls --replay out of argv", () => {
  assert.deepEqual(extractReplayFlag(["functional", "--replay", "/tmp/run.json", "--root", "/ws"]), {
    replayRequested: true,
    replayDefaults: false,
    replayFile: "/tmp/run.json",
    positionals: ["functional", "--root", "/ws"],
  });
});

test("extractReplayFlag notices a missing logfile", () => {
  assert.deepEqual(extractReplayFlag(["functional", "--replay", "--root", "/ws"]), {
    replayRequested: true,
    replayDefaults: false,
    replayFile: undefined,
    positionals: ["functional", "--root", "/ws"],
  });
});

test("extractReplayFlag supports replay defaults mode", () => {
  assert.deepEqual(extractReplayFlag(["functional", "--defaults", "/tmp/run.json", "--root", "/ws"]), {
    replayRequested: true,
    replayDefaults: true,
    replayFile: "/tmp/run.json",
    positionals: ["functional", "--root", "/ws"],
  });
});

test("extractReplayFlag picks up replay defaults for the replay script", () => {
  assert.deepEqual(
    extractReplayFlag(["--replay", "/tmp/run.json"], {
      npm_lifecycle_event: "replay",
      npm_config_defaults: "true",
    }),
    {
      replayRequested: true,
      replayDefaults: true,
      replayFile: "/tmp/run.json",
      positionals: [],
    },
  );
});

test("extractReplayFlag can take the replay logfile from bun run config when needed", () => {
  assert.deepEqual(
    extractReplayFlag(["--replay"], {
      npm_lifecycle_event: "replay",
      npm_config_defaults: "/tmp/run.json",
    }),
    {
      replayRequested: true,
      replayDefaults: true,
      replayFile: "/tmp/run.json",
      positionals: [],
    },
  );
});

test("extractInteractiveFlag removes --interactive from argv", () => {
  assert.deepEqual(extractInteractiveFlag(["functional", "--interactive", "--root", "/ws"]), {
    interactive: true,
    positionals: ["functional", "--root", "/ws"],
  });
});

test("definition runs default to non-interactive prompts", () => {
  const noEnv = {};
  assert.equal(defaultsToNonInteractive(DEFINITION_ENTRYPOINT, noEnv), true);
  assert.equal(defaultsToNonInteractive(join(REPO_ROOT, "src/main.ts"), noEnv), false);
});

test("CI env var defaults to non-interactive", () => {
  assert.equal(defaultsToNonInteractive(join(REPO_ROOT, "src/main.ts"), { CI: "true" }), true);
});

test("markNonInteractiveByDefault makes any launch form non-interactive", () => {
  const binaryEntrypoint = join(REPO_ROOT, "src/main.ts");
  const noEnv = {};
  // Default: launching via the binary (the `fit definition` / `fit run definition`
  // path) is treated as interactive until the command declares otherwise.
  assert.equal(defaultsToNonInteractive(binaryEntrypoint, noEnv), false);
  try {
    markNonInteractiveByDefault();
    assert.equal(defaultsToNonInteractive(binaryEntrypoint, noEnv), true);
  } finally {
    markNonInteractiveByDefault(false);
  }
  assert.equal(defaultsToNonInteractive(binaryEntrypoint, noEnv), false);
});

test("interactive mode writes prompt responses to a log file", async () => {
  const session = PromptSession.fromArgv(["--interactive"]);

  const response = await session.resolvePrompt("sdk.choose", "input", "Which SDK?", () =>
    Promise.resolve("node"),
  );
  assert.equal(response, "node");

  const log = JSON.parse(readFileSync(session.logFile, "utf8")) as {
    prompts: Array<{ id: string; kind: string; message: string; response: string }>;
  };
  assert.deepEqual(log.prompts, [
    { id: "sdk.choose", kind: "input", message: "Which SDK?", response: "node" },
  ]);
});

test("interactive mode is the default outside definition runs", async () => {
  // Empty env, not the ambient one: CI sets CI=true, which forces non-interactive.
  const session = PromptSession.fromArgv([], {}, { env: {} });

  const response = await session.resolvePrompt(
    "fit.grpc.build-now",
    "confirm",
    "Build FIT now?",
    () => Promise.resolve(false),
    { nonInteractiveDefault: () => true },
  );

  assert.equal(response, false);
});

test("definition runs default to non-interactive mode and record synthesized answers", async () => {
  const session = PromptSession.fromArgv([], {}, { entrypoint: DEFINITION_ENTRYPOINT });

  const logs = await captureLogs(async () => {
    const response = await session.resolvePrompt(
      "fit.grpc.build-now",
      "confirm",
      "Build FIT now?",
      () => Promise.resolve(false),
      { nonInteractiveDefault: () => true },
    );
    assert.equal(response, true);
  });

  const log = JSON.parse(readFileSync(session.logFile, "utf8")) as {
    prompts: Array<{ id: string; kind: string; message: string; response: boolean }>;
  };
  assert.deepEqual(log.prompts, [
    { id: "fit.grpc.build-now", kind: "confirm", message: "Build FIT now?", response: true },
  ]);
  assert.equal(logs.at(-1), "[non-interactive] Build FIT now?\n  -> true");
});

test("definition runs reject prompts without a synthesized default", async () => {
  const session = PromptSession.fromArgv([], {}, { entrypoint: DEFINITION_ENTRYPOINT });

  await assert.rejects(
    () => session.resolvePrompt("fit.tests.single", "search", "Search for a test:", () => Promise.resolve("x")),
    /does not support non-interactive mode; rerun with --interactive/,
  );
});

test("prompt sessions create a per-run directory under /tmp/fit-cli", () => {
  const session = PromptSession.fromArgv([]);

  assert.match(session.runDir, /^\/tmp\/fit-cli\/\d{8}-\d{6}-[0-9a-f]{4}(?:-\d+)?$/);
  assert.equal(statSync(session.runDir).isDirectory(), true);
  assert.equal(session.logFile, join(session.runDir, "prompts.json"));
});

test("default non-interactive mode persists the original invocation metadata", () => {
  const originalArgv = process.argv;
  process.argv = [originalArgv[0] ?? "node", "/tmp/select-fit-tests.ts", "--root", "/ws", "status"];

  try {
    const session = PromptSession.fromArgv(process.argv.slice(2));
    const log = JSON.parse(readFileSync(session.logFile, "utf8")) as {
      invocation?: { entrypoint: string; args: string[] };
    };

    // The entrypoint lives outside the repo, so it stays absolute; cwd is no
    // longer recorded.
    assert.deepEqual(log.invocation, {
      entrypoint: "/tmp/select-fit-tests.ts",
      args: ["--root", "/ws", "status"],
    });
  } finally {
    process.argv = originalArgv;
  }
});

test("default non-interactive mode records an in-repo entrypoint relative to the repo root", () => {
  const originalArgv = process.argv;
  const entrypoint = join(REPO_ROOT, "src/main.ts");
  process.argv = [originalArgv[0] ?? "node", entrypoint, "status"];

  try {
    const session = PromptSession.fromArgv(process.argv.slice(2));
    const log = JSON.parse(readFileSync(session.logFile, "utf8")) as {
      invocation?: { entrypoint: string; args: string[] };
    };

    assert.deepEqual(log.invocation, {
      entrypoint: "src/main.ts",
      args: ["status"],
    });
  } finally {
    process.argv = originalArgv;
  }
});

test("interactive mode can serialize a prompt response before saving it", async () => {
  const session = PromptSession.fromArgv(["--interactive"]);

  const response = await session.resolvePrompt(
    "fit.tests.select",
    "checkbox",
    "Which tests?",
    () => Promise.resolve(["a", "b"]),
    { serializeResponse: () => "All FIT tests selected" },
  );
  assert.deepEqual(response, ["a", "b"]);

  const log = JSON.parse(readFileSync(session.logFile, "utf8")) as {
    prompts: Array<{ id: string; kind: string; message: string; response: string }>;
  };
  assert.deepEqual(log.prompts, [
    {
      id: "fit.tests.select",
      kind: "checkbox",
      message: "Which tests?",
      response: "All FIT tests selected",
    },
  ]);
});

test("prompt sessions format a run directory reminder", () => {
  const session = PromptSession.fromArgv([]);

  assert.equal(session.formatRunReminder(), `Run files:\n  ARTIFACT_DIR: ${session.runDir}`);
});

test("interactive sessions persist the chosen workflow", () => {
  const session = PromptSession.fromArgv([]);
  session.setWorkflow("run-definition");

  const log = JSON.parse(readFileSync(session.logFile, "utf8")) as {
    workflow?: string;
  };
  assert.equal(log.workflow, "run-definition");
});

test("replay mode reuses saved prompt responses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-replay-"));
  const logFile = join(dir, "run.json");
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        version: 1,
        createdAt: "2026-06-03T00:00:00.000Z",
        prompts: [
          {
            id: "fit.grpc.build-now",
            kind: "confirm",
            message: "Build FIT now?",
            response: true,
          },
        ],
      },
      null,
      2,
    ),
  );

  let response: boolean | undefined;
  const logs = await captureLogs(async () => {
    const session = PromptSession.fromArgv(["--replay", logFile]);
    response = await session.resolvePrompt("fit.grpc.build-now", "confirm", "Build FIT now?", () =>
      Promise.resolve(false),
    );
    assert.equal(session.formatRunReminder(), `Run files:\n  ARTIFACT_DIR: ${session.runDir}`);
  });

  assert.equal(response, true);
  assert.equal(logs.at(-1), "[replay] Build FIT now?\n  -> true");
});

test("replay mode hides password values in console output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-replay-"));
  const logFile = join(dir, "password.json");
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        version: 1,
        createdAt: "2026-06-03T00:00:00.000Z",
        prompts: [
          {
            id: "cluster.credentials.password",
            kind: "password",
            message: "Password to test with:",
            response: "super-secret",
          },
        ],
      },
      null,
      2,
    ),
  );

  const logs = await captureLogs(async () => {
    const session = PromptSession.fromArgv(["--replay", logFile]);
    const response = await session.resolvePrompt(
      "cluster.credentials.password",
      "password",
      "Password to test with:",
      () => Promise.resolve("unused"),
    );
    assert.equal(response, "super-secret");
  });

  assert.equal(logs.at(-1), "[replay] Password to test with:\n  -> [hidden]");
});

test("replay mode can deserialize a stored prompt response", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-replay-"));
  const logFile = join(dir, "checkbox.json");
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        version: 1,
        createdAt: "2026-06-03T00:00:00.000Z",
        prompts: [
          {
            id: "fit.tests.select",
            kind: "checkbox",
            message: "Which tests?",
            response: "All FIT tests selected",
          },
        ],
      },
      null,
      2,
    ),
  );

  const session = PromptSession.fromArgv(["--replay", logFile]);
  const response = await session.resolvePrompt(
    "fit.tests.select",
    "checkbox",
    "Which tests?",
    () => Promise.resolve([]),
    {
      deserializeResponse: (stored) => (stored === "All FIT tests selected" ? ["a", "b"] : []),
    },
  );

  assert.deepEqual(response, ["a", "b"]);
});

test("replay defaults mode asks live with the saved answer as the default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-replay-"));
  const logFile = join(dir, "defaults.json");
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        version: 1,
        createdAt: "2026-06-03T00:00:00.000Z",
        prompts: [
          {
            id: "fit.grpc.build-now",
            kind: "confirm",
            message: "Build FIT now?",
            response: true,
          },
        ],
      },
      null,
      2,
    ),
  );

  let replayDefault: boolean | undefined;
  let response: boolean | undefined;
  const logs = await captureLogs(async () => {
    const session = PromptSession.fromArgv(["--defaults", logFile]);
    response = await session.resolvePrompt(
      "fit.grpc.build-now",
      "confirm",
      "Build FIT now?",
      (savedDefault) => {
        replayDefault = savedDefault;
        return Promise.resolve(false);
      },
    );
  });

  assert.equal(replayDefault, true);
  assert.equal(response, false);
  assert.equal(logs.at(-1), "[replay defaults] Build FIT now?\n  -> true");
});

test("replay defaults mode defers stale saved prompts until finishReplay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-replay-"));
  const logFile = join(dir, "stale-defaults.json");
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        version: 1,
        createdAt: "2026-06-03T00:00:00.000Z",
        prompts: [
          {
            id: "old.prompt",
            kind: "confirm",
            message: "Old prompt?",
            response: true,
          },
          {
            id: "fit.grpc.build-now",
            kind: "confirm",
            message: "Build FIT now?",
            response: false,
          },
        ],
      },
      null,
      2,
    ),
  );

  let replayDefault: boolean | undefined;
  let askedAboutUnused = false;
  const session = PromptSession.fromArgv(["--defaults", logFile], {
    onUnusedReplayPrompts: (entries) => {
      askedAboutUnused = true;
      assert.deepEqual(entries.map((entry) => entry.id), ["old.prompt"]);
      return Promise.resolve("continue" as const);
    },
  });
  const response = await session.resolvePrompt("fit.grpc.build-now", "confirm", "Build FIT now?", (savedDefault) => {
    replayDefault = savedDefault as boolean | undefined;
    return Promise.resolve((savedDefault as boolean | undefined) ?? true);
  });

  assert.equal(replayDefault, false);
  assert.equal(response, false);
  assert.equal(askedAboutUnused, false);
  await session.finishReplay();
  assert.equal(askedAboutUnused, true);
});

test("replay mode asks live when a prompt id is missing from the log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-replay-"));
  const logFile = join(dir, "missing.json");
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        version: 1,
        createdAt: "2026-06-03T00:00:00.000Z",
        prompts: [],
      },
      null,
      2,
    ),
  );

  const logs = await captureLogs(async () => {
    const session = PromptSession.fromArgv(["--replay", logFile]);
    const response = await session.resolvePrompt("sdk.choose", "input", "Which SDK?", () =>
      Promise.resolve("go"),
    );
    assert.equal(response, "go");
  });

  assert.equal(logs.at(-1), "[replay] No saved answer for sdk.choose; asking now.");
});

test("replay mode can continue after extra saved answers are ignored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-replay-"));
  const logFile = join(dir, "extra.json");
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        version: 1,
        createdAt: "2026-06-03T00:00:00.000Z",
        prompts: [
          {
            id: "old.prompt",
            kind: "confirm",
            message: "Old prompt?",
            response: true,
          },
          {
            id: "fit.grpc.build-now",
            kind: "confirm",
            message: "Build FIT now?",
            response: false,
          },
        ],
      },
      null,
      2,
    ),
  );

  const session = PromptSession.fromArgv(["--replay", logFile], {
    onUnusedReplayPrompts: (entries) => {
      assert.deepEqual(entries.map((entry) => entry.id), ["old.prompt"]);
      return Promise.resolve("continue" as const);
    },
  });
  const response = await session.resolvePrompt("fit.grpc.build-now", "confirm", "Build FIT now?", () =>
    Promise.resolve(true),
  );

  assert.equal(response, false);
});

test("finishReplay can stop when unused saved answers remain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-replay-"));
  const logFile = join(dir, "trailing-extra.json");
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        version: 1,
        createdAt: "2026-06-03T00:00:00.000Z",
        prompts: [
          {
            id: "old.prompt",
            kind: "confirm",
            message: "Old prompt?",
            response: true,
          },
        ],
      },
      null,
      2,
    ),
  );

  const session = PromptSession.fromArgv(["--replay", logFile], {
    onUnusedReplayPrompts: () => Promise.resolve("exit" as const),
  });

  await assert.rejects(() => session.finishReplay(), /Replay stopped because the log contains answers/);
});

test("replay mode loads stored workflow metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-replay-"));
  const logFile = join(dir, "workflow.json");
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        version: 1,
        createdAt: "2026-06-03T00:00:00.000Z",
        workflow: "create-definition",
        prompts: [],
      },
      null,
      2,
    ),
  );

  const session = PromptSession.fromArgv(["--replay", logFile]);
  assert.equal(session.getWorkflow(), "create-definition");
});

test("replay mode loads stored invocation metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-replay-"));
  const logFile = join(dir, "invocation.json");
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        version: 1,
        createdAt: "2026-06-03T00:00:00.000Z",
        invocation: {
          entrypoint: "src/workflows/fit-functional/select-fit-tests/index.ts",
          args: ["--root", "/workspace"],
        },
        prompts: [],
      },
      null,
      2,
    ),
  );

  const session = PromptSession.fromArgv(["--replay", logFile]);
  assert.deepEqual(session.getInvocation(), {
    entrypoint: "src/workflows/fit-functional/select-fit-tests/index.ts",
    args: ["--root", "/workspace"],
  });
});

test("sanitizePathSeg replaces colons with hyphens", () => {
  assert.equal(sanitizePathSeg("EA:2.2.0-1166"), "EA-2.2.0-1166");
  assert.equal(sanitizePathSeg("java:main"), "java-main");
  assert.equal(sanitizePathSeg("functional:cng"), "functional-cng");
  assert.equal(sanitizePathSeg("no-colons"), "no-colons");
});

test("sanitizePathSeg strips path separators and dot-dot sequences", () => {
  assert.ok(!sanitizePathSeg("../../etc/passwd").includes(".."));
  assert.ok(!sanitizePathSeg("../../etc/passwd").includes("/"));
  assert.ok(!sanitizePathSeg("..").includes(".."));
  assert.ok(!sanitizePathSeg("a/b\\c").includes("/"));
  assert.ok(!sanitizePathSeg("a/b\\c").includes("\\"));
  assert.equal(sanitizePathSeg("7.6-stable"), "7.6-stable");
});

test("clusterRunDir sanitizes colons in the cluster segment", () => {
  const runDir = mkdtempSync(join(tmpdir(), "fit-test-"));
  const path = { instanceIndex: 0, clusterIndex: 0, dirSegments: { instance: "aws1", cluster: "EA:2.2.0-1166" } };
  assert.ok(clusterRunDir(path, runDir).endsWith("/clusters/EA-2.2.0-1166"));
});

test("sessionRunDir sanitizes colons in the session segment", () => {
  const runDir = mkdtempSync(join(tmpdir(), "fit-test-"));
  const path = { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0, dirSegments: { instance: "aws1", cluster: "8.0.0", session: "java:main" } };
  assert.ok(sessionRunDir(path, runDir).endsWith("/sessions/java-main"));
});
