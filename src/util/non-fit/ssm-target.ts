/**
 * ssm-target — an ExecutionTarget backed by AWS SSM SendCommand, addressed by
 * EC2 instance id instead of host/user/key. fit-cli's own automation is
 * SDK-only (no aws CLI, no ssh/scp, no session-manager-plugin): SendCommand is
 * the one SSM mechanism that's a plain API call end-to-end. `ssm:StartSession`
 * (a real interactive shell) is used only for the human-facing debug hint (see
 * lifecycle-warning.ts's ssmStartSessionCommand) — its data channel is only
 * implemented by the separate session-manager-plugin binary, so it's never
 * used here.
 *
 * GetCommandInvocation caps its inline stdout/stderr (~24000 characters, after
 * which SSM appends an "output truncated" marker), so every command is sent with
 * CloudWatchOutputConfig pointed at a shared, short-retention log group
 * (ensureSsmLogGroup) and output is read back from there. `run()` polls that log
 * group every ~1.5s for new lines so output still appears live-ish on the
 * terminal, in place of the tee'd SSH output this replaces.
 *
 * That read is what makes output unbounded, so it's load-bearing: it's the SSM
 * Agent on the instance that writes those streams, and it needs
 * logs:CreateLogStream/PutLogEvents on the log group via its instance profile
 * (terraform/aws/ssm-instance-role.tf). Without that the log group stays empty and
 * every command silently falls back to the capped inline copy.
 */
import { DescribeInstanceInformationCommand, GetCommandInvocationCommand, SendCommandCommand } from "@aws-sdk/client-ssm";
import { DeleteLogStreamCommand, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { cloudWatchLogsClient, ssmClient } from "../../cloud/util/aws/aws-clients.js";
import { ensureSsmLogGroup } from "../../cloud/util/aws/ssm-log-group.js";
import { commandOn, echoCommand, fitCliWarn, formatCommandLine, startGreyTextOutput, stopGreyTextOutput } from "./fit-cli-log.js";
import { buildRemoteCommand, posixQuote } from "./remote-target.js";
import { writeCommandOutputToDebugLog, type RunOptions } from "./proc.js";
import { exponentialDelays, retryWhole } from "./retry.js";
import type { ExecutionTarget } from "./target.js";
import { ssmGetFile, ssmPutFile } from "./ssm-file-relay.js";

/** Login user commands run as. AWS-RunShellScript itself runs as root; we sudo -u into this so home dir, env and group membership (e.g. docker) match today's SSH login user. */
export const DEFAULT_SSM_USER = "ubuntu";

const SSM_LOG_GROUP_NAME = "/fit-cli/ssm-command-output";
const SSM_LOG_RETENTION_DAYS = 3;
const POLL_INTERVAL_MS = 1_500;
// SendCommand's own response can return before the invocation record it just created is
// visible to GetCommandInvocation yet (the eventual-consistency gap isTransientSsmError
// treats as InvocationDoesNotExist) — checking status immediately after send meant almost
// every command paid for one guaranteed-to-fail GetCommandInvocation call. This settle
// delay lets that propagation finish first so the common case skips it.
const POST_SEND_SETTLE_MS = 50;
// SSM has two unrelated deadlines and only the second one bounds a running command:
//   - SendCommand's TimeoutSeconds is a *delivery* deadline. If the command hasn't started
//     on the instance by then it never runs; it says nothing about how long one that did
//     start may take.
//   - AWS-RunShellScript's own executionTimeout parameter is the real ceiling, and it
//     defaults to 3600 no matter what TimeoutSeconds says. Unlike ssh.ts's
//     ServerAliveInterval (an idle timeout that never fires on an active connection), it
//     is a hard ceiling regardless of activity: a healthy, actively-producing command is
//     killed at that deadline just the same as a hung one, surfacing as status TimedOut
//     with exit code 137. So it has to be set explicitly — leaving it defaulted caps every
//     command at an hour, which a situational suite exceeds routinely.
// Both are set to the GHA run cap (specs/timers-and-lifetimes.md) since no run should need
// longer than that anyway. AWS caps executionTimeout at 172800 (48h), well above ours.
const DEFAULT_TIMEOUT_SECONDS = 6 * 60 * 60;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let logGroupArn: Promise<string> | undefined;

function ensureLogGroup(): Promise<string> {
  logGroupArn ??= ensureSsmLogGroup(SSM_LOG_GROUP_NAME, SSM_LOG_RETENTION_DAYS).then((g) => g.arn);
  return logGroupArn;
}

/**
 * True for SSM errors worth retrying — throttling, the instance not yet
 * visible to SSM right after boot, GetCommandInvocation being called before
 * the invocation record it just SendCommand'd has propagated (a real AWS
 * eventual-consistency gap, not a caller bug), a stalled request hitting the
 * client's own requestTimeout (see aws-clients.ts — a network blip shouldn't
 * take the whole run down any more than a real throttling response would),
 * or a malformed response that never made it into a modeled exception. That
 * last case shows up as a bare `Error` with an empty name/message:
 * @smithy/core's deserializer occasionally can't parse an SSM error body
 * (seen on the command issued right after a multi-hour AWS-RunShellScript
 * invocation completes) and throws before attaching one, leaving only
 * `$metadata.httpStatusCode` to go on. Treating that shape as transient too
 * lets a one-off glitch retry instead of taking the whole run down. Exported
 * so callers that catch SsmTarget errors higher up can apply the same test
 * (mirrors ssh.ts's isTransientSshError).
 */
export function isTransientSsmError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (/Throttling|InvalidInstanceId|InvocationDoesNotExist|TimeoutError/.test(err.name) || /Throttling|InvalidInstanceId|InvocationDoesNotExist|TimeoutError|ETIMEDOUT/.test(err.message)) return true;
  const metadata = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return !err.name && !err.message && metadata?.httpStatusCode !== undefined && metadata.httpStatusCode >= 400;
}

