import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANALYTICS_MAVEN_TEST_ARGS,
  ANALYTICS_TEST_DRIVER_MODULE,
  didFitTestDriverPass,
  extractFitTestDriverSummaryFromJunit,
  extractFitTestDriverSummaryFromJunitReports,
  fitTestDriverSummaryDetails,
  fitTestLogStem,
  runTestDriverArgs,
} from "../run-test-driver.js";
import { collapseSuitesByDefault, stripJunitProperties, surefireReportsDir } from "../collect-junit.js";
import type { FitTestSelection } from "../../select-fit-tests/select-fit-tests.js";

test("surefireReportsDir points at the test-driver's surefire output", () => {
  assert.equal(
    surefireReportsDir("/work/root/transactions-fit-performer"),
    "/work/root/transactions-fit-performer/test-driver/target/surefire-reports",
  );
});

test("stripJunitProperties removes the properties block but keeps the rest", () => {
  const xml = [
    '<testsuite name="GetTest" tests="1">',
    "  <properties>",
    '    <property name="java.class.path" value="/a/very/long:/class/path"/>',
    '    <property name="surefire.test.class.path" value="/more:/paths"/>',
    "  </properties>",
    '  <testcase name="get" classname="GetTest" time="0.1"/>',
    "</testsuite>",
  ].join("\n");

  const stripped = stripJunitProperties(xml);
  assert.ok(!stripped.includes("<properties>"));
  assert.ok(!stripped.includes("java.class.path"));
  assert.ok(stripped.includes('<testsuite name="GetTest"'));
  assert.ok(stripped.includes('<testcase name="get"'));
});

test("collapseSuitesByDefault flips the xunit-viewer expansion tokens", () => {
  const html = "var s={suitesExpanded:!0};(r.currentSuites[a].active=!0)";
  assert.equal(
    collapseSuitesByDefault(html),
    "var s={suitesExpanded:!1};(r.currentSuites[a].active=!1)",
  );
});

test("collapseSuitesByDefault leaves HTML untouched when tokens are absent", () => {
  const html = "<html>no recognisable xunit-viewer markup</html>";
  assert.equal(collapseSuitesByDefault(html), html);
});

test("extractFitTestDriverSummaryFromJunit reads the suite totals from JUnit XML", () => {
  const xml =
    '<testsuite name="SanityTest" tests="3" errors="1" skipped="2" failures="4"><testcase name="basic"/></testsuite>';

  assert.deepEqual(extractFitTestDriverSummaryFromJunit(xml), {
    testsRun: 3,
    failures: 4,
    errors: 1,
    skipped: 2,
  });
});

test("extractFitTestDriverSummaryFromJunitReports totals multiple XML files", () => {
  const reportsDir = mkdtempSync(join(tmpdir(), "fit-cli-run-test-driver-"));
  try {
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(
      join(reportsDir, "TEST-first.xml"),
      '<testsuite name="First" tests="2" failures="1" errors="0" skipped="0"/>',
    );
    writeFileSync(
      join(reportsDir, "TEST-second.xml"),
      '<testsuite name="Second" tests="3" failures="0" errors="1" skipped="2"/>',
    );

    assert.deepEqual(extractFitTestDriverSummaryFromJunitReports(reportsDir), {
      testsRun: 5,
      failures: 1,
      errors: 1,
      skipped: 2,
    });
  } finally {
    rmSync(reportsDir, { recursive: true, force: true });
  }
});

test("didFitTestDriverPass returns true only when there are no failures or errors", () => {
  assert.equal(didFitTestDriverPass({ testsRun: 3, failures: 0, errors: 0, skipped: 1 }), true);
  assert.equal(didFitTestDriverPass({ testsRun: 3, failures: 1, errors: 0, skipped: 1 }), false);
  assert.equal(didFitTestDriverPass({ testsRun: 3, failures: 0, errors: 1, skipped: 1 }), false);
});

test("fitTestDriverSummaryDetails formats the parsed summary for the CLI table", () => {
  assert.deepEqual(
    fitTestDriverSummaryDetails(
      { testsRun: 13, failures: 7, errors: 0, skipped: 2 },
      { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0, runIndex: 0 },
    ),
    [
      {
        label: "Run 0 Result",
        value: "FAIL",
      },
      {
        label: "Run 0 Tests run",
        value: "13",
      },
      {
        label: "Run 0 Failures",
        value: "7",
      },
      {
        label: "Run 0 Errors",
        value: "0",
      },
      {
        label: "Run 0 Skipped",
        value: "2",
      },
    ],
  );
});

