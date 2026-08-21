/**
 * The `--purpose` string fit-cli stamps on every cluster it allocates, and the test
 * for whether a cluster is one of ours.
 *
 * cbdinocluster writes the purpose into the Capella project name, which is the only
 * thing that lets the sweeper tell our leftovers from everyone else's in a shared
 * organization. The value is visible org-wide, so it carries nothing secret.
 */
import { userInfo } from "node:os";
import { basename } from "node:path";
import { ensureRunDir } from "../../util/non-fit/replay.js";

/**
 * Marks a cluster as fit-cli's. The sweeper only ever removes clusters whose
 * purpose starts with this, so changing it strands everything already running.
 */
export const FITCLI_PURPOSE_PREFIX = "fitcli-";

/** Reduce a value to the lowercase letters, digits and dashes a project name should carry. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The purpose for this run: the prefix, this run's artifact directory name (e.g.
 * `20260821-154758-ded4`) and whoever started it. The run id ties a leaked cluster
 * back to its artifacts, the username ties it to a person.
 */
export function allocatePurpose(
  runId: string = basename(ensureRunDir()),
  username: string = userInfo().username,
): string {
  return FITCLI_PURPOSE_PREFIX + [slug(runId), slug(username)].filter(Boolean).join("-");
}

/**
 * Whether a purpose reported by `cbdinocluster ps` marks the cluster as fit-cli's.
 * A cluster with no purpose predates fit-cli stamping one, so ownership is unknown
 * rather than ours.
 */
export function isFitCliPurpose(purpose: string | undefined): boolean {
  return purpose !== undefined && purpose.startsWith(FITCLI_PURPOSE_PREFIX);
}