// Backs off exponentially rather than retrying at a flat interval so that a burst of SSM
// throttling on the shared account (several FIT jobs hitting the same quota at once) eases
// off instead of hammering straight back into it. Applies the same schedule to every
// transient error, not just throttling — a poll loop's own success resets it back to
// attempt 1 for the next call, so a brief blip never taxes the budget of a later one.
// The following figures try to balance not waiting forever in the face of transient problems, while also avoiding
// the SSM throttling.
const SSM_RETRY_ATTEMPTS = 10;
const SSM_RETRY_BASE_DELAY_MS = 250;
const SSM_RETRY_MAX_DELAY_MS = 15_000;

/** err.name if there is one, else err.message, else the bare error — so the "transient error" log below says what actually happened instead of hiding it behind that generic label. */
function describeSsmError(err: unknown): string {
  if (err instanceof Error) return err.name || err.message || "unnamed error";
  return String(err);
}

const SSM_RETRY_DELAYS_MS = exponentialDelays({
  attempts: SSM_RETRY_ATTEMPTS,
  baseMs: SSM_RETRY_BASE_DELAY_MS,
  maxMs: SSM_RETRY_MAX_DELAY_MS,
});

async function withSsmRetry<T>(fn: () => Promise<T>): Promise<T> {
  return retryWhole(fn, {
    delaysMs: SSM_RETRY_DELAYS_MS,
    shouldRetry: isTransientSsmError,
    // nextAttempt counts the first attempt, so the one that just failed is nextAttempt - 1.
    onRetry: (err, waitMs, nextAttempt) =>
      console.error(
        `[ssm] transient error (${describeSsmError(err)}) (attempt ${nextAttempt - 1}/${SSM_RETRY_ATTEMPTS}), retrying in ${Math.round(waitMs / 1000)}s…`,
      ),
  });
}

/**
 * Poll until `instanceId` is registered and online with SSM, or `timeoutMs`
 * elapses. Freshly launched instances take a little while before the SSM Agent
 * registers, same shape as ssh.ts's waitForSsh. Resolves true once online,
 * false on timeout.
 */
