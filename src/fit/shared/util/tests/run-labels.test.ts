import assert from "node:assert/strict";
import { test } from "node:test";
import { clusterLabel, formatRunLabel, instanceLabel, performerLabel, runLabel } from "../run-labels.js";

const path = { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0, runIndex: 0 };

test("instanceLabel reflects the execution kind, falling back to instanceN", () => {
  assert.equal(instanceLabel(path, "aws"), "aws1");
  assert.equal(instanceLabel(path, "localhost"), "local");
  assert.equal(instanceLabel({ ...path, instanceIndex: 2 }), "instance3");
});

test("clusterLabel distinguishes allocated from existing, omitting clusterless", () => {
  assert.equal(clusterLabel(path, "cbdinocluster"), "cbdino1");
  assert.equal(clusterLabel(path, "connection"), "existing1");
  assert.equal(clusterLabel(path, "useExisting"), "existing1");
  assert.equal(clusterLabel(path), "cbdino1");
  assert.equal(clusterLabel({ ...path, clusterlessSession: true }), undefined);
});

test("clusterLabel prefers the cbdino cluster version when known", () => {
  assert.equal(clusterLabel(path, "cbdinocluster", "8.1.0"), "8.1.0");
  // A known version doesn't override the existing-cluster form (we don't claim a version for those).
  assert.equal(clusterLabel(path, "connection", "8.1.0"), "existing1");
});

test("clusterLabel names a clusterless session's cluster by version alone", () => {
  const clusterless = { ...path, clusterlessSession: true };
  // A situational run's cluster is created inside the test-driver, so the version is all we have.
  assert.equal(clusterLabel(clusterless, undefined, "8.0-stable", false, true), "Capella:8.0-stable");
  assert.equal(clusterLabel(clusterless, undefined, "7.6.6"), "7.6.6");
  // With no version there's nothing to name, so the segment is dropped entirely.
  assert.equal(clusterLabel(clusterless, undefined, undefined, false, true), undefined);
});

test("clusterLabel prefixes EA: for a self-managed Enterprise Analytics cluster", () => {
  assert.equal(clusterLabel(path, "cbdinocluster", "2.2.0-1166", true), "EA:2.2.0-1166");
  assert.equal(clusterLabel(path, "cbdinocluster", undefined, true), "EA:cbdino1");
});

test("performerLabel names the session by performer, falling back to sN", () => {
  assert.equal(performerLabel(path, "java", "main"), "java:main");
  assert.equal(performerLabel(path, "java"), "java");
  assert.equal(performerLabel({ ...path, sessionIndex: 1 }), "s2");
});

test("runLabel qualifies a single preset with its type, then the type, then rN", () => {
  assert.equal(runLabel(path, "functional", ["all-transactions"]), "functional:all-transactions");
  assert.equal(runLabel(path, "situational", ["standard-qe"]), "situational:standard-qe");
  // A preset with no known type keeps the bare name.
  assert.equal(runLabel(path, undefined, ["standard-qe"]), "standard-qe");
  assert.equal(runLabel(path, "functional", ["all-transactions", "standard-qe"]), "functional");
  assert.equal(runLabel(path, "situational"), "situational");
  assert.equal(runLabel(path), "r1");
  assert.equal(runLabel({ instanceIndex: 0 }), undefined);
});

test("runLabel appends :cng for CNG functional and situational runs", () => {
  assert.equal(runLabel(path, "functional", undefined, true), "functional:cng");
  assert.equal(runLabel(path, "functional", ["all-transactions"], true), "functional:cng:all-transactions");
  assert.equal(runLabel(path, "situational", undefined, true), "situational:cng");
  assert.equal(runLabel(path, "situational", ["standard-qe"], true), "situational:cng:standard-qe");
});

test("formatRunLabel joins the four segments, dropping absent ones", () => {
  assert.equal(
    formatRunLabel(path, { instanceKind: "aws", clusterMode: "cbdinocluster", sdkValue: "java", performerVersion: "main", type: "functional" }),
    "aws1 / cbdino1 / java:main / functional",
  );
  assert.equal(
    formatRunLabel(
      { instanceIndex: 0, sessionIndex: 0, runIndex: 0, clusterlessSession: true },
      { instanceKind: "aws", sdkValue: "java", type: "situational" },
    ),
    "aws1 / java / situational",
  );
  assert.equal(
    formatRunLabel(
      { instanceIndex: 0, sessionIndex: 0, runIndex: 0, clusterlessSession: true },
      {
        instanceKind: "aws",
        clusterVersion: "8.0",
        capella: true,
        sdkValue: "java",
        performerVersion: "main",
        type: "situational",
        presets: ["standard-qe"],
      },
    ),
    "aws1 / Capella:8.0 / java:main / situational:standard-qe",
  );
  assert.equal(
    formatRunLabel(path, {
      instanceKind: "aws",
      clusterMode: "cbdinocluster",
      clusterVersion: "8.1.0",
      sdkValue: "java",
      performerVersion: "main",
      type: "functional",
    }),
    "aws1 / 8.1.0 / java:main / functional",
  );
  assert.equal(
    formatRunLabel(path, {
      instanceKind: "aws",
      clusterMode: "cbdinocluster",
      clusterVersion: "8.0.2-5503",
      sdkValue: "java",
      performerVersion: "main",
      type: "functional",
      cng: true,
    }),
    "aws1 / 8.0.2-5503 / java:main / functional:cng",
  );
  assert.equal(formatRunLabel(path), "instance1 / cbdino1 / s1 / r1");
});
