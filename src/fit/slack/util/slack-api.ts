/**
 * Thin Slack Web API wrapper used by the Slack mini CLI. One `slackApi` helper
 * over global `fetch` (following the pattern in shared/definition/push-gist.ts),
 * plus typed wrappers for the handful of methods we call.
 *
 * Note the Slack gotcha: the Web API returns HTTP 200 with `{ ok:false, error }`
 * on logical failures, so we check `data.ok`, not just `response.ok`.
 */
import type { SlackMessage } from "./slack-parse.js";

/**
 * POST to a Slack Web API method with the bot token; throw on HTTP or `ok:false`. `signal`
 * lets a caller bound the request: without one, a hung connection waits indefinitely.
 */
export async function slackApi<T>(
  method: string,
  token: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body: new URLSearchParams(params).toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Slack ${method} returned HTTP ${response.status}: ${text}`);
  }

  const data = (await response.json()) as { ok: boolean; error?: string } & T;
  if (!data.ok) {
    throw new Error(`Slack API ${method} failed: ${data.error ?? "unknown error"}`);
  }
  return data;
}

/** Fetch the most recent `limit` top-level messages of a channel (needs the bot in-channel). */
export async function fetchChannelHistory(
  token: string,
  channel: string,
  limit: number,
): Promise<SlackMessage[]> {
  const data = await slackApi<{ messages?: SlackMessage[] }>("conversations.history", token, {
    channel,
    limit: String(limit),
  });
  return data.messages ?? [];
}

/**
 * Post a message to a channel, or into a thread when `threadTs` is given. Returns
 * the new message ts. `blocks` (Block Kit) render richer than plain text; `text`
 * is still sent as the notification/fallback string.
 */
export async function postMessage(
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
  blocks?: unknown[],
  signal?: AbortSignal,
): Promise<string> {
  const params: Record<string, string> = { channel, text };
  if (threadTs) {
    params.thread_ts = threadTs;
  }
  if (blocks && blocks.length > 0) {
    params.blocks = JSON.stringify(blocks);
  }
  const data = await slackApi<{ ts: string }>("chat.postMessage", token, params, signal);
  return data.ts;
}

/** Best-effort permalink for a message; returns undefined rather than failing a search over one bad link. */
export async function getPermalink(
  token: string,
  channel: string,
  ts: string,
): Promise<string | undefined> {
  try {
    const data = await slackApi<{ permalink: string }>("chat.getPermalink", token, {
      channel,
      message_ts: ts,
    });
    return data.permalink;
  } catch {
    return undefined;
  }
}
