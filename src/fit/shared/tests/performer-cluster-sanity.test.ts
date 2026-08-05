import assert from "node:assert/strict";
import test from "node:test";
import type { SelectedCluster } from "../../../cluster/cluster-select/cluster-select.js";
import {
  assessPerformerClusterSanity,
  buildSanityCluster,
  clusterDockerEnvironmentDetails,
  clusterHost,
  describeClusterDockerEnvironment,
  dockerInspectArgs,
  dockerPsIdsArgs,
  parsePerformerClusterSanityCliArgs,
  parseDockerInspect,
  parseDockerPsIds,
  type DockerContainerInspection,
} from "../util/performer-cluster-sanity.js";

function selfManagedCluster(defaultHostname: string): SelectedCluster {
  return {
    scheme: "couchbase",
    defaultHostname,
    flavour: "self-managed",
    credentials: { username: "Administrator", password: "password" },
    tls: null,
  };
}

function inspectedContainer(overrides: Partial<DockerContainerInspection>): DockerContainerInspection {
  return {
    id: "performer",
    name: "performer",
    hostname: "performer",
    networkMode: "bridge",
    networks: [{ name: "fit-net", ipAddress: "172.20.0.10", aliases: ["performer"] }],
    ...overrides,
  };
}

test("clusterHost keeps the first host and strips ports", () => {
  assert.equal(clusterHost("172.18.0.2:8091,172.18.0.3:8091"), "172.18.0.2");
  assert.equal(clusterHost("[::1]:8091"), "::1");
});

test("dockerPsIdsArgs lists running container ids", () => {
  assert.deepEqual(dockerPsIdsArgs(), ["ps", "-q"]);
});

test("parseDockerPsIds extracts non-empty ids", () => {
  assert.deepEqual(parseDockerPsIds("abc123\n\ndef456\n"), ["abc123", "def456"]);
});

test("dockerInspectArgs inspect the requested containers, projected to the fields we parse", () => {
  const args = dockerInspectArgs(["abc123", "def456"]);
  assert.equal(args[0], "inspect");
  assert.deepEqual(args.slice(2), ["abc123", "def456"]);
  // A full inspect is far larger than a remote transport reliably returns, so the
  // projection is the point of this call - assert it asks for one and only pulls the
  // fields parseDockerInspect reads.
  assert.ok(args[1].startsWith("--format="));
  for (const field of ["Id", "Name", "Hostname", "NetworkMode", "Networks"]) {
    assert.ok(args[1].includes(field), `expected --format to project ${field}`);
  }
});

test("parseDockerInspect accepts the one-object-per-line form --format emits", () => {
  const line = (id: string, network: string): string =>
    JSON.stringify({
      Id: id,
      Name: `/${id}`,
      Config: { Hostname: id },
      HostConfig: { NetworkMode: "fit" },
      NetworkSettings: { Networks: { [network]: { IPAddress: "172.18.0.2", Aliases: [] } } },
    });

  const parsed = parseDockerInspect(`${line("abc", "fit")}\n${line("def", "fit")}\n`);
  assert.deepEqual(parsed.map((container) => container.id), ["abc", "def"]);
  assert.deepEqual(parsed[0].networks, [{ name: "fit", ipAddress: "172.18.0.2", aliases: [] }]);
});

test("parsePerformerClusterSanityCliArgs shows help when no args are given", () => {
  assert.deepEqual(parsePerformerClusterSanityCliArgs([]), { kind: "help", exitCode: 2 });
});

test("parsePerformerClusterSanityCliArgs parses the connection string and performer id", () => {
  assert.deepEqual(
    parsePerformerClusterSanityCliArgs(["couchbase://172.18.0.2", "abc123"]),
    {
      kind: "run",
      connectionString: "couchbase://172.18.0.2",
      performerContainerId: "abc123",
      dockerCommand: "docker",
    },
  );
});

test("parsePerformerClusterSanityCliArgs accepts an alternate docker command", () => {
  assert.deepEqual(
    parsePerformerClusterSanityCliArgs(["couchbase://172.18.0.2", "abc123", "--docker", "/usr/bin/docker"]),
    {
      kind: "run",
      connectionString: "couchbase://172.18.0.2",
      performerContainerId: "abc123",
      dockerCommand: "/usr/bin/docker",
    },
  );
});

test("buildSanityCluster classifies the connection string for the standalone CLI", () => {
  assert.deepEqual(buildSanityCluster("couchbases://cb.example.com"), {
    scheme: "couchbases",
    defaultHostname: "cb.example.com",
    flavour: "self-managed",
    credentials: { username: "", password: "" },
    tls: { insecure: true },
  });
});

