import test from "node:test";
import assert from "node:assert/strict";
import {
  condenseStackTrace,
  DEFAULT_OUTPUT_WINDOW_BYTES,
  MAX_RETAINED_STREAM_BYTES,
  MIN_OUTPUT_WINDOW_BYTES,
  parseFailingTestCases,
  parseJunitData,
  planFailureDetail,
  renderJunitMarkdown,
  renderJunitPlainText,
} from "../junit-to-markdown.js";

const PASSING_SUITE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.FooTest" tests="3" failures="0" errors="0" skipped="1" time="2.345">
  <testcase name="testA" classname="com.example.FooTest" time="1.0"/>
  <testcase name="testB" classname="com.example.FooTest" time="0.5"/>
  <testcase name="testC" classname="com.example.FooTest" time="0.845">
    <skipped/>
  </testcase>
</testsuite>`;

const FAILING_SUITE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.BarTest" tests="4" failures="1" errors="1" skipped="0" time="5.0">
  <testcase name="testPass" classname="com.example.BarTest" time="1.0"/>
  <testcase name="testFail" classname="com.example.BarTest" time="2.0">
    <failure message="expected true but was false">java.lang.AssertionError: expected true but was false
	at com.example.BarTest.testFail(BarTest.java:42)</failure>
  </testcase>
  <testcase name="testError" classname="com.example.BarTest" time="1.5">
    <error message="NullPointerException">java.lang.NullPointerException
	at com.example.BarTest.testError(BarTest.java:55)</error>
  </testcase>
  <testcase name="testSkipped" classname="com.example.BarTest" time="0.5">
    <skipped/>
  </testcase>
</testsuite>`;

test("parseFailingTestCases: ignores passing and skipped tests", () => {
  const cases = parseFailingTestCases(PASSING_SUITE);
  assert.equal(cases.length, 0);
});

test("parseFailingTestCases: captures failure and error, not skipped", () => {
  const cases = parseFailingTestCases(FAILING_SUITE);
  assert.equal(cases.length, 2);

  const fail = cases.find((c) => c.name === "testFail");
  assert.ok(fail, "testFail should be captured");
  assert.equal(fail.issues.length, 1);
  assert.equal(fail.issues[0].tag, "failure");
  assert.equal(fail.issues[0].message, "expected true but was false");
  assert.ok(fail.issues[0].body.includes("BarTest.java:42"));

  const err = cases.find((c) => c.name === "testError");
  assert.ok(err, "testError should be captured");
  assert.equal(err.issues[0].tag, "error");
  assert.equal(err.issues[0].message, "NullPointerException");

  const skipped = cases.find((c) => c.name === "testSkipped");
  assert.equal(skipped, undefined, "testSkipped should not appear");
});

test("parseJunitData: aggregates counts correctly across two suites", () => {
  const data = parseJunitData([
    { filename: "TEST-com.example.FooTest.xml", xml: PASSING_SUITE },
    { filename: "TEST-com.example.BarTest.xml", xml: FAILING_SUITE },
  ]);

  assert.equal(data.totalPassed, 4); // 2 from Foo (3-0-0-1) + 2 from Bar (4-1-1-0)
  assert.equal(data.totalFailures, 1); // 0 from Foo + 1 from Bar
  assert.equal(data.totalErrors, 1); // 0 from Foo + 1 from Bar
  assert.equal(data.totalSkipped, 1); // 1 from Foo (skipped="1") + 0 from Bar (skipped="0")
  assert.equal(data.failingCases.length, 2);
});

test("parseJunitData: packages with failures/errors sort first", () => {
  const data = parseJunitData([
    { filename: "TEST-com.example.FooTest.xml", xml: PASSING_SUITE },
    { filename: "TEST-com.example.BarTest.xml", xml: FAILING_SUITE },
  ]);
  assert.equal(data.packages[0].pkg, "com.example");
  assert.ok(data.packages[0].failures + data.packages[0].errors > 0);
});

