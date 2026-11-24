/**
 * Local-only preflight: if this machine's `~/.cbdinocluster` has the Capella (cloud)
 * deployer enabled, check its configured endpoint is actually reachable before letting
 * situational tests call `cbdinocluster allocate --deployer cloud`.
 *
 * Without this, an unreachable endpoint only surfaces deep inside the JVM test, after
 * `cbdinocluster allocate`'s own retries (3 attempts, exponential backoff) are exhausted —
 * a bare "connection refused" stack trace with no guidance. The most common cause: the
 * endpoint points at cbclocal's local mock Capella control plane (typically
 * `http://localhost:8080`), but cbclocal isn't running.
 *
 * Run on its own:
 *   bun src/fit/functional/util/check-local-capella-control-plane.ts
 */
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { isMain, runCli } from "../../../util/non-fit/cli.js";

export const CBDINOCLUSTER_LOCAL_CONFIG_PATH = join(homedir(), ".cbdinocluster");

export type LocalCapellaEndpointCheck =
  | { checked: false }
  | { checked: true; ok: true; endpoint: string }
  | { checked: true; ok: false; endpoint: string; message: string };

/** TCP connectivity probe with a timeout — no external binary dependency (unlike `nc`). */
function tcpReachable(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * Reads this machine's `~/.cbdinocluster` and, if the Capella (cloud) deployer is
 * enabled with an endpoint configured, probes it. Returns `{checked: false}` when
 * there's nothing useful to check here (no config yet, capella not enabled, or the
 * endpoint is missing/malformed) — a different check is responsible for those cases
 * (e.g. `cbdinoclusterNeedsInit`).
 */
export async function checkLocalCapellaEndpointReachable(
  configPath: string = CBDINOCLUSTER_LOCAL_CONFIG_PATH,
  timeoutMs = 3000,
): Promise<LocalCapellaEndpointCheck> {
  let config: unknown;
  try {
    config = YAML.parse(readFileSync(configPath, "utf8"));
  } catch {
    return { checked: false };
  }
  if (config === null || typeof config !== "object") {
    return { checked: false };
  }
  const capella = (config as Record<string, unknown>).capella;
  if (capella === null || typeof capella !== "object") {
    return { checked: false };
  }
  const capellaBlock = capella as Record<string, unknown>;
  if (capellaBlock.enabled !== "true" || typeof capellaBlock.endpoint !== "string") {
    return { checked: false };
  }

  const endpoint = capellaBlock.endpoint;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { checked: false };
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;

  if (await tcpReachable(url.hostname, port, timeoutMs)) {
    return { checked: true, ok: true, endpoint };
  }

  const looksLikeCbclocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return {
    checked: true,
    ok: false,
    endpoint,
    message:
      `Can't reach ${endpoint} — ${configPath} has the Capella (cloud) deployer enabled pointing there, ` +
      `but nothing answered.${
        looksLikeCbclocal
          ? " This looks like cbclocal's local mock Capella control plane — start cbclocal, or reconfigure capella.endpoint."
          : ""
      } Situational tests need this to allocate a Capella cluster; fix capella.endpoint in ${configPath}, ` +
      "or run `cbdinocluster init` again.",
  };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const result = await checkLocalCapellaEndpointReachable();
    if (!result.checked) {
      console.log("✓ No local Capella (cloud) deployer endpoint to check.");
    } else if (result.ok) {
      console.log(`✓ Reached ${result.endpoint}.`);
    } else {
      console.error(`✗ ${result.message}`);
    }
    return { artifacts: [], details: [] };
  });
}
