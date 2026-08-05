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
 * (terraform/ssm-instance-role.tf). Without that the log group stays empty and
 * every command silently falls back to the capped inline copy.
 */
import { DescribeInstanceInformationCommand, GetCommandInvocationCommand, SendCommandCommand } from "@aws-sdk/client-ssm";
import { DeleteLogStreamCommand, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { cloudWatchLogsClient, ssmClient } from "../../cloud/util/aws/aws-clients.js";
import { ensureSsmLogGroup } from "../../cloud/util/aws/ssm-log-group.js";
import { commandOn, echoCommand, fitCliWarn, formatCommandLine, startGreyTextOutput, stopGreyTextOutput } from "./fit-cli-log.js";
import { buildRemoteCommand, posixQuote } from "./remote-target.js";
import { writeCommandOutputToDebugLog, type RunOptions } from "./proc.js";
import type { ExecutionTarget } from "./target.js";
import { ssmGetFile, ssmPutFile } from "./ssm-file-relay.js";

/** Login user commands run as. AWS-RunShellScript itself runs as root; we sudo -u into this so home dir, env and group membership (e.g. docker) match today's SSH login user. */
export const DEFAULT_SSM_USER = "ubuntu";

const SSM_LOG_GROUP_NAME = "/fit-cli/ssm-command-output";
const SSM_LOG_RETENTION_DAYS = 3;
const POLL_INTERVAL_MS = 1_500;
// Unlike ssh.ts's ServerAliveInterval (an idle timeout that never fires on an active
// connection), SSM's TimeoutSeconds is a hard ceiling regardless of activity — a healthy,
// actively-producing command gets killed at this deadline just the same as a hung one.
// Set to match the GHA run cap (specs/timers-and-lifetimes.md) since no run should need
// longer than that anyway.
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
 * eventual-consistency gap, not a caller bug), or a malformed response that
 * never made it into a modeled exception. That last case shows up as a bare
 * `Error` with an empty name/message: @smithy/core's deserializer occasionally
 * can't parse an SSM error body (seen on the command issued right after a
 * multi-hour AWS-RunShellScript invocation completes) and throws before
 * attaching one, leaving only `$metadata.httpStatusCode` to go on. Treating
 * that shape as transient too lets a one-off glitch retry instead of taking
 * the whole run down. Exported so callers that catch SsmTarget errors higher
 * up can apply the same test (mirrors ssh.ts's isTransientSshError).
 */
export function isTransientSsmError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (/Throttling|InvalidInstanceId|InvocationDoesNotExist/.test(err.name) || /Throttling|InvalidInstanceId|InvocationDoesNotExist/.test(err.message)) return true;
  const metadata = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return !err.name && !err.message && metadata?.httpStatusCode !== undefined && metadata.httpStatusCode >= 400;
}

const SSM_RETRY_ATTEMPTS = 3;
const SSM_RETRY_DELAY_MS = 3_000;

async function withSsmRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= SSM_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientSsmError(err) || attempt === SSM_RETRY_ATTEMPTS) throw err;
      console.error(`[ssm] transient error (attempt ${attempt}/${SSM_RETRY_ATTEMPTS}), retrying in ${SSM_RETRY_DELAY_MS / 1000}s…`);
      await sleep(SSM_RETRY_DELAY_MS);
    }
  }
  throw new Error("withSsmRetry: unreachable");
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
  inlineOutput: string;
}