test("renderJunitMarkdown: contains badge and package table", () => {
  const data = parseJunitData([
    { filename: "TEST-com.example.FooTest.xml", xml: PASSING_SUITE },
    { filename: "TEST-com.example.BarTest.xml", xml: FAILING_SUITE },
  ]);
  const md = renderJunitMarkdown(data);

  assert.ok(md.includes("shields.io/badge/"), "should contain badge URL");
  assert.ok(md.includes("com.example"), "should contain package name");
  assert.ok(md.includes("❌"), "should contain failure emoji");
  assert.ok(md.includes("💥"), "should contain error emoji");
  assert.ok(md.includes("| Test Fail | Infra |"), "should have separate Test Fail and Infra columns");
  assert.ok(md.includes("TOTAL"), "should contain totals row");
});

test("renderJunitMarkdown: failure details present, skipped not annotated", () => {
  const data = parseJunitData([
    { filename: "TEST-com.example.BarTest.xml", xml: FAILING_SUITE },
  ]);
  const md = renderJunitMarkdown(data);

  assert.ok(md.includes("testFail"), "should mention failing test");
  assert.ok(md.includes("expected true but was false"), "should include failure message");
  assert.ok(md.includes("Stack trace"), "should include stack trace block");
  assert.ok(!md.includes("testSkipped"), "should not annotate skipped test");
});

test("renderJunitMarkdown: distinguishes AssertionError failures from other-exception errors", () => {
  const data = parseJunitData([{ filename: "TEST-com.example.BarTest.xml", xml: FAILING_SUITE }]);
  const md = renderJunitMarkdown(data);

  assert.ok(md.includes("#### ❌ BarTest.testFail"), "assertion failure should use the ❌ icon");
  assert.ok(md.includes("#### 💥 BarTest.testError"), "other-exception error should use the 💥 icon");
});

const SUREFIRE_SUITE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.FtsTest" tests="1" failures="1" errors="0" skipped="0" time="1.0">
  <testcase name="vectorSearch" classname="com.example.FtsTest" time="1.0">
    <failure message="Did not get back expected result on FTS operation.  Instead got: elapsedNanos: 119600&#10;initiated {&#10;  seconds: 1782324157&#10;  nanos: 555788200&#10;}&#10;"><![CDATA[org.opentest4j.AssertionFailedError: Did not get back expected result on FTS operation.  Instead got: elapsedNanos: 119600
initiated {
  seconds: 1782324157
  nanos: 555788200
}
	at com.example.FtsTest.vectorSearch(FtsTest.java:99)]]></failure>
  </testcase>
</testsuite>`;

test("parseFailingTestCases: decodes &#10; entities in message attribute", () => {
  const cases = parseFailingTestCases(SUREFIRE_SUITE);
  assert.equal(cases.length, 1);
  const msg = cases[0].issues[0].message;
  assert.ok(!msg.includes("&#10;"), "message should not contain raw &#10; entities");
  assert.ok(msg.includes("\n"), "message should contain real newlines");
  assert.ok(msg.startsWith("Did not get back"), "message text should be preserved");
});

test("parseFailingTestCases: decodes each entity once, so an escaped entity stays literal text", () => {
  // The message text is "expected &lt;T&gt;" - in XML, "&amp;lt;T&amp;gt;". Decoding &amp;
  // first and then &lt; would turn it into "<T>".
  const xml = `<testsuite><testcase classname="a.B" name="c"><failure message="expected &amp;lt;T&amp;gt; &#x1F600;">x</failure></testcase></testsuite>`;
  assert.equal(parseFailingTestCases(xml)[0].issues[0].message, "expected &lt;T&gt; \u{1F600}");
});

test("parseFailingTestCases: strips CDATA wrappers from body", () => {
  const cases = parseFailingTestCases(SUREFIRE_SUITE);
  const body = cases[0].issues[0].body;
  assert.ok(!body.includes("<![CDATA["), "body should not contain CDATA open marker");
  assert.ok(!body.includes("]]>"), "body should not contain CDATA close marker");
  assert.ok(body.includes("AssertionFailedError"), "body content should be preserved");
});

test("renderJunitMarkdown: all-passing run produces no failure blocks", () => {
  const data = parseJunitData([
    { filename: "TEST-com.example.FooTest.xml", xml: PASSING_SUITE },
  ]);
  const md = renderJunitMarkdown(data);
  assert.ok(!md.includes("Stack trace"), "no stack trace for passing suite");
  assert.ok(!md.includes("#### ❌"), "no failure headers");
});

const SUITE_WITH_OUTPUT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.OutputTest" tests="1" failures="1" errors="0" skipped="0" time="1.0">
  <testcase name="doThing" classname="com.example.OutputTest" time="1.0">
    <failure message="expected true but was false">java.lang.AssertionError: expected true but was false</failure>
    <system-out><![CDATA[line1
line2
line3]]></system-out>
    <system-err><![CDATA[warn: something]]></system-err>
  </testcase>
</testsuite>`;

