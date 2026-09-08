/**
 * parseAllocatedId — pull the cluster UUID out of `cbdinocluster allocate`
 * output. Pure string logic, so it can be unit tested (see
 * tests/parse-allocated-id.test.ts).
 *
 * With `--verbose`, cbdinocluster's INFO/WARN log lines go to stderr and the new
 * cluster's id is printed on its own line on stdout, e.g.:
 *
 *   df45d6d0-cfbe-4905-bc8c-989a09c03817
 *
 * We take the last line that is exactly a UUID, so a stray log line sharing the
 * stream doesn't trip us up.
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";

// A line that is exactly a dashed UUID (8-4-4-4-12 hex): df45d6d0-cfbe-4905-bc8c-989a09c03817
const UUID_LINE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Compact 32-char hex (CNG/CAO deployer): 34cbd9e163264c97af394f6ad05d93e0
const HEX32_LINE = /^[0-9a-f]{32}$/i;

/**
 * Extract the allocated cluster's UUID from `cbdinocluster allocate` output, or
 * null if there isn't one (e.g. allocation printed only logs).
 */
export function parseAllocatedId(output: string): string | null {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (UUID_LINE.test(lines[i]) || HEX32_LINE.test(lines[i])) {
      return lines[i];
    }
  }
  return null;
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const raw = process.argv[2] ?? "";
    console.log(parseAllocatedId(raw) ?? "(no cluster id found)");
    return Promise.resolve();
  });
}