async function getInvocationStatus(instanceId: string, commandId: string): Promise<InvocationStatus> {
  const resp = await ssmClient.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }));
  const status = resp.Status ?? "Pending";
  return {
    done: TERMINAL_STATUSES.has(status),
    status,
    exitCode: resp.ResponseCode ?? (status === "Success" ? 0 : 1),
    inlineOutput: (resp.StandardOutputContent ?? "") + (resp.StandardErrorContent ?? ""),
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
async function fetchNewLogLines(commandId: string, instanceId: string, afterMs: number): Promise<{ text: string; lastMs: number }> {
  let lastMs = afterMs;
  const lines: string[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await cloudWatchLogsClient.send(new FilterLogEventsCommand({
      logGroupName: SSM_LOG_GROUP_NAME,
      logStreamNamePrefix: `${commandId}/${instanceId}`,
      ...(afterMs > 0 ? { startTime: afterMs + 1 } : {}),
      nextToken,
    }));
    for (const event of resp.events ?? []) {
      if (event.message) lines.push(event.message);
      if (event.timestamp && event.timestamp > lastMs) lastMs = event.timestamp;
    }
    nextToken = resp.nextToken;
  } while (nextToken);
  return { text: lines.join(""), lastMs };
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
async function settledLogLines(commandId: string, instanceId: string, afterMs: number, expectOutput: boolean): Promise<string> {
  const deadline = Date.now() + OUTPUT_SETTLE_TIMEOUT_MS;
  for (;;) {
    const { text } = await fetchNewLogLines(commandId, instanceId, afterMs);
    if (text || !expectOutput || Date.now() >= deadline) return text;
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
  for (const suffix of ["stdout", "stderr"]) {
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
    Parameters: { commands: [script] },
    TimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    CloudWatchOutputConfig: { CloudWatchLogGroupName: SSM_LOG_GROUP_NAME, CloudWatchOutputEnabled: true },
  })));
  const commandId = resp.Command?.CommandId;
  if (!commandId) throw new Error(`SendCommand on ${instanceId} returned no CommandId.`);
  return { commandId };
}

async function runShellCommandStreamed(instanceId: string, remoteCmd: string, runAsUser: string): Promise<void> {
  const { commandId } = await sendShellCommand(instanceId, remoteCmd, runAsUser);
  let lastMs = 0;
  let wroteAnything = false;
  for (;;) {
    const chunk = await fetchNewLogLines(commandId, instanceId, lastMs);
    if (chunk.text) {
      process.stdout.write(chunk.text);
      wroteAnything = true;
    }
    lastMs = chunk.lastMs;

    const status = await withSsmRetry(() => getInvocationStatus(instanceId, commandId));
    if (status.done) {
      const tail = await settledLogLines(commandId, instanceId, lastMs, status.inlineOutput.length > 0 && !wroteAnything);
      if (tail) {
        process.stdout.write(tail);
        wroteAnything = true;
      }
      // With CloudWatch output unavailable there is nothing to stream, so fall back to
      // the inline content so the user still sees something rather than silence.
      if (!wroteAnything && status.inlineOutput) process.stdout.write(status.inlineOutput);
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
  output: string;
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
    `(terraform/ssm-instance-role.tf).`
  );
}

async function runShellCommandCaptured(instanceId: string, remoteCmd: string, runAsUser: string): Promise<CapturedResult> {
  const { commandId } = await sendShellCommand(instanceId, remoteCmd, runAsUser);
  const result = await pollUntilDone(instanceId, commandId);
  // A non-empty inline output means the command definitely produced output, so an empty
  // CloudWatch read at this point is ingestion lag rather than a genuinely silent
  // command - wait it out instead of falling straight through to the capped inline copy.
  const text = await settledLogLines(commandId, instanceId, 0, result.inlineOutput.length > 0);
  void deleteLogStreams(commandId, instanceId);
  // Falling back to GetCommandInvocation's inline content is fine as far as it goes, but
  // it is capped. Whether that matters depends on the caller: harmless for output only
  // shown to a human, corrupting for output parsed as data - see capture().
  const output = text || result.inlineOutput;
  return {
    output,
    ok: result.status === "Success",
    status: result.status,
    exitCode: result.exitCode,
    truncated: !text && INLINE_TRUNCATION_MARKER.test(result.inlineOutput),
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
    writeCommandOutputToDebugLog(result.output);
    if (!result.ok) {
      const detail = result.output.trim();
      throw new Error(`${command} on ${this.instanceId} exited with status ${result.status} (code ${result.exitCode})${detail ? `: ${detail}` : ""}`);
    }
    // capture()'s callers consume the output as data, so handing back a truncated copy
    // corrupts them silently. That cost us a whole run once: a truncated `docker inspect`
    // failed to parse, the performer was started off the cluster's Docker network, and
    // the only symptom was the SDK timing out on connect much later.
    if (result.truncated) {
      throw new Error(truncationExplanation(this.instanceId));
    }
    return result.output;
  }

  async runHiddenUntilFailure(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<void> {
    this.echo(command, args, opts);
    const result = await runShellCommandCaptured(this.instanceId, buildRemoteCommand(command, args, cwd), this.runAsUser);
    writeCommandOutputToDebugLog(result.output);
    if (!result.ok) {
      if (result.output) process.stderr.write(result.output.endsWith("\n") ? result.output : `${result.output}\n`);
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