test("parseDockerInspect extracts container network metadata", () => {
  assert.deepEqual(
    parseDockerInspect(
      JSON.stringify([
        {
          Id: "abc123",
          Name: "/performer",
          Config: { Hostname: "performer" },
          HostConfig: { NetworkMode: "bridge" },
          NetworkSettings: {
            Networks: {
              "fit-net": {
                IPAddress: "172.20.0.10",
                Aliases: ["performer", "fit-performer"],
              },
            },
          },
        },
      ]),
    ),
    [
      {
        id: "abc123",
        name: "performer",
        hostname: "performer",
        networkMode: "bridge",
        networks: [
          {
            name: "fit-net",
            ipAddress: "172.20.0.10",
            aliases: ["performer", "fit-performer"],
          },
        ],
      },
    ],
  );
});

test("sanity check fails when the cluster host is loopback inside a bridged container", () => {
  const performer = inspectedContainer({});
  const result = assessPerformerClusterSanity(selfManagedCluster("localhost"), performer, [performer]);
  assert.equal(result.ok, false);
  assert.match(result.details[0]?.value ?? "", /loopback/);
});

test("sanity check passes when the performer uses Docker host networking for localhost", () => {
  const performer = inspectedContainer({ networkMode: "host", networks: [] });
  const result = assessPerformerClusterSanity(selfManagedCluster("127.0.0.1"), performer, [performer]);
  assert.equal(result.ok, true);
  assert.match(result.details[0]?.value ?? "", /host networking/);
});

test("sanity check passes when the cluster container shares a Docker network with the performer", () => {
  const performer = inspectedContainer({});
  const cluster = inspectedContainer({
    id: "cluster",
    name: "cluster",
    hostname: "cluster",
    networks: [{ name: "fit-net", ipAddress: "172.20.0.20", aliases: ["cluster"] }],
  });
  const result = assessPerformerClusterSanity(selfManagedCluster("172.20.0.20"), performer, [performer, cluster]);
  assert.equal(result.ok, true);
  assert.match(result.details[0]?.value ?? "", /share Docker network/);
});

test("describeClusterDockerEnvironment reports the cluster containers and networks", () => {
  const performer = inspectedContainer({});
  const cluster = inspectedContainer({
    id: "cluster",
    name: "cluster",
    hostname: "cluster",
    networks: [{ name: "fit-net", ipAddress: "172.20.0.20", aliases: ["cluster"] }],
  });
  assert.deepEqual(describeClusterDockerEnvironment(selfManagedCluster("172.20.0.20"), [performer, cluster]), {
    clusterHost: "172.20.0.20",
    containerNames: ["cluster"],
    networkNames: ["fit-net"],
  });
});

test("clusterDockerEnvironmentDetails formats the detected Docker environment", () => {
  assert.deepEqual(
    clusterDockerEnvironmentDetails({
      clusterHost: "172.20.0.20",
      containerNames: ["cluster-a", "cluster-b"],
      networkNames: ["fit-net"],
    }),
    [
      { label: "Cluster Docker host", value: "172.20.0.20" },
      { label: "Cluster Docker containers", value: "cluster-a, cluster-b" },
      { label: "Cluster Docker networks", value: "fit-net" },
    ],
  );
});

test("sanity check fails when the cluster container is on a different Docker network", () => {
  const performer = inspectedContainer({});
  const cluster = inspectedContainer({
    id: "cluster",
    name: "cluster",
    hostname: "cluster",
    networks: [{ name: "cluster-net", ipAddress: "172.21.0.20", aliases: ["cluster"] }],
  });
  const result = assessPerformerClusterSanity(selfManagedCluster("172.21.0.20"), performer, [performer, cluster]);
  assert.equal(result.ok, false);
  assert.match(result.details[0]?.value ?? "", /performer: fit-net; cluster: cluster-net/);
  assert.equal(result.details.find((detail) => detail.label === "Performer networks")?.value, "fit-net");
  assert.equal(result.details.find((detail) => detail.label === "Cluster networks")?.value, "cluster-net");
  assert.equal(result.details.find((detail) => detail.label === "Cluster containers")?.value, "cluster");
});

test("sanity check treats non-Docker cluster hosts as best-effort passes", () => {
  const performer = inspectedContainer({});
  const result = assessPerformerClusterSanity(selfManagedCluster("db.example.com"), performer, [performer]);
  assert.equal(result.ok, true);
  assert.match(result.details[0]?.value ?? "", /does not look like a Docker container/);
});
