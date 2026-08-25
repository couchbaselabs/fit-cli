/**
 * The unique stamp for one fit-cli run, and the test for whether a stamp is one of
 * ours.
 *
 * It currently names the run's Capella API key pool. A run must never rotate or
 * delete another run's keys, so the stamp is built from a timestamp plus a random
 * suffix, which keeps parallel CI runs from colliding. The value ends up visible to
 * anyone who can see the pool, so it carries nothing secret.
 */
import { userInfo } from "node:os";
import { basename } from "node:path";
import { ensureRunDir } from "../../util/non-fit/replay.js";

/**
 * Marks a stamp as fit-cli's. Anything that matches on ownership keys off this
 * prefix, so changing it strands everything already running.
 */
export const FITCLI_PURPOSE_PREFIX = "fitcli-";

/** Reduce a value to the lowercase letters, digits and dashes a stamp should carry. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The stamp for this run, built from the prefix, this run's artifact directory name
 * (e.g. `20260821-154758-ded4`) and whoever started it. That directory name is a
 * timestamp plus a random suffix, so two runs started in the same second still get
 * different stamps. The run id ties a leaked resource back to its artifacts, the
 * username ties it to a person.
 */
export function allocatePurpose(
  runId: string = basename(ensureRunDir()),
  username: string = userInfo().username,
): string {
  return FITCLI_PURPOSE_PREFIX + [slug(runId), slug(username)].filter(Boolean).join("-");
}

/**
 * Whether a stamp was made by fit-cli. A missing or empty value is unknown rather
 * than ours.
 */
export function isFitCliPurpose(purpose: string | undefined): boolean {
  return purpose !== undefined && purpose.startsWith(FITCLI_PURPOSE_PREFIX);
}
