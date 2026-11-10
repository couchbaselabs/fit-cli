/**
 * Step: start one SDK's performer and ask it what it can do.
 *
 * Pulls the performer image if it isn't already local, runs it on a throwaway port,
 * calls the performerCapsFetch RPC, and stops the container again. Nothing here
 * touches a cluster — the performer answers this RPC before it has connected to
 * anything — so it's cheap and safe to run for every SDK at once.
 *
 * Run on its own:
 *   bun src/fit/caps/fetch-caps/fetch-caps.ts java
 *   bun src/fit/caps/fetch-caps/fetch-caps.ts java --tag main
 *   bun src/fit/caps/fetch-caps/fetch-caps.ts --help
 */
import { rmSync, writeFileSync } from "node:fs";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../../util/non-fit/fit-cli-log.js";
import { capture, run } from "../../../util/non-fit/proc.js";
import { createRunFilePath } from "../../../util/non-fit/replay.js";
import { sdkByValue, type Sdk } from "../../../util/sdk/sdks.js";
import { resolveGithubToken } from "../../util/config.js";
import { dockerLoginCommand, dockerPullArgs } from "../../performers/check-and-pull-performer/check-and-pull-performer.js";
import { performerImageName } from "../../performers/util/performer-image.js";
import { DEFAULT_PERFORMER_PORT } from "../../performers/util/performer-port.js";
import type { CapsFetchResult } from "../util/caps-table.js";
import { fetchPerformerCaps, isUnimplemented, type PerformerCaps } from "../util/performer-caps-rpc.js";
import { isPerformerStatus } from "../../performers/util/performer-grpc.js";

/** How long to give a performer to come up and start serving gRPC. */
const STARTUP_TIMEOUT_MS = 90_000;
const STARTUP_POLL_MS = 500;

/** Build the docker args to run a performer detached for a caps fetch. */
export function capsPerformerRunArgs(sdk: Sdk, hostPort: number, containerName: string, tag?: string): string[] {
  return [
    "run",
    "--detach",
    "--rm",
    "--name",
    containerName,
    "--publish",
    `${hostPort}:${DEFAULT_PERFORMER_PORT}`,
    performerImageName(sdk, tag),
  ];
}

/** A container name that won't collide with a performer the user is already running. */
export function capsContainerName(sdk: Sdk): string {
  return `fit-cli-caps-${sdk.value}`;
}

/** Log Docker into GHCR, keeping the token off argv by piping it from a file. */
async function loginToGhcr(token: string): Promise<void> {
  const tokenPath = createRunFilePath("ghcr-token");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  try {
    await run("sh", ["-lc", dockerLoginCommand("docker", tokenPath)]);
  } finally {
    rmSync(tokenPath, { force: true });
  }
}

/**
 * Log Docker into GHCR once, up front, for a whole batch of SDKs.
 *
 * Without this the workers would each hit their own `docker login` at the same moment
 * and race each other. Returns whether login happened, to be passed to
 * {@link fetchCapsForSdk} as `loggedIn`.
 */
export async function ensureGhcrLogin(): Promise<boolean> {
  const token = await resolveGithubToken();
  if (!token) {
    throw new Error(
      "A GitHub token is needed to pull performer images from GHCR (needs read:packages). Set one with `fit config edit`.",
    );
  }
  await loginToGhcr(token);
  return true;
}

/** Pull the performer image, always refreshing a mutable tag rather than trusting a local copy. */
export async function ensurePerformerImage(sdk: Sdk, tag?: string, loggedIn = false): Promise<void> {
  const image = performerImageName(sdk, tag);

  if (!loggedIn) {
    await ensureGhcrLogin();
  }
  await run("docker", dockerPullArgs(image));
}

