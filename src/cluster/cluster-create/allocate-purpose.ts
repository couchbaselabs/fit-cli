/**
 * The stamp for one fit-cli run, and the test for whether a stamp is one of ours.
 *
 * Every cluster the run allocates carries the stamp as its cbdinocluster purpose,
 * and FIT puts it in front of the purpose of each cluster it allocates. Teardown
 * removes the run's leftover Capella clusters by this stamp. It also names the
 * run's Capella API key pool, and ties a leaked resource back to the run that
 * made it. The value is visible to anyone who can see those resources, so it
 * carries nothing secret.
 */
import { randomBytes } from "node:crypto";
import { runTimestamp } from "../../util/non-fit/replay.js";

/**
 * Marks a stamp as fit-cli's. Anything that matches on ownership keys off this
 * prefix, so changing it strands everything already running.
 */
export const FITCLI_PURPOSE_PREFIX = "fitcli-";

/**
 * A fresh stamp, `fitcli-<YYYYMMDD-HHMMSS>-<8 hex>`. Each call returns a new one.
 * The random part keeps runs that start in the same second apart. The length is
 * fixed at 31, so no stamp is a prefix of another. Tools downstream extend it and
 * some cap its length, so it stays short.
 */
export function allocatePurpose(): string {
  return `${FITCLI_PURPOSE_PREFIX}${runTimestamp()}-${randomBytes(4).toString("hex")}`;
}

/**
 * Whether a stamp was made by fit-cli. A missing or empty value is unknown rather
 * than ours.
 */
export function isFitCliPurpose(purpose: string | undefined): boolean {
  return purpose !== undefined && purpose.startsWith(FITCLI_PURPOSE_PREFIX);
}
