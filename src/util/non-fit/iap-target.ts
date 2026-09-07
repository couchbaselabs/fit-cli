/**
 * iap-target — an ExecutionTarget backed by an IAP-tunneled SSH connection to
 * a GCP instance (gcp-iap.ts). GCP's counterpart to SsmTarget (EC2 over AWS
 * SSM). Commands run on the remote box; files move with `gcloud compute scp
 * --tunnel-through-iap`. To honour `cwd` the command and its arguments are
 * POSIX-quoted into a single remote command string — see buildRemoteCommand,
 * the same helper SsmTarget uses.
 *
 * Not wired into any instance-provisioning code yet — see gcp-iap.ts's header
 * for why, and working/gcp2.md for the overall GCP port status.
 */
import { commandOn, formatCommandLine } from "./fit-cli-log.js";
import { buildIapSshArgs, DEFAULT_IAP_USER, iapScpDown, iapScpUp, iapSshCapture, iapSshRun, stripOsLoginNotice, type IapHost } from "./gcp-iap.js";
import { runHiddenUntilFailure as runProcHiddenUntilFailure, type RunOptions } from "./proc.js";
import { buildRemoteCommand } from "./remote-target.js";
import type { ExecutionTarget } from "./target.js";

export class IapTarget implements ExecutionTarget {
  readonly kind = "remote" as const;
  // gcloud compute ssh is a real pipe, so output arrives as the command produces it.
  readonly streamsOutputLive = true;
  readonly description: string;
  private loginUser?: Promise<string>;

  constructor(private readonly host: IapHost) {
    this.description = `${host.user ?? DEFAULT_IAP_USER}@${host.instance} (IAP)`;
  }

  /**
   * OS Login ignores the requested `host.user` and maps the caller's IAM
   * identity to its own POSIX account server-side (see IapHost.user's doc),
   * so the only reliable way to learn the actual login user — and thus its
   * home directory — is to ask the box. Cached per-instance since it can't
   * change over the life of this target.
   */
  resolveLoginUser(): Promise<string> {
    if (!this.loginUser) {
      this.loginUser = iapSshCapture(this.host, "whoami", [], { quiet: true }).then((output) => output.trim());
    }
    return this.loginUser;
  }

  /**
   * Echo the *logical* command and host, not the gcloud transport. Callers
   * that already wrapped a command (e.g. in `sh -lc`) pass their own clean
   * `display`, which we leave untouched.
   */
  private displayFor(command: string, args: readonly string[], opts?: RunOptions): RunOptions {
    return { ...opts, display: opts?.display ?? commandOn(formatCommandLine(command, args), this.description) };
  }

  run(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<void> {
    return iapSshRun(this.host, buildRemoteCommand(command, args, cwd), [], this.displayFor(command, args, opts));
  }

  capture(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<string> {
    return iapSshCapture(this.host, buildRemoteCommand(command, args, cwd), [], this.displayFor(command, args, opts));
  }

  runHiddenUntilFailure(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<void> {
    const remoteCmd = buildRemoteCommand(command, args, cwd);
    return runProcHiddenUntilFailure("gcloud", buildIapSshArgs(this.host, remoteCmd), undefined, stripOsLoginNotice(this.displayFor(command, args, opts)));
  }

  putFile(localPath: string, remotePath: string): Promise<void> {
    return iapScpUp(this.host, localPath, remotePath);
  }

  getFile(remotePath: string, localPath: string, sizeBytes?: number): Promise<void> {
    return iapScpDown(this.host, remotePath, localPath, sizeBytes);
  }
}