test("parseFailingTestCases: captures per-testcase system-out and system-err", () => {
  const cases = parseFailingTestCases(SUITE_WITH_OUTPUT);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].stdout, "line1\nline2\nline3");
  assert.equal(cases[0].stderr, "warn: something");
});

test("parseFailingTestCases: stdout/stderr are undefined when absent", () => {
  const cases = parseFailingTestCases(FAILING_SUITE);
  assert.equal(cases[0].stdout, undefined);
  assert.equal(cases[0].stderr, undefined);
});

test("renderJunitMarkdown: test output rendered under its own chevron", () => {
  const data = parseJunitData([{ filename: "TEST-com.example.OutputTest.xml", xml: SUITE_WITH_OUTPUT }]);
  const md = renderJunitMarkdown(data);
  assert.ok(md.includes("Test output (stdout)"), "should include stdout chevron summary");
  assert.ok(md.includes("Test output (stderr)"), "should include stderr chevron summary");
  assert.ok(md.includes("line1\nline2\nline3"), "should include stdout content");
  assert.ok(md.includes("warn: something"), "should include stderr content");
});

test("renderJunitPlainText: separate Test Fail/Infra columns and icons", () => {
  const data = parseJunitData([{ filename: "TEST-com.example.BarTest.xml", xml: FAILING_SUITE }]);
  const text = renderJunitPlainText(data);

  assert.ok(text.includes("Test Fail"), "header should say Test Fail");
  assert.ok(text.includes("Infra"), "header should say Infra");
  assert.ok(text.includes("❌ BarTest.testFail"), "assertion failure should use the ❌ icon");
  assert.ok(text.includes("💥 BarTest.testError"), "other-exception error should use the 💥 icon");
});