/** Wait for the performer to answer performerCapsFetch, retrying while it boots. */
async function awaitCaps(sdk: Sdk, port: number): Promise<PerformerCaps> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError: Error | undefined;

  for (;;) {
    try {
      return await fetchPerformerCaps("localhost", port);
    } catch (err) {
      // UNIMPLEMENTED is a real answer from a running performer, not a "still booting"
      // — retrying would just burn the whole timeout.
      if (isPerformerStatus(err)) throw err;
      lastError = err as Error;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${sdk.name} performer did not answer performerCapsFetch within ${STARTUP_TIMEOUT_MS / 1000}s: ${lastError?.message ?? "unknown error"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS));
  }
}

export interface FetchCapsOptions {
  /** Performer image tag. Defaults to `main`. */
  tag?: string;
  /** Host port to publish the performer on. */
  port?: number;
  /** Set once GHCR login has happened, so a fan-out only logs in once. */
  loggedIn?: boolean;
}

/**
 * Fetch one SDK's caps, always stopping the container it started.
 *
 * Never throws: a performer that can't be pulled, started or queried is a result in
 * its own right (that's most of what the table is telling you), so failure comes
 * back as a {@link CapsFetchResult} rather than aborting a sweep of ten SDKs.
 */
export async function fetchCapsForSdk(sdk: Sdk, options: FetchCapsOptions = {}): Promise<CapsFetchResult> {
  const port = options.port ?? DEFAULT_PERFORMER_PORT;
  const containerName = capsContainerName(sdk);
  let started = false;

  try {
    await ensurePerformerImage(sdk, options.tag, options.loggedIn);

    // A container left behind by an interrupted earlier run would hold the name.
    await capture("docker", ["rm", "--force", containerName], process.cwd(), { quiet: true }).catch(() => undefined);

    await run("docker", capsPerformerRunArgs(sdk, port, containerName, options.tag));
    started = true;

    const caps = await awaitCaps(sdk, port);
    return { sdk, status: "ok", caps };
  } catch (err) {
    if (isUnimplemented(err)) {
      return { sdk, status: "unimplemented" };
    }
    return { sdk, status: "error", error: (err as Error).message };
  } finally {
    if (started) {
      await capture("docker", ["rm", "--force", containerName], process.cwd(), { quiet: true }).catch(() => undefined);
    }
  }
}

function helpText(): string {
  return `Start one SDK's performer and fetch its FIT capabilities.

Usage:
  bun src/fit/caps/fetch-caps/fetch-caps.ts <sdk> [--tag <tag>] [--port <port>]

Arguments:
  <sdk>     The SDK to query, e.g. java, scala, cpp, go, rust.
  --tag     Performer image tag (default: main).
  --port    Host port to publish the performer on (default: ${DEFAULT_PERFORMER_PORT}).

For the full table across every SDK, use: ${runScriptPrefix("caps")} table`;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
      console.log(helpText());
      if (argv.length === 0) process.exit(2);
      return;
    }

    const sdkValue = argv[0];
    const sdk = sdkByValue(sdkValue);
    if (!sdk) {
      console.error(`Unknown SDK: ${sdkValue}`);
      process.exit(2);
    }

    const tagIndex = argv.indexOf("--tag");
    const portIndex = argv.indexOf("--port");
    const result = await fetchCapsForSdk(sdk, {
      tag: tagIndex === -1 ? undefined : argv[tagIndex + 1],
      port: portIndex === -1 ? undefined : Number(argv[portIndex + 1]),
    });

    if (result.status === "ok") {
      const { caps } = result;
      console.log(`\n✓ ${sdk.name}: ${caps.userAgent ?? "?"} (library ${caps.libraryVersion ?? "?"})`);
      console.log(`  sdk caps:          ${caps.sdkCaps.length}`);
      console.log(`  transactions caps: ${caps.transactionCaps.length}`);
      console.log(`  performer caps:    ${caps.performerCaps.length}`);
      return {
        details: [
          { label: `${sdk.name} user agent`, value: caps.userAgent ?? "unknown" },
          { label: `${sdk.name} library version`, value: caps.libraryVersion ?? "unknown" },
        ],
      };
    }

    const detail = result.status === "unimplemented" ? "does not implement performerCapsFetch" : result.error;
    console.error(`\n✗ ${sdk.name}: ${detail}`);
    process.exit(1);
  });
}
