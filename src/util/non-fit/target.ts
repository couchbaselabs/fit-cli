/**
 * target — an execution target: somewhere commands run and files live. The point
 * of the abstraction is that a workflow can be handed a target and not care
 * whether it's the local machine or a remote box. Implementations live
 * alongside this file: LocalTarget (local-target.ts), SsmTarget
 * (ssm-target.ts, backed by AWS SSM SendCommand), and IapTarget
 * (iap-target.ts, a GCP instance reached over an IAP-tunneled SSH connection).
 *
 * This is deliberately generic — nothing AWS- or FIT-specific. It mirrors the
 * shape of proc.ts (run / capture) plus file transfer, so a caller currently
 * using proc.ts directly can be moved onto a target with minimal change.
 */
import type { RunOptions } from "./proc.js";

/** Somewhere commands run and files can be put/fetched. */
export interface ExecutionTarget {
  /** "local" for this machine, "remote" for a box reached over SSM. */
  readonly kind: "local" | "remote";
  /** Short human-readable description, e.g. "this machine" or "ubuntu@1.2.3.4". */
  readonly description: string;
  /**
   * Whether a running command's output reaches us as it happens. True for a pipe (local
   * processes, IAP's ssh); false for SSM, which batches through CloudWatch Logs and can
   * fail to deliver at all. It decides where L3 proof-of-life comes from: a command on a
   * live-streaming target can cheaply tail its own log file in-band, while on SSM the
   * command stays silent and the target tails `livenessPath` out-of-band instead.
   */
  readonly streamsOutputLive: boolean;

  /** Run a command, streaming its output, resolving when it finishes (rejects non-zero). */
  run(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<void>;

  /** Run a command and resolve with its captured stdout. */
  capture(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<string>;

  /**
   * Run a command, hiding its output unless it fails. On success the output is
   * silently discarded; on failure it is dumped to the terminal before rejecting.
   * In both cases output is written to the debug log if one is active.
   */
  runHiddenUntilFailure(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<void>;

  /** Copy a local file to `remotePath` on the target. */
  putFile(localPath: string, remotePath: string): Promise<void>;

  /**
   * Copy `remotePath` on the target down to a local file. `sizeBytes`, when
   * known ahead of time, is included in the echoed command so large transfers
   * (e.g. compressed logs) show how much data is about to move.
   */
  getFile(remotePath: string, localPath: string, sizeBytes?: number): Promise<void>;

  /**
   * Resolve the actual login user on the target, when it can differ from the
   * usual convention. Only implemented where that's true (GCP's IapTarget,
   * where OS Login maps the caller's IAM identity to a POSIX account that has
   * nothing to do with the user requested on the SSH command line). Targets
   * where the login user is fixed by convention (AWS's SsmTarget, always
   * "ubuntu") don't implement this.
   */
  resolveLoginUser?(): Promise<string>;
}