test("renderJunitPlainText: caps test output to the last N lines", () => {
  const manyLines = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.OutputTest" tests="1" failures="1" errors="0" skipped="0" time="1.0">
  <testcase name="doThing" classname="com.example.OutputTest" time="1.0">
    <failure message="boom">boom</failure>
    <system-out><![CDATA[${manyLines}]]></system-out>
  </testcase>
</testsuite>`;
  const data = parseJunitData([{ filename: "TEST-com.example.OutputTest.xml", xml }]);
  const text = renderJunitPlainText(data, 3, 10);

  assert.ok(text.includes("[20 earlier line(s) omitted]"), "should note omitted line count");
  assert.ok(text.includes("line29"), "should include the last line");
  assert.ok(!text.includes("line0\n") && !text.includes("line0)"), "should not include early lines");
});

/**
 * A trace in the shape FIT actually produces: a couple of Couchbase frames buried in
 * awaitility/okhttp/JDK plumbing. Real runs measured ~14 framework frames per 16.
 */
const REAL_TRACE = [
  "java.lang.RuntimeException: java.io.InterruptedIOException: timeout",
  "\tat com.couchbase.client.observability.util.ObservabilityUtil.checkMetricsExistWithCustomQuery(ObservabilityUtil.java:457)",
  "\tat com.couchbase.client.observability.util.ObservabilityUtil.lambda$waitForMetricsToExist$4(ObservabilityUtil.java:365)",
  "\tat org.awaitility.core.CallableCondition$ConditionEvaluationWrapper.eval(CallableCondition.java:99)",
  "\tat org.awaitility.core.ConditionAwaiter$ConditionPoller.call(ConditionAwaiter.java:248)",
  "\tat org.awaitility.core.ConditionAwaiter$ConditionPoller.call(ConditionAwaiter.java:235)",
  "\tat java.base/java.util.concurrent.FutureTask.run(FutureTask.java:317)",
  "\tat java.base/java.util.concurrent.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1144)",
  "\tat java.base/java.util.concurrent.ThreadPoolExecutor$Worker.run(ThreadPoolExecutor.java:642)",
  "\tat java.base/java.lang.Thread.run(Thread.java:1583)",
  "Caused by: java.io.InterruptedIOException: timeout",
  "\tat okhttp3.internal.connection.RealCall.timeoutExit(RealCall.kt:398)",
  "\tat okhttp3.internal.connection.RealCall.callDone(RealCall.kt:360)",
  "\tat okhttp3.internal.http.RealInterceptorChain.proceed(RealInterceptorChain.kt:109)",
  "\t... 10 more",
].join("\n");

test("condenseStackTrace: keeps Couchbase frames and drops framework frames", () => {
  const out = condenseStackTrace(REAL_TRACE);
  assert.ok(out.includes("ObservabilityUtil.checkMetricsExistWithCustomQuery"), "keeps the meaningful frame");
  assert.ok(out.includes("ObservabilityUtil.lambda$waitForMetricsToExist$4"), "keeps the second meaningful frame");
  assert.ok(!out.includes("org.awaitility"), "drops awaitility frames");
  assert.ok(!out.includes("java.base/java.util.concurrent"), "drops JDK frames");
  assert.ok(!out.includes("okhttp3"), "drops okhttp frames");
});

test("condenseStackTrace: keeps non-frame lines so the exception structure survives", () => {
  const out = condenseStackTrace(REAL_TRACE);
  assert.ok(out.includes("java.lang.RuntimeException: java.io.InterruptedIOException: timeout"), "keeps the header");
  assert.ok(out.includes("Caused by: java.io.InterruptedIOException: timeout"), "keeps Caused by");
  assert.ok(out.includes("... 10 more"), "keeps the elision marker the JVM itself emitted");
});

test("condenseStackTrace: reports how many frames it removed rather than dropping them silently", () => {
  const out = condenseStackTrace(REAL_TRACE);
  assert.ok(/\.\.\. 7 framework frames elided by fit-cli \.\.\./.test(out), `expected a 7-frame marker, got:\n${out}`);
  assert.ok(/\.\.\. 3 framework frames elided by fit-cli \.\.\./.test(out), `expected a 3-frame marker, got:\n${out}`);
});

test("condenseStackTrace: singular wording for a single elided frame", () => {
  const one = ["java.lang.AssertionError: nope", "\tat com.couchbase.Foo.bar(Foo.java:1)", "\tat org.junit.Assert.fail(Assert.java:88)"].join("\n");
  assert.ok(/\.\.\. 1 framework frame elided by fit-cli \.\.\./.test(condenseStackTrace(one)));
});

test("condenseStackTrace: substantially shrinks a framework-heavy trace", () => {
  assert.ok(condenseStackTrace(REAL_TRACE).length < REAL_TRACE.length / 2, "should at least halve a framework-heavy trace");
});

test("condenseStackTrace: an all-framework trace is returned untouched", () => {
  // Nothing of ours in it, so a bare "everything elided" marker would leave the reader with nothing.
  const allFramework = ["java.lang.AssertionError", "\tat org.junit.Assert.fail(Assert.java:88)", "\tat java.base/java.lang.Thread.run(Thread.java:1583)"].join("\n");
  assert.equal(condenseStackTrace(allFramework), allFramework);
});

test("condenseStackTrace: leaves a trace with no framework frames unchanged", () => {
  const clean = ["java.lang.AssertionError: nope", "\tat com.couchbase.Foo.bar(Foo.java:1)"].join("\n");
  assert.equal(condenseStackTrace(clean), clean);
});

test("condenseStackTrace: empty body is preserved", () => {
  assert.equal(condenseStackTrace(""), "");
});

test("renderJunitMarkdown: condenses stack traces in the detail block", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.TraceTest" tests="1" failures="1" errors="0" skipped="0" time="1.0">
  <testcase name="doThing" classname="com.example.TraceTest" time="1.0">
    <failure message="boom"><![CDATA[${REAL_TRACE}]]></failure>
  </testcase>
</testsuite>`;
  const md = renderJunitMarkdown(parseJunitData([{ filename: "TEST-com.example.TraceTest.xml", xml }]));
  assert.ok(md.includes("ObservabilityUtil.checkMetricsExistWithCustomQuery"), "keeps meaningful frames");
  assert.ok(!md.includes("org.awaitility"), "drops framework frames");
});

