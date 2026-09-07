/**
 * local-target — an ExecutionTarget that runs everything on this machine. It's a
 * thin adapter over proc.ts, with file "transfer" being a plain filesystem copy.
 * This is what the FIT functional flow uses when the user picks "local laptop".
 */
import { copyFileSync } from "node:fs";
import { run, capture, runHiddenUntilFailure, type RunOptions } from "./proc.js";
import type { ExecutionTarget } from "./target.js";

export class LocalTarget implements ExecutionTarget {
  readonly kind = "local" as const;
  readonly streamsOutputLive = true;
  readonly description = "this machine";

  run(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<void> {
    return run(command, args, cwd, opts);
  }

  capture(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<string> {
    return capture(command, args, cwd, opts);
  }

  runHiddenUntilFailure(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<void> {
    return runHiddenUntilFailure(command, args, cwd, opts);
  }

  putFile(localPath: string, remotePath: string): Promise<void> {
    copyFileSync(localPath, remotePath);
    return Promise.resolve();
  }

  getFile(remotePath: string, localPath: string, _sizeBytes?: number): Promise<void> {
    copyFileSync(remotePath, localPath);
    return Promise.resolve();
  }
}