export async function waitForSsmReady(
  instanceId: string,
  { timeoutMs = 180_000, intervalMs = 5_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const resp = await ssmClient.send(new DescribeInstanceInformationCommand({
        Filters: [{ Key: "InstanceIds", Values: [instanceId] }],
      }));
      if (resp.InstanceInformationList?.[0]?.PingStatus === "Online") {
        return true;
      }
    } catch {
      // Keep polling — the instance may not be registered with SSM yet.
    }
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

const TERMINAL_STATUSES = new Set(["Success", "Failed", "Cancelled", "TimedOut"]);

/**
 * A command's output with the two streams kept apart. They must stay separate all
 * the way to the caller: `capture()` hands `stdout` back as data to be parsed, so
 * folding diagnostics into it silently corrupts the value. That is not theoretical —
 * merging them turned `cbdinocluster connstr --couchbase2` (a one-line connection
 * string on stdout, zap/log.Printf diagnostics on stderr) into a multi-line blob,
 * and the SDK rejected the result with "Malformed connection string".
 */
interface StreamedOutput {
  /** The command's stdout — the data callers parse. Never mixed with stderr. */
  stdout: string;
  /** The command's stderr — diagnostics, and the detail worth quoting when it fails. */
  stderr: string;
  /** Both streams in event order, for humans and the debug log. */
  combined: string;
}

/** SSM writes each invocation's streams to `<commandId>/<instanceId>/aws-runShellScript/<suffix>`. */
const SSM_STREAM_SUFFIXES = ["stdout", "stderr"] as const;

/**
 * Split CloudWatch events into stdout and stderr by the log stream each came from.
 * Only an explicit `/stderr` stream is held back from stdout — anything unclassified
 * stays with the data rather than being silently dropped from it.
 */
export function partitionLogEvents(events: readonly { message?: string; logStreamName?: string }[]): StreamedOutput {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const combined: string[] = [];
  for (const event of events) {
    if (!event.message) continue;
    (event.logStreamName?.endsWith("/stderr") ? stderr : stdout).push(event.message);
    combined.push(event.message);
  }
  return { stdout: stdout.join(""), stderr: stderr.join(""), combined: combined.join("") };
}

interface InvocationStatus {
  done: boolean;
  status: string;
  exitCode: number;
  /**
   * GetCommandInvocation's own inline stdout/stderr (capped at ~24000 chars, but
   * available immediately — no CloudWatch ingestion lag). Used as a fallback when
   * fetchNewLogLines races ahead of CloudWatch actually having the events yet (see
   * runShellCommandCaptured), and doubles as the signal that the command produced
   * output at all.
   */
  inline: StreamedOutput;
}

async function getInvocationStatus(instanceId: string, commandId: string): Promise<InvocationStatus> {
  const resp = await ssmClient.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }));
  const status = resp.Status ?? "Pending";
  const stdout = resp.StandardOutputContent ?? "";
  const stderr = resp.StandardErrorContent ?? "";
  return {
    done: TERMINAL_STATUSES.has(status),
    status,
    exitCode: resp.ResponseCode ?? (status === "Success" ? 0 : 1),
    inline: { stdout, stderr, combined: stdout + stderr },
  };
}