test("renderJunitMarkdown: includeFailureDetail false keeps the package table but drops detail blocks", () => {
  const data = parseJunitData([{ filename: "TEST-com.example.BarTest.xml", xml: FAILING_SUITE }]);
  const md = renderJunitMarkdown(data, { includeFailureDetail: false });
  assert.ok(md.includes("Test results by package"), "the package table is the point of the lean form");
  assert.ok(md.includes("com.example"), "package row survives");
  assert.ok(!md.includes("BarTest.testFail"), "per-failure detail is dropped");
});

test("renderJunitMarkdown: the lean form states how many failures it is not showing", () => {
  const data = parseJunitData([{ filename: "TEST-com.example.BarTest.xml", xml: FAILING_SUITE }]);
  const md = renderJunitMarkdown(data, { includeFailureDetail: false });
  assert.ok(/failing test\(s\) — detail omitted/.test(md), `expected a count of omitted failures, got:\n${md}`);
});

test("renderJunitMarkdown: the lean form is smaller than the full one", () => {
  const data = parseJunitData([{ filename: "TEST-com.example.BarTest.xml", xml: FAILING_SUITE }]);
  assert.ok(renderJunitMarkdown(data, { includeFailureDetail: false }).length < renderJunitMarkdown(data).length);
});

test("renderJunitMarkdown: lean form of an all-passing run says nothing about failures", () => {
  const data = parseJunitData([{ filename: "TEST-com.example.FooTest.xml", xml: PASSING_SUITE }]);
  assert.ok(!renderJunitMarkdown(data, { includeFailureDetail: false }).includes("detail omitted"));
});

// --- budget-derived elision window (planFailureDetail) ---

const PLAN_BASE = { failureCount: 100, fixedBytes: 10_000, perFailureBytes: 100_000 };

test("planFailureDetail: no budget keeps the historical fixed window and every failure", () => {
  const plan = planFailureDetail({ ...PLAN_BASE });
  assert.equal(plan.outputBudgetPerFailure, 2 * DEFAULT_OUTPUT_WINDOW_BYTES);
  assert.equal(plan.shownFailures, 100);
});

test("planFailureDetail: a generous budget does not exceed the historical window", () => {
  // Otherwise a run with 2 failures would inline megabytes just because it can.
  const plan = planFailureDetail({ ...PLAN_BASE, failureCount: 2, perFailureBytes: 2000, budgetBytes: 900 * 1024 });
  assert.equal(plan.outputBudgetPerFailure, 2 * DEFAULT_OUTPUT_WINDOW_BYTES);
  assert.equal(plan.shownFailures, 2);
});

test("planFailureDetail: a tight budget narrows the window but still shows every failure", () => {
  const plan = planFailureDetail({ ...PLAN_BASE, budgetBytes: 900 * 1024 });
  assert.equal(plan.shownFailures, 100, "every failure should still be detailed");
  assert.ok(plan.outputBudgetPerFailure < 2 * DEFAULT_OUTPUT_WINDOW_BYTES, "allowance should have narrowed");
  assert.ok(plan.outputBudgetPerFailure >= MIN_OUTPUT_WINDOW_BYTES, "window should stay usable");
});

test("planFailureDetail: the window derived from the budget actually fits it", () => {
  const budgetBytes = 900 * 1024;
  const plan = planFailureDetail({ ...PLAN_BASE, budgetBytes });
  const projected = PLAN_BASE.fixedBytes + PLAN_BASE.perFailureBytes + plan.shownFailures * plan.outputBudgetPerFailure;
  assert.ok(projected <= budgetBytes, `projected ${projected} should fit budget ${budgetBytes}`);
});

