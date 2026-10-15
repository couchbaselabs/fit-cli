/**
 * Post a health digest to Slack with fit-cli's bot: the headline as a channel message, the
 * detail as a reply in its thread. Uses the same bot token as fit-cli's run summaries
 * (SLACK_BOT_TOKEN, or the AWS secret fit-cli/slack/token).
 */
import { postMessage } from "../../slack/util/slack-api.js";
import { resolveSlackToken } from "../../util/config.js";
import type { SlackDigest } from "./render/render-slack.js";

/** The most the two posts may take together: a Slack outage must not hold up the report. */
export const POST_TIMEOUT_MS = 30_000;

export async function postDigest(channel: string, digest: SlackDigest, timeoutMs = POST_TIMEOUT_MS): Promise<{ ts: string }> {
  const token = await resolveSlackToken();
  if (!token) {
    throw new Error("No Slack token: set SLACK_BOT_TOKEN, or log in to AWS so fit-cli can read the fit-cli/slack/token secret.");
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const timedOut = (err: unknown) => (signal.aborted ? new Error(`Slack did not answer within ${timeoutMs / 1000}s`, { cause: err }) : err);
  let ts: string;
  try {
    ts = await postMessage(token, channel, digest.headline, undefined, undefined, signal);
  } catch (err) {
    throw timedOut(err);
  }
  try {
    await postMessage(token, channel, digest.thread, ts, undefined, signal);
  } catch (err) {
    const e = timedOut(err);
    throw new Error(`the headline was posted, but not its thread reply: ${e instanceof Error ? e.message : String(e)}`, { cause: err });
  }
  return { ts };
}
