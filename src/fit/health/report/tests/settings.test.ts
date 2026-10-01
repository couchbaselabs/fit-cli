/**
 * Unit tests for an SDK's report settings - where its output goes - kept in the store.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/report/tests/settings.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PAGES_URL, applySettingsArgs, reportUrlFor, validateSettings } from "../settings.js";

test("setting a channel, a report link, and turning Slack off", () => {
  const on = applySettingsArgs({}, { slackChannel: "CCFM9S771" });
  assert.deepEqual(on, { slack: { channel: "CCFM9S771" } });
  const linked = applySettingsArgs(on, { reportUrl: "https://example.com/r" });
  assert.deepEqual(linked, { slack: { channel: "CCFM9S771", reportUrl: "https://example.com/r" } });
  // Moving the channel keeps the link; turning Slack off drops both.
  assert.deepEqual(applySettingsArgs(linked, { slackChannel: "C0OTHER12" }), { slack: { channel: "C0OTHER12", reportUrl: "https://example.com/r" } });
  assert.deepEqual(applySettingsArgs(linked, { noSlack: true }), {});
  assert.throws(() => applySettingsArgs({}, { reportUrl: "https://example.com/r" }), /needs a Slack channel/);
});

test("the digest links to the SDK's Pages report unless told otherwise", () => {
  assert.equal(reportUrlFor("java", {}), `${PAGES_URL}java/`);
  assert.equal(reportUrlFor("java", { slack: { channel: "C0123456", reportUrl: "https://example.com/r" } }), "https://example.com/r");
});

test("settings are validated", () => {
  assert.deepEqual(validateSettings({ slack: { channel: "CCFM9S771" } }), []);
  assert.match(validateSettings({ slack: { channel: "#general" } }).join(), /channel or user ID/);
  assert.match(validateSettings({ slack: { channel: "CCFM9S771", reportUrl: "http://x" } }).join(), /https/);
  assert.match(validateSettings({ colour: "red" }).join(), /unknown field "colour"/);
});