test("planFailureDetail: once the window hits its floor, failures are cut instead", () => {
  // 5000 failures cannot each get a usable window out of 900K, so show fewer properly.
  const plan = planFailureDetail({ failureCount: 5000, fixedBytes: 10_000, perFailureBytes: 5_000_000, budgetBytes: 900 * 1024 });
  assert.equal(plan.outputBudgetPerFailure, MIN_OUTPUT_WINDOW_BYTES, "window should sit at the floor, not below");
  assert.ok(plan.shownFailures < 5000, "should show fewer failures");
  assert.ok(plan.shownFailures > 0, "should still show some");
});

test("planFailureDetail: never asks for more failures than exist, or a negative count", () => {
  const plan = planFailureDetail({ failureCount: 3, fixedBytes: 10_000, perFailureBytes: 3000, budgetBytes: 200 });
  assert.ok(plan.shownFailures >= 0 && plan.shownFailures <= 3, `got ${plan.shownFailures}`);
});

test("planFailureDetail: zero failures is handled without dividing by zero", () => {
  const plan = planFailureDetail({ failureCount: 0, fixedBytes: 5000, perFailureBytes: 0, budgetBytes: 900 * 1024 });
  assert.equal(plan.shownFailures, 0);
  assert.ok(Number.isFinite(plan.outputBudgetPerFailure));
});

test("renderJunitMarkdown: a tight budget still names every failing test", () => {
  const data = parseJunitData([{ filename: "TEST-com.example.BarTest.xml", xml: FAILING_SUITE }]);
  const md = renderJunitMarkdown(data, { budgetBytes: 8000 });
  assert.ok(md.includes("BarTest.testFail"), "failing test should still be named");
  assert.ok(md.includes("BarTest.testError"), "erroring test should still be named");
});

test("renderJunitMarkdown: reports how many failures it did not show, and where to find them", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    filename: `TEST-com.example.T${i}.xml`,
    xml: `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.T${i}" tests="1" failures="1" errors="0" skipped="0" time="1.0">
  <testcase name="boom" classname="com.example.T${i}" time="1.0">
    <failure message="boom ${i}">${"stack line\n".repeat(200)}</failure>
    <system-out><![CDATA[${"out line\n".repeat(2000)}]]></system-out>
  </testcase>
</testsuite>`,
  }));
  const md = renderJunitMarkdown(parseJunitData(many), { budgetBytes: 120 * 1024 });
  assert.ok(/\.\.\. and \d+ more failure\(s\) not shown/.test(md), `expected a not-shown count, got:\n${md.slice(-600)}`);
  assert.ok(md.includes("fit archive fetch"), "should say where all of them are");
});

test("renderJunitMarkdown: honours a tight budget on a pathological run", () => {
  const many = Array.from({ length: 300 }, (_, i) => ({
    filename: `TEST-com.example.T${i}.xml`,
    xml: `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.T${i}" tests="1" failures="1" errors="0" skipped="0" time="1.0">
  <testcase name="boom" classname="com.example.T${i}" time="1.0">
    <failure message="boom">${"stack line\n".repeat(500)}</failure>
    <system-out><![CDATA[${"out line\n".repeat(5000)}]]></system-out>
    <system-err><![CDATA[${"err line\n".repeat(5000)}]]></system-err>
  </testcase>
</testsuite>`,
  }));
  const budgetBytes = 200 * 1024;
  const md = renderJunitMarkdown(parseJunitData(many), { budgetBytes });
  assert.ok(Buffer.byteLength(md, "utf8") <= budgetBytes, `rendered ${Buffer.byteLength(md, "utf8")} against a ${budgetBytes} budget`);
});

