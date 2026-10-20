/**
 * Unit tests for posting a health digest to Slack.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/health/report/tests/post-digest.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { postDigest } from "../post-digest.js";

const realFetch = globalThis.fetch;
const realToken = process.env.SLACK_BOT_TOKEN;
let posts: URLSearchParams[] = [];

beforeEach(() => {
  posts = [];
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    posts.push(new URLSearchParams(init.body as string));
    return Promise.resolve(new Response(JSON.stringify({ ok: true, ts: `${posts.length}.0` })));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realToken === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = realToken;
});

test("the headline and its thread reply post with link previews off", async () => {
  await postDigest("C123", { headline: "head <https://github.com/x|x>", thread: "detail" });
  assert.equal(posts.length, 2);
  for (const p of posts) {
    assert.equal(p.get("unfurl_links"), "false");
    assert.equal(p.get("unfurl_media"), "false");
  }
  assert.equal(posts[1].get("thread_ts"), "1.0");
});

test("a message with no thread (the weekly post) is one post, previews off", async () => {
  await postDigest("C123", { headline: "weekly" });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].get("unfurl_links"), "false");
});
