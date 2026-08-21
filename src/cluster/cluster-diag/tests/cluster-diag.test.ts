/**
 * Unit tests for clusterDiagUrl.
 *
 * Run on their own:
 *   bun test
 *   node --import tsx --test src/workflows/cluster/cluster-diag/tests/cluster-diag.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clusterDiagUrl } from "../cluster-diag.js";
import type { SelectedCluster } from "../../cluster-select/cluster-select.js";

function cluster(overrides: Partial<SelectedCluster>): SelectedCluster {
  return {
    scheme: "couchbase",
    defaultHostname: "127.0.0.1",
    flavour: "self-managed",
    credentials: { username: "Administrator", password: "password" },
    tls: null,
    ...overrides,
  };
}

test("couchbase clusters use the insecure management endpoint", () => {
  assert.equal(clusterDiagUrl(cluster({})), "http://127.0.0.1:8091/pools/default");
});

test("couchbases clusters use the secure management endpoint", () => {
  assert.equal(
    clusterDiagUrl(cluster({ scheme: "couchbases", defaultHostname: "cb.example.com" })),
    "https://cb.example.com:18091/pools/default",
  );
});

test("an existing KV port is replaced by the management port", () => {
  assert.equal(
    clusterDiagUrl(cluster({ defaultHostname: "10.1.2.3:11210" })),
    "http://10.1.2.3:8091/pools/default",
  );
});

test("only the first host from a multi-host connection string is used", () => {
  assert.equal(
    clusterDiagUrl(cluster({ defaultHostname: "10.1.2.3,10.1.2.4" })),
    "http://10.1.2.3:8091/pools/default",
  );
});

test("successful sanity tests print the command and success line", () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-curl-"));
  const curl = join(dir, "curl");
  const modulePath = new URL("../cluster-diag.ts", import.meta.url).href;

  writeFileSync(curl, "#!/bin/sh\necho '{\"name\":\"default\"}'\n");
  chmodSync(curl, 0o755);

  const driver = [
    `import { runClusterDiag } from ${JSON.stringify(modulePath)};`,
    `await runClusterDiag(${JSON.stringify(cluster({ defaultHostname: "172.18.0.2" }))});`,
  ].join("\n");

  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", driver], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Cluster sanity test succeeded with/);
  assert.match(result.stdout, /curl -k -f --connect-timeout 5 -u <username>:<password> -X GET http:\/\/172\.18\.0\.2:8091\/pools\/default/);
  assert.doesNotMatch(result.stdout, /Sanity-testing the cluster with/);
  assert.doesNotMatch(result.stdout, /"name":"default"/);
});

test("failed sanity tests still show the command and error", () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-curl-"));
  const curl = join(dir, "curl");
  const modulePath = new URL("../cluster-diag.ts", import.meta.url).href;

  writeFileSync(curl, "#!/bin/sh\necho 'curl: (7) Failed to connect' >&2\nexit 7\n");
  chmodSync(curl, 0o755);

  const driver = [
    `import { runClusterDiag } from ${JSON.stringify(modulePath)};`,
    `const ok = await runClusterDiag(${JSON.stringify(cluster({ defaultHostname: "172.18.0.2" }))}, { retryTimeoutMs: 0 });`,
    `process.exit(ok ? 0 : 1);`,
  ].join("\n");

  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", driver], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Sanity-testing the cluster with/);
  assert.match(result.stderr, /curl exited with code 7: curl: \(7\) Failed to connect/);
});

test("the sanity test now passes -f, so a route-error HTTP response fails it rather than passing", () => {
  // Regression test for the bug this fixes: an OpenShift/nginx route can be up but
  // return an HTML "Application is not available" page for a backend that's briefly
  // down. Without -f, curl exits 0 for any HTTP response (even 503), so the sanity
  // check falsely passed. This stub emulates curl's actual -f behaviour (exit 22,
  // nothing on stdout, error on stderr) to confirm the caller now treats it as a
  // failure — real curl's -f semantics are curl's own well-tested behaviour, not
  // something this suite needs to re-verify.
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-curl-"));
  const curl = join(dir, "curl");
  const modulePath = new URL("../cluster-diag.ts", import.meta.url).href;

  writeFileSync(
    curl,
    [
      "#!/bin/sh",
      "# Simulates curl -f against a backend returning a 503 HTML error page.",
      "if ! echo \"$@\" | grep -q -- '-f'; then echo 'test stub expected -f' >&2; exit 99; fi",
      "echo 'curl: (22) The requested URL returned error: 503' >&2",
      "exit 22",
    ].join("\n"),
  );
  chmodSync(curl, 0o755);

  const driver = [
    `import { runClusterDiag } from ${JSON.stringify(modulePath)};`,
    `const ok = await runClusterDiag(${JSON.stringify(cluster({ defaultHostname: "172.18.0.2" }))}, { retryTimeoutMs: 0 });`,
    `process.exit(ok ? 0 : 1);`,
  ].join("\n");

  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", driver], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /curl exited with code 22: curl: \(22\) The requested URL returned error: 503/);
});