test("renderJunitMarkdown: never exceeds its budget, across adversarial shapes and budgets", () => {
  // Predicting the rendered size from the inputs turned out to be unreliable — an earlier
  // version overshot by a constant ~988 bytes on one shape — so the renderer measures and
  // shrinks. This pins that guarantee rather than the estimate behind it.
  const shapes: Array<{ name: string; xml: (i: number) => string }> = [
    {
      name: "huge stdout, tiny message",
      xml: (i) => `<testcase name="t${i}" classname="com.example.A${i}" time="1.0">
        <error message="boom">short</error>
        <system-out><![CDATA[${"x".repeat(50_000)}]]></system-out></testcase>`,
    },
    {
      name: "huge message, no output",
      xml: (i) => `<testcase name="t${i}" classname="com.example.B${i}" time="1.0">
        <failure message="${"m".repeat(20_000)}">trace</failure></testcase>`,
    },
    {
      name: "huge trace and both streams",
      xml: (i) => `<testcase name="t${i}" classname="com.example.C${i}" time="1.0">
        <error message="boom"><![CDATA[${"\tat com.couchbase.Foo.bar(Foo.java:1)\n".repeat(800)}]]></error>
        <system-out><![CDATA[${"o".repeat(30_000)}]]></system-out>
        <system-err><![CDATA[${"e".repeat(30_000)}]]></system-err></testcase>`,
    },
    {
      name: "multi-byte content",
      xml: (i) => `<testcase name="t${i}" classname="com.example.D${i}" time="1.0">
        <error message="✅ boom 💥">trace</error>
        <system-out><![CDATA[${"✅💥".repeat(8_000)}]]></system-out></testcase>`,
    },
  ];

  for (const shape of shapes) {
    for (const count of [1, 25, 200]) {
      const files = Array.from({ length: count }, (_, i) => ({
        filename: `TEST-com.example.S${i}.xml`,
        xml: `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.S${i}" tests="1" failures="1" errors="0" skipped="0" time="1.0">${shape.xml(i)}</testsuite>`,
      }));
      const data = parseJunitData(files);
      for (const budgetBytes of [2000, 20_000, 200_000, 900 * 1024]) {
        const size = Buffer.byteLength(renderJunitMarkdown(data, { budgetBytes }), "utf8");
        assert.ok(size <= budgetBytes, `${shape.name} x${count} at budget ${budgetBytes}: rendered ${size}`);
      }
    }
  }
});

// --- memory safety: clipping at parse time, and oversized reports ---