async function pollUntilDone(instanceId: string, commandId: string): Promise<InvocationStatus> {
  for (;;) {
    const result = await withSsmRetry(() => getInvocationStatus(instanceId, commandId));
    if (result.done) return result;
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Every log event for `commandId` on `instanceId` written strictly after `afterMs`,
 * or the whole stream when `afterMs` is 0. The log stream name is command-unique, so
 * there are no stale events to filter out and an unfiltered read is safe - callers
 * seed from 0 rather than from the local clock deliberately, since event timestamps
 * come from the instance and any clock skew between it and here would otherwise
 * silently filter out real output.
 */
async function fetchNewLogLines(commandId: string, instanceId: string, afterMs: number): Promise<StreamedOutput & { lastMs: number }> {
  let lastMs = afterMs;
  const events: { message?: string; logStreamName?: string }[] = [];
  let nextToken: string | undefined;
  do {
    // The prefix deliberately spans both the stdout and stderr streams, so one read
    // gets everything; partitionLogEvents then keeps them apart by stream name.
    let resp;
    try {
      resp = await cloudWatchLogsClient.send(new FilterLogEventsCommand({
        logGroupName: SSM_LOG_GROUP_NAME,
        logStreamNamePrefix: `${commandId}/${instanceId}`,
        ...(afterMs > 0 ? { startTime: afterMs + 1 } : {}),
        nextToken,
      }));
    } catch (err) {
      // Log streaming is best-effort display, not the source of truth for whether the
      // command succeeded (that's pollUntilDone's GetCommandInvocation) - a blip here
      // (e.g. DNS to the CloudWatch Logs endpoint) shouldn't take the whole run down.
      // The next poll cycle retries this same window since lastMs is left unadvanced.
      fitCliWarn(`Could not fetch SSM command output from CloudWatch Logs (will retry next poll): ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
    for (const event of resp.events ?? []) {
      events.push(event);
      if (event.timestamp && event.timestamp > lastMs) lastMs = event.timestamp;
    }
    nextToken = resp.nextToken;
  } while (nextToken);
  return { ...partitionLogEvents(events), lastMs };
}

// CloudWatch ingestion can lag a second or two behind the command finishing. Only
// worth waiting when we know output exists but haven't seen it yet, so commands that
// legitimately print nothing (the majority) don't pay this cost.
const OUTPUT_SETTLE_TIMEOUT_MS = 20_000;
const OUTPUT_SETTLE_POLL_MS = 1_000;

/**
 * Read the remaining log events for a finished command. When `expectOutput` is set,
 * keep retrying until something shows up (or the settle timeout expires) rather than
 * accepting an empty read that's really just ingestion lag.
 */
async function settledLogLines(commandId: string, instanceId: string, afterMs: number, expectOutput: boolean): Promise<StreamedOutput> {
  const deadline = Date.now() + OUTPUT_SETTLE_TIMEOUT_MS;
  for (;;) {
    const output = await fetchNewLogLines(commandId, instanceId, afterMs);
    if (output.combined || !expectOutput || Date.now() >= deadline) return output;
    await sleep(OUTPUT_SETTLE_POLL_MS);
  }
}

/**
 * SSM's marker for output it cut short. Its inline stdout/stderr is capped at ~24000
 * characters; CloudWatch output has no such cap, so seeing this means we fell back to
 * the inline content and are missing data.
 */
const INLINE_TRUNCATION_MARKER = /output truncated/i;

/** Best-effort: the log group's own retention policy is the real safety net. */
async function deleteLogStreams(commandId: string, instanceId: string): Promise<void> {
  for (const suffix of SSM_STREAM_SUFFIXES) {
    await cloudWatchLogsClient
      .send(new DeleteLogStreamCommand({ logGroupName: SSM_LOG_GROUP_NAME, logStreamName: `${commandId}/${instanceId}/aws-runShellScript/${suffix}` }))
      .catch(() => {});
  }
}

async function sendShellCommand(instanceId: string, command: string, runAsUser: string): Promise<{ commandId: string }> {
  await ensureLogGroup();
  // AWS-RunShellScript runs as root; sudo -u keeps parity with the box's normal
  // login user (home dir, environment, group membership — e.g. docker) instead
  // of silently switching every command to root.
  const script = runAsUser !== "root" ? `sudo -u ${runAsUser} -H bash -lc ${posixQuote(command)}` : command;
  const resp = await withSsmRetry(() => ssmClient.send(new SendCommandCommand({
    InstanceIds: [instanceId],
    DocumentName: "AWS-RunShellScript",
    Parameters: { commands: [script], executionTimeout: [String(DEFAULT_TIMEOUT_SECONDS)] },
    TimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    CloudWatchOutputConfig: { CloudWatchLogGroupName: SSM_LOG_GROUP_NAME, CloudWatchOutputEnabled: true },
  })));
  const commandId = resp.Command?.CommandId;
  if (!commandId) throw new Error(`SendCommand on ${instanceId} returned no CommandId.`);
  await sleep(POST_SEND_SETTLE_MS);
  return { commandId };
}

async function runShellCommandStreamed(instanceId: string, remoteCmd: string, runAsUser: string): Promise<void> {
  const { commandId } = await sendShellCommand(instanceId, remoteCmd, runAsUser);
  let lastMs = 0;
  let wroteAnything = false;
  for (;;) {
    // Streamed output is for a human to read, so both streams go to the terminal
    // interleaved — only capture() needs them kept apart.
    const chunk = await fetchNewLogLines(commandId, instanceId, lastMs);
    if (chunk.combined) {
      process.stdout.write(chunk.combined);
      wroteAnything = true;
    }
    lastMs = chunk.lastMs;

    const status = await withSsmRetry(() => getInvocationStatus(instanceId, commandId));
    if (status.done) {
      const tail = await settledLogLines(commandId, instanceId, lastMs, status.inline.combined.length > 0 && !wroteAnything);
      if (tail.combined) {
        process.stdout.write(tail.combined);
        wroteAnything = true;
      }
      // With CloudWatch output unavailable there is nothing to stream, so fall back to
      // the inline content so the user still sees something rather than silence.
      if (!wroteAnything && status.inline.combined) process.stdout.write(status.inline.combined);
      void deleteLogStreams(commandId, instanceId);
      if (status.status !== "Success") {
        throw new Error(`command on ${instanceId} exited with status ${status.status} (code ${status.exitCode})`);
      }
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

interface CapturedResult {
  output: StreamedOutput;
  ok: boolean;
  status: string;
  exitCode: number;
  /** True when `output` is SSM's capped inline copy rather than the full CloudWatch one. */
  truncated: boolean;
}

/**
 * Why output can be missing or short, for the error/warning message. Reading it back
 * from CloudWatch is what makes output unbounded, so when that comes up empty the
 * instance's SSM Agent almost certainly can't write to the log group.
 */
function truncationExplanation(instanceId: string): string {
  return (
    `Output of the command on ${instanceId} was capped by SSM and could not be read back in full from CloudWatch ` +
    `Logs (log group ${SSM_LOG_GROUP_NAME} had no events for it). The instance's SSM Agent most likely can't write ` +
    `there — check that its instance profile grants logs:CreateLogStream/PutLogEvents on that log group ` +
    `(terraform/aws/ssm-instance-role.tf).`
  );
}

async function runShellCommandCaptured(instanceId: string, remoteCmd: string, runAsUser: string): Promise<CapturedResult> {
  const { commandId } = await sendShellCommand(instanceId, remoteCmd, runAsUser);
  const result = await pollUntilDone(instanceId, commandId);
  // A non-empty inline output means the command definitely produced output, so an empty
  // CloudWatch read at this point is ingestion lag rather than a genuinely silent
  // command - wait it out instead of falling straight through to the capped inline copy.
  const fromLogs = await settledLogLines(commandId, instanceId, 0, result.inline.combined.length > 0);
  void deleteLogStreams(commandId, instanceId);
  // Falling back to GetCommandInvocation's inline content is fine as far as it goes, but
  // it is capped. Whether that matters depends on the caller: harmless for output only
  // shown to a human, corrupting for output parsed as data - see capture().
  const output = fromLogs.combined ? fromLogs : result.inline;
  return {
    output,
    ok: result.status === "Success",
    status: result.status,
    exitCode: result.exitCode,
    truncated: !fromLogs.combined && INLINE_TRUNCATION_MARKER.test(result.inline.combined),
  };
}

export class SsmTarget implements ExecutionTarget {
  readonly kind = "remote" as const;
  readonly description: string;

  constructor(readonly instanceId: string, readonly runAsUser: string = DEFAULT_SSM_USER) {
    this.description = instanceId;
  }

  private echo(command: string, args: readonly string[], opts?: RunOptions): void {
    if (opts?.quiet) return;
    echoCommand(opts?.display ?? commandOn(formatCommandLine(command, args), this.description));
  }

  async run(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<void> {
    this.echo(command, args, opts);
    // Honour greyTextOutput the same way proc.ts's local `run` does: the L3
    // heartbeat is the caller (remote-fit-execution-context's
    // streamToArtifactFile), and its proof-of-life lines should read as
    // visually secondary on a remote run just as they do locally.
    const greyText = opts?.greyTextOutput ?? false;
    if (greyText) startGreyTextOutput();
    try {
      await runShellCommandStreamed(this.instanceId, buildRemoteCommand(command, args, cwd), this.runAsUser);
    } finally {
      if (greyText) stopGreyTextOutput();
    }
  }

  async capture(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<string> {
    this.echo(command, args, opts);
    const result = await runShellCommandCaptured(this.instanceId, buildRemoteCommand(command, args, cwd), this.runAsUser);
    writeCommandOutputToDebugLog(result.output.combined);
    if (!result.ok) {
      // Failures explain themselves on stderr far more often than on stdout, so lead
      // with it and fall back to stdout for the commands that don't use it.
      const detail = result.output.stderr.trim() || result.output.stdout.trim();
      throw new Error(`${command} on ${this.instanceId} exited with status ${result.status} (code ${result.exitCode})${detail ? `: ${detail}` : ""}`);
    }
    // capture()'s callers consume the output as data, so handing back a truncated copy
    // corrupts them silently. That cost us a whole run once: a truncated `docker inspect`
    // failed to parse, the performer was started off the cluster's Docker network, and
    // the only symptom was the SDK timing out on connect much later.
    if (result.truncated) {
      throw new Error(truncationExplanation(this.instanceId));
    }
    // stdout only — see StreamedOutput. Mixing stderr in here is what produced
    // "Malformed connection string" from an otherwise healthy CNG cluster.
    return result.output.stdout;
  }

  async runHiddenUntilFailure(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<void> {
    this.echo(command, args, opts);
    const result = await runShellCommandCaptured(this.instanceId, buildRemoteCommand(command, args, cwd), this.runAsUser);
    writeCommandOutputToDebugLog(result.output.combined);
    if (!result.ok) {
      // Dumped for a human to read, so both streams, interleaved as they were emitted.
      const dump = result.output.combined;
      if (dump) process.stderr.write(dump.endsWith("\n") ? dump : `${dump}\n`);
      if (result.truncated) fitCliWarn(truncationExplanation(this.instanceId));
      throw new Error(`${command} on ${this.instanceId} exited with status ${result.status} (code ${result.exitCode})`);
    }
  }

  putFile(localPath: string, remotePath: string): Promise<void> {
    return ssmPutFile(this, localPath, remotePath);
  }

  getFile(remotePath: string, localPath: string, sizeBytes?: number): Promise<void> {
    return ssmGetFile(this, remotePath, localPath, sizeBytes);
  }
}
