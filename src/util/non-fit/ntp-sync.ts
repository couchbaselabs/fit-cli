/**
 * ntp-sync — force an immediate clock sync on a freshly-booted box.
 *
 * A fresh EC2 instance's clock can be off by a few ms to a few seconds until
 * its NTP client (chrony, on the Ubuntu AMIs fit-cli uses) finishes its first
 * sync, which can take a while if left to slew gradually. That's enough to
 * break tests that measure elapsed wall-clock time with a tight margin (see
 * https://github.com/programmatix/couchbase-jvm-clients/actions/runs/28764782620,
 * where a transaction test intermittently measured slightly less than 1 real
 * second because the system clock stepped backwards mid-test).
 *
 * Run on its own against an existing EC2 instance:
 *   bun src/util/non-fit/ntp-sync.ts --dir /tmp/fit-cli/<run>/instances/0
 *   bun src/util/non-fit/ntp-sync.ts --instance i-0123456789abcdef0 [--user ubuntu]
 */
import { readFileSync } from "fs";
import { join } from "path";
import { isMain, runCli } from "./cli.js";
import { fitCliError } from "./fit-cli-log.js";
import { SsmTarget, waitForSsmReady } from "./ssm-target.js";
import type { ExecutionTarget } from "./target.js";

/**
 * The shell script that forces a clock sync. Tries chrony first (what the
 * Ubuntu AMIs fit-cli launches ship with, pre-installed and enabled), falling
 * back to ntpdate or timedatectl if chrony isn't present. `waitsync` blocks
 * until chrony has a valid measurement (bounded by the retry count so this
 * can't hang forever), then `makestep` jumps the clock immediately instead of
 * letting chrony slew it gradually. Every fallback is best-effort (`|| true`)
 * since a box without any of these tools should still be usable — this is a
 * hygiene step, not a hard requirement.
 */
export function forceNtpSyncScript(): string {
  return [
    "if command -v chronyc >/dev/null 2>&1; then",
    "  sudo chronyc waitsync 10 1 0 2 >/dev/null 2>&1 || true",
    "  sudo chronyc makestep || true",
    "elif command -v ntpdate >/dev/null 2>&1; then",
    "  sudo ntpdate -u pool.ntp.org || true",
    "elif command -v timedatectl >/dev/null 2>&1; then",
    "  sudo timedatectl set-ntp true || true",
    "fi",
    "date -u",
  ].join("\n");
}

/** Force an immediate clock sync on `target`. Never throws — logs a warning on failure. */
export async function forceNtpSync(target: ExecutionTarget): Promise<void> {
  console.log(`→ Forcing an NTP clock sync on ${target.description}...`);
  try {
    const output = await target.capture("sh", ["-lc", forceNtpSyncScript()], undefined, { display: "force NTP clock sync" });
    const clockLine = output.trim().split("\n").pop();
    console.log(`  clock is now: ${clockLine}`);
  } catch (err) {
    console.log(`  warning: NTP sync attempt failed, continuing anyway: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);

    if (argv.includes("--help") || argv.includes("-h")) {
      console.log(
        "Usage:\n" +
          "  ntp-sync.ts --dir <instance-dir>\n" +
          "  ntp-sync.ts --instance <ec2-id> [--user ubuntu]\n" +
          "\n" +
          "Options:\n" +
          "  --dir        path to an instance dir (reads ec2-instance.json automatically)\n" +
          "  --instance   EC2 instance ID (e.g. i-0123456789abcdef0)\n" +
          "  --user       login user on the box (default: ubuntu)\n",
      );
      process.exit(0);
    }

    const flag = (name: string): string | undefined => {
      const prefix = `--${name}=`;
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === `--${name}`) return argv[i + 1];
        if (argv[i].startsWith(prefix)) return argv[i].slice(prefix.length);
      }
      return undefined;
    };

    let instanceId = flag("instance");
    const user = flag("user") ?? "ubuntu";

    const instanceDir = flag("dir");
    if (instanceDir) {
      const info = JSON.parse(readFileSync(join(instanceDir, "ec2-instance.json"), "utf8")) as { instanceId?: string };
      instanceId ??= info.instanceId;
    }

    if (!instanceId) {
      fitCliError(
        "Usage:\n" +
          "  ntp-sync.ts --dir <instance-dir>\n" +
          "  ntp-sync.ts --instance <ec2-id> [--user ubuntu]",
      );
      process.exit(1);
    }

    process.stdout.write(`Waiting for ${instanceId} to register with SSM...`);
    if (!(await waitForSsmReady(instanceId))) {
      console.log(" unreachable");
      throw new Error(`Couldn't reach ${instanceId} over SSM. Check the instance id and that it's up.`);
    }
    console.log(" ready");

    await forceNtpSync(new SsmTarget(instanceId, user));

    return {
      details: [{ label: "Instance", value: instanceId }],
    };
  });
}
