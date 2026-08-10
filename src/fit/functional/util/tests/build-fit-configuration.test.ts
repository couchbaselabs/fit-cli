/**
 * Unit tests for buildFitConfiguration.
 *
 * Run on their own:
 *   bun test
 *   node --import tsx --test src/workflows/fit-functional/util/tests/build-fit-configuration.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTO_GENERATED_MARKER,
  buildFitConfiguration,
  firstHostname,
  resourceCreationPiece,
  runtimeFitConfigurationPiece,
} from "../build-fit-configuration.js";

const credentials = { username: "Administrator", password: "password" };

test("every generated config carries the auto-generated marker", () => {
  const config = buildFitConfiguration({
    scheme: "couchbase",
    defaultHostname: "localhost",
    flavour: "self-managed",
    credentials,
    tls: null,
  });
  assert.equal(config["//"], AUTO_GENERATED_MARKER);
});

test("performerPorts defaults to 8060 and reflects a custom port", () => {
  const cluster = {
    scheme: "couchbase",
    defaultHostname: "localhost",
    flavour: "self-managed",
    credentials,
    tls: null,
  } as const;
  assert.deepEqual(buildFitConfiguration(cluster).performerPorts, [8060]);
  assert.deepEqual(buildFitConfiguration(cluster, 9001).performerPorts, [9001]);
});

test("a self-managed cluster uses the localhost layout", () => {
  const config = buildFitConfiguration({
    scheme: "couchbase",
    defaultHostname: "localhost",
    flavour: "self-managed",
    credentials,
    tls: null,
  });

  const access = config.clusterAccess as Record<string, unknown>;
  assert.equal(access.connectionString, "couchbase://${defaultHostname}");
  assert.deepEqual(access.rest, { hostname: "localhost", resolveDnsSrv: false });
  assert.deepEqual(access.proxy, {
    "//": "The performer is running in Docker and needs to be able to connect to the FIT proxy (the test-driver) running on the host machine",
    hostname: "host.docker.internal",
  });
  assert.equal(config.skipBucketCreation, undefined);
  assert.deepEqual(config.excludeTests, ["situational"]);
});

test("a Capella cluster resolves DNS SRV, skips bucket creation and drops the proxy", () => {
  const config = buildFitConfiguration({
    scheme: "couchbases",
    defaultHostname: "cb.abc.cloud.couchbase.com",
    flavour: "production-capella",
    credentials,
    tls: null,
  });

  const access = config.clusterAccess as Record<string, unknown>;
  assert.equal(access.connectionString, "couchbases://${defaultHostname}");
  assert.deepEqual(access.rest, { hostname: "${defaultHostname}", resolveDnsSrv: true, port: 18091 });
  assert.equal(access.proxy, null);
  assert.equal(config.skipBucketCreation, true);
  assert.deepEqual(config.excludeTests, ["situational", "ssh", "realCapella"]);
});

test("a local run against Capella also excludes requiresLowLatencyConnection tests", () => {
  const cluster = {
    scheme: "couchbases",
    defaultHostname: "cb.abc.cloud.couchbase.com",
    flavour: "production-capella",
    credentials,
    tls: null,
  } as const;

  assert.deepEqual(buildFitConfiguration(cluster).excludeTests, ["situational", "ssh", "realCapella"]);
  assert.deepEqual(
    buildFitConfiguration(cluster, undefined, undefined, undefined, undefined, false, true).excludeTests,
    ["situational", "ssh", "realCapella", "requiresLowLatencyConnection"],
  );
});

test("a local self-managed run does not exclude requiresLowLatencyConnection tests (Capella-only concern)", () => {
  const cluster = {
    scheme: "couchbase",
    defaultHostname: "localhost",
    flavour: "self-managed",
    credentials,
    tls: null,
  } as const;

  assert.deepEqual(
    buildFitConfiguration(cluster, undefined, undefined, undefined, undefined, false, true).excludeTests,
    ["situational"],
  );
});

test("the tls choice is passed straight through", () => {
  const config = buildFitConfiguration({
    scheme: "couchbases",
    defaultHostname: "cb.abc.nonprod-project-avengers.com",
    flavour: "internal-capella",
    credentials,
    tls: { insecure: true },
  });
  const access = config.clusterAccess as Record<string, unknown>;
  assert.deepEqual(access.tls, { insecure: true });
});

test("a CNG cluster uses a flat couchbase2 connectionString (no driver/performer split)", () => {
  const config = buildFitConfiguration({
    scheme: "couchbases",
    defaultHostname: "ui-host:443",
    flavour: "self-managed",
    credentials,
    tls: { insecure: true },
    cng: { performerConnectionString: "couchbase2://cng-host", tls: { insecure: true } },
  });

  const access = config.clusterAccess as Record<string, unknown>;
  assert.equal(access.defaultHostname, "ui-host:443");
  // Flat connectionString using the couchbase2 performer URL — no driver/performer split.
  assert.equal(access.connectionString, "couchbase2://cng-host");
  assert.deepEqual(access.tls, { insecure: true });
  // No classic driver or performer blocks.
  assert.equal(access.driver, undefined);
  assert.equal(access.performer, undefined);
  // The FIT proxy doesn't support couchbase2 yet, and DNS SRV is off for CNG.
  assert.equal(access.proxy, null);
  // rest.hostname strips the :443 port; rest.port carries it explicitly.
  assert.deepEqual(access.rest, { hostname: "ui-host", resolveDnsSrv: false, port: 443 });
  assert.equal(config["//"], AUTO_GENERATED_MARKER);
  assert.deepEqual(config.excludeTests, ["situational"]);
  // skipBucketCreation: the test-driver must not try to create buckets over classic.
  assert.equal(config.skipBucketCreation, true);
});

test("a definition fitConfig piece can override defaults while runtime fields still win", () => {
  const config = buildFitConfiguration(
    {
      scheme: "couchbase",
      defaultHostname: "actual-host",
      flavour: "self-managed",
      credentials,
      tls: null,
    },
    9001,
    {
      excludeTests: ["openshift"],
      clusterAccess: {
        connectionString: "couchbase://user-host",
        username: "custom-user",
        password: "custom-password",
        defaultHostname: "stale-host",
      },
    },
  );

  const access = config.clusterAccess as Record<string, unknown>;
  assert.deepEqual(config.excludeTests, ["openshift"]);
  assert.deepEqual(config.performerPorts, [9001]);
  assert.equal(access.connectionString, "couchbase://user-host");
  assert.equal(access.username, "custom-user");
  assert.equal(access.password, "custom-password");
  assert.equal(access.defaultHostname, "actual-host");
});

test("when fitConfig has ${defaultHostname} for rest.hostname, runtime piece corrects it to the first IP", () => {
  const config = buildFitConfiguration(
    {
      scheme: "couchbase",
      defaultHostname: "172.18.0.2,172.18.0.4,172.18.0.3",
      flavour: "self-managed",
      credentials,
      tls: null,
    },
    8060,
    {
      clusterAccess: {
        connectionString: "couchbase://${defaultHostname}",
        rest: { hostname: "${defaultHostname}", resolveDnsSrv: false },
      },
    },
  );

  const access = config.clusterAccess as Record<string, unknown>;
  assert.equal(access.defaultHostname, "172.18.0.2,172.18.0.4,172.18.0.3");
  assert.deepEqual(access.rest, { hostname: "172.18.0.2", resolveDnsSrv: false });
});

test("runtimeFitConfigurationPiece patches both defaultHostname and rest.hostname", () => {
  const piece = runtimeFitConfigurationPiece({
    scheme: "couchbase",
    defaultHostname: "172.18.0.2,172.18.0.4,172.18.0.3",
    flavour: "self-managed",
    credentials,
    tls: null,
  });

  const access = (piece.data.clusterAccess as Record<string, unknown>);
  assert.equal(access.defaultHostname, "172.18.0.2,172.18.0.4,172.18.0.3");
  assert.deepEqual(access.rest, { hostname: "172.18.0.2" });
});

test("runtimeFitConfigurationPiece splits host:port into rest.hostname and rest.port", () => {
  const piece = runtimeFitConfigurationPiece({
    scheme: "couchbases",
    defaultHostname: "ui-host:443",
    flavour: "self-managed",
    credentials,
    tls: { insecure: true },
  });

  const access = piece.data.clusterAccess as Record<string, unknown>;
  assert.equal(access.defaultHostname, "ui-host:443");
  assert.deepEqual(access.rest, { hostname: "ui-host", port: 443 });
});

test("a multi-node self-managed cluster uses only the first IP for rest.hostname", () => {
  const config = buildFitConfiguration({
    scheme: "couchbase",
    defaultHostname: "172.18.0.2,172.18.0.4,172.18.0.3",
    flavour: "self-managed",
    credentials,
    tls: null,
  });

  const access = config.clusterAccess as Record<string, unknown>;
  assert.equal(access.defaultHostname, "172.18.0.2,172.18.0.4,172.18.0.3");
  assert.equal(access.connectionString, "couchbase://${defaultHostname}");
  assert.deepEqual(access.rest, { hostname: "172.18.0.2", resolveDnsSrv: false });
});

test("firstHostname extracts the first host from a comma-separated list", () => {
  assert.equal(firstHostname("172.18.0.2,172.18.0.4,172.18.0.3"), "172.18.0.2");
  assert.equal(firstHostname("localhost"), "localhost");
  assert.equal(firstHostname("  host1 , host2 "), "host1");
});

test("resourceCreationPiece enables cluster-creating tests with both mandatory keys", () => {
  const piece = resourceCreationPiece({
    cbdinoclusterPath: "/home/ubuntu/.local/bin/cbdinocluster",
    version: "8.0.1-4654",
  });

  const resourceCreation = piece.resourceCreation as Record<string, unknown>;
  const cluster = resourceCreation.cluster as Record<string, unknown>;
  assert.deepEqual(cluster.cbdinocluster, { path: "/home/ubuntu/.local/bin/cbdinocluster" });
  assert.deepEqual(cluster.preferredCluster, { version: "8.0.1-4654" });
});

test("an analytics config skips bucket creation and lets the definition's clusterAccess merge over", () => {
  const config = buildFitConfiguration(
    {
      scheme: "couchbase",
      defaultHostname: "localhost",
      flavour: "self-managed",
      credentials,
      tls: null,
    },
    8060,
    // The definition's fitConfig.config: the analytics endpoint + load balancer (TLS).
    {
      clusterAccess: {
        clusterParams: { loadBalancedCluster: { ports: [8095, 18095] } },
        performer: { connectionString: "couchbases://${defaultHostname}", tls: { insecure: true } },
      },
    },
    undefined,
    undefined,
    true,
  );

  // Analytics manages its own data — no KV bucket to create.
  assert.equal(config.skipBucketCreation, true);
  assert.equal("bucketConfig" in config, false);
  assert.deepEqual(config.excludeTests, ["situational"]);

  const access = config.clusterAccess as Record<string, unknown>;
  assert.deepEqual(access.clusterParams, { loadBalancedCluster: { ports: [8095, 18095] } });
  assert.deepEqual(access.performer, { connectionString: "couchbases://${defaultHostname}", tls: { insecure: true } });
  // The generated baseline is still present (and not overwritten by the merge).
  assert.equal(access.ssh, null);
  // The performer runs in Docker, so it reaches the host's FIT proxy via
  // host.docker.internal (localhost would resolve to the container itself).
  assert.deepEqual(access.proxy, { hostname: "host.docker.internal" });
});

test("an Analytics load-balancer host rewrites the performer host (not the driver's), preserving scheme/port", () => {
  // The EA SDK over http://...:8095 — FIT would resolve ${defaultHostname} to the
  // multi-seed node list, which an HTTP URL can't take; the LB host fixes it.
  const eaConfig = buildFitConfiguration(
    {
      scheme: "couchbase",
      defaultHostname: "172.18.0.5,172.18.0.4,172.18.0.6",
      flavour: "self-managed",
      credentials,
      tls: null,
      analyticsLoadBalancerHost: "172.18.0.3",
    },
    8060,
    { clusterAccess: { performer: { connectionString: "http://${defaultHostname}:8095", tls: null } } },
    undefined,
    undefined,
    true,
  );
  const eaAccess = eaConfig.clusterAccess as Record<string, unknown>;
  assert.deepEqual(eaAccess.performer, { connectionString: "http://172.18.0.3:8095", tls: null });
  // The driver keeps the multi-seed node list (couchbase:// handles it).
  assert.equal(eaAccess.connectionString, "couchbase://${defaultHostname}");
  // The FIT proxy must forward to the single LB host, not the node list (which it
  // can't dial as a comma-separated string).
  assert.deepEqual(eaAccess.proxy, { hostname: "host.docker.internal", clusterHostname: "172.18.0.3" });

  // A Columnar SDK's couchbases:// scheme is preserved — only the host is rewritten.
  const columnarConfig = buildFitConfiguration(
    {
      scheme: "couchbase",
      defaultHostname: "172.18.0.5,172.18.0.4,172.18.0.6",
      flavour: "self-managed",
      credentials,
      tls: null,
      analyticsLoadBalancerHost: "172.18.0.3",
    },
    8060,
    { clusterAccess: { performer: { connectionString: "couchbases://${defaultHostname}", tls: { insecure: true } } } },
    undefined,
    undefined,
    true,
  );
  const columnarAccess = columnarConfig.clusterAccess as Record<string, unknown>;
  assert.deepEqual(columnarAccess.performer, { connectionString: "couchbases://172.18.0.3", tls: { insecure: true } });
});

test("no Analytics load-balancer host leaves the performer's ${defaultHostname} token untouched", () => {
  const config = buildFitConfiguration(
    {
      scheme: "couchbase",
      defaultHostname: "172.18.0.5,172.18.0.4,172.18.0.6",
      flavour: "self-managed",
      credentials,
      tls: null,
    },
    8060,
    { clusterAccess: { performer: { connectionString: "http://${defaultHostname}:8095", tls: null } } },
    undefined,
    undefined,
    true,
  );
  const access = config.clusterAccess as Record<string, unknown>;
  assert.deepEqual(access.performer, { connectionString: "http://${defaultHostname}:8095", tls: null });
});