test("fitTestLogStem places the driver log under instances/clusters/sessions/runs", () => {
  assert.equal(
    fitTestLogStem({ instanceIndex: 0, clusterIndex: 0, sessionIndex: 0, runIndex: 0 }),
    "instances/0/clusters/0/sessions/0/runs/0/driver",
  );
});

test("fitTestLogStem uses dirSegments when present", () => {
  assert.equal(
    fitTestLogStem({
      instanceIndex: 0,
      clusterIndex: 0,
      sessionIndex: 0,
      runIndex: 0,
      dirSegments: { instance: "aws1", cluster: "8.0.2-5503", session: "java:main", run: "functional" },
    }),
    "instances/aws1/clusters/8.0.2-5503/sessions/java-main/runs/functional/driver",
  );
});

test("runTestDriverArgs omits -Dtest when all tests are selected", () => {
  const selection: FitTestSelection = {
    allTests: [],
    selectedTests: [],
  };

  assert.deepEqual(runTestDriverArgs(selection), [
    "--no-transfer-progress",
    "--batch-mode",
    "--projects",
    "test-driver",
    "--also-make",
    "-Dmaven.test.failure.ignore=true",
    "-Dsurefire.failIfNoSpecifiedTests=false",
    "test",
    "-DexcludedGroups=situational,openshift,syncgateway,slow",
  ]);
});

test("runTestDriverArgs adds the selected tests to -Dtest", () => {
  const selection: FitTestSelection = {
    allTests: [],
    selectedTests: [],
    mavenTestSelector: "com.couchbase.transactions.StandardTest,com.couchbase.transactions.MultipleBucketsTest",
  };

  assert.deepEqual(runTestDriverArgs(selection), [
    "--no-transfer-progress",
    "--batch-mode",
    "--projects",
    "test-driver",
    "--also-make",
    "-Dmaven.test.failure.ignore=true",
    "-Dsurefire.failIfNoSpecifiedTests=false",
    "-Dtest=com.couchbase.transactions.StandardTest,com.couchbase.transactions.MultipleBucketsTest",
    "test",
    "-DexcludedGroups=situational,openshift,syncgateway,slow",
  ]);
});

test("runTestDriverArgs adds the generated FIT config path", () => {
  const selection: FitTestSelection = {
    allTests: [],
    selectedTests: [],
  };

  assert.deepEqual(runTestDriverArgs(selection, "/tmp/fit-cli/run-123/FITConfiguration.json"), [
    "--no-transfer-progress",
    "--batch-mode",
    "--projects",
    "test-driver",
    "--also-make",
    "-Dmaven.test.failure.ignore=true",
    "-Dsurefire.failIfNoSpecifiedTests=false",
    "-Dfit.config=/tmp/fit-cli/run-123/FITConfiguration.json",
    "test",
    "-DexcludedGroups=situational,openshift,syncgateway,slow",
  ]);
});

test("runTestDriverArgs targets the Analytics test-driver module with Analytics excluded groups", () => {
  const selection: FitTestSelection = { allTests: [], selectedTests: [] };

  assert.deepEqual(
    runTestDriverArgs(selection, undefined, ANALYTICS_MAVEN_TEST_ARGS, ANALYTICS_TEST_DRIVER_MODULE),
    [
      "--no-transfer-progress",
      "--batch-mode",
      "--projects",
      "columnar-test-driver",
      "--also-make",
      "-Dmaven.test.failure.ignore=true",
      "-Dsurefire.failIfNoSpecifiedTests=false",
      "test",
      "-DexcludedGroups=situational,openshift,syncgateway,columnarDDL",
    ],
  );
});

test("surefireReportsDir points at the given module's surefire output", () => {
  assert.equal(
    surefireReportsDir("/work/root/transactions-fit-performer", ANALYTICS_TEST_DRIVER_MODULE),
    "/work/root/transactions-fit-performer/columnar-test-driver/target/surefire-reports",
  );
});