test("parseFailingTestCases: clips a huge stdout at parse time, keeping head and tail", () => {
  const lines = Array.from({ length: 200_000 }, (_, i) => `line${i}`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.BigTest" tests="1" failures="1" errors="0" skipped="0" time="1.0">
  <testcase name="big" classname="com.example.BigTest" time="1.0">
    <failure message="boom">trace</failure>
    <system-out><![CDATA[${lines}]]></system-out>
  </testcase>
</testsuite>`;
  const [tc] = parseFailingTestCases(xml);
  assert.ok(tc.stdout, "stdout should be captured");
  assert.ok(tc.stdout.length <= MAX_RETAINED_STREAM_BYTES, `retained ${tc.stdout.length}, cap is ${MAX_RETAINED_STREAM_BYTES}`);
  assert.ok(tc.stdout.startsWith("line0\n"), "keeps the head");
  assert.ok(tc.stdout.endsWith("line199999"), "keeps the tail");
  assert.ok((tc.stdoutOmittedLines ?? 0) > 0, "records what it dropped");
});

test("parseFailingTestCases: leaves a small stdout untouched and records no omission", () => {
  const cases = parseFailingTestCases(SUITE_WITH_OUTPUT);
  assert.equal(cases[0].stdout, "line1\nline2\nline3");
  assert.equal(cases[0].stdoutOmittedLines, undefined);
});

test("renderJunitMarkdown: the elision marker counts parse-time and render-time omissions together", () => {
  const lines = Array.from({ length: 200_000 }, (_, i) => `line${i}`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.BigTest" tests="1" failures="1" errors="0" skipped="0" time="1.0">
  <testcase name="big" classname="com.example.BigTest" time="1.0">
    <failure message="boom">trace</failure>
    <system-out><![CDATA[${lines}]]></system-out>
  </testcase>
</testsuite>`;
  const md = renderJunitMarkdown(parseJunitData([{ filename: "TEST-com.example.BigTest.xml", xml }]));
  const m = md.match(/~(\d+) lines hidden/);
  assert.ok(m, `expected an elision marker, got:\n${md.slice(0, 600)}`);
  // Nearly all 200k lines are gone; a marker reporting only the render-time cut would be
  // wildly understated, which is the bug this guards.
  assert.ok(Number(m[1]) > 190_000, `marker said ${m[1]} lines, expected most of 200000`);
});

test("parseJunitData: an oversized report is counted but not detailed", () => {
  const data = parseJunitData([
    { filename: "TEST-com.example.HugeTest.xml", xml: `<testsuite name="com.example.HugeTest" tests="10" failures="3" errors="1" skipped="0" time="5.0">`, oversizedBytes: 385 * 1024 * 1024 },
  ]);
  assert.equal(data.totalFailures, 3, "counts still come from the testsuite attributes");
  assert.equal(data.totalErrors, 1);
  assert.equal(data.failingCases.length, 0, "no detail parsed from a partial document");
  assert.deepEqual(data.oversizedReports, [{ filename: "TEST-com.example.HugeTest.xml", bytes: 385 * 1024 * 1024 }]);
});

test("renderJunitMarkdown: says which reports were too large, and where to read them", () => {
  const data = parseJunitData([
    { filename: "TEST-com.example.HugeTest.xml", xml: `<testsuite name="com.example.HugeTest" tests="10" failures="3" errors="1" skipped="0" time="5.0">`, oversizedBytes: 385 * 1024 * 1024 },
  ]);
  const md = renderJunitMarkdown(data);
  assert.ok(md.includes("TEST-com.example.HugeTest.xml"), "names the report");
  assert.ok(md.includes("385 MB"), "gives its size");
  assert.ok(md.includes("fit archive fetch"), "says where to read it");
});

test("renderJunitPlainText: flags oversized reports too", () => {
  const data = parseJunitData([
    { filename: "TEST-com.example.HugeTest.xml", xml: `<testsuite name="com.example.HugeTest" tests="10" failures="3" errors="1" skipped="0" time="5.0">`, oversizedBytes: 385 * 1024 * 1024 },
  ]);
  assert.ok(renderJunitPlainText(data).includes("TEST-com.example.HugeTest.xml"));
});

test("retained stream size exceeds the largest render window, so clipping is always reported", () => {
  // If this inverted, a clipped stream could render without truncation and its parse-time
  // omission would go unmentioned.
  assert.ok(MAX_RETAINED_STREAM_BYTES > 2 * DEFAULT_OUTPUT_WINDOW_BYTES);
});

test("parseFailingTestCases: carries the clipping reader's omitted-line count through", () => {
  // Large reports are clipped while being read, and mark the cut with a sentinel inside the
  // CDATA. The count has to survive into the elision marker, or a 385 MB report would claim
  // it hid only the handful of lines the renderer itself removed.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.ClipTest" tests="1" failures="1" errors="0" skipped="0" time="1.0">
  <testcase name="clipped" classname="com.example.ClipTest" time="1.0">
    <failure message="boom">trace</failure>
    <system-out><![CDATA[head line
@@fit-cli-omitted-lines:123456@@
tail line]]></system-out>
  </testcase>
</testsuite>`;
  const [tc] = parseFailingTestCases(xml);
  assert.equal(tc.stdoutOmittedLines, 123456, "the sentinel's count should be preserved");
  assert.ok(!tc.stdout?.includes("fit-cli-omitted-lines"), "the sentinel itself should not be shown");
  assert.ok(tc.stdout?.includes("head line") && tc.stdout?.includes("tail line"), "head and tail survive");
});

test("renderJunitMarkdown: a stream clipped while reading still reports the full hidden count", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.ClipTest" tests="1" failures="1" errors="0" skipped="0" time="1.0">
  <testcase name="clipped" classname="com.example.ClipTest" time="1.0">
    <failure message="boom">trace</failure>
    <system-out><![CDATA[head line
@@fit-cli-omitted-lines:123456@@
tail line]]></system-out>
  </testcase>
</testsuite>`;
  const md = renderJunitMarkdown(parseJunitData([{ filename: "TEST-com.example.ClipTest.xml", xml }]));
  assert.ok(/~12345\d lines hidden/.test(md), `expected the clip count in the marker, got:\n${md.slice(-800)}`);
});
