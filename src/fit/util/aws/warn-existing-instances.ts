/**
 * warn-existing-instances — a preflight we run before provisioning a fresh box:
 * list the EC2 instances fit-cli already owns and warn about any that exist, so a
 * forgotten, still-billing instance is noticed before a new one is launched on top
 * of it.
 *
 * "The usual" filter set: the fixed region, owned by fit (the fit-cli ownership
 * tag), and the same owner — implicit, since describe-instances only ever sees the
 * account the current credentials belong to. This is the FIT-specific opinion (the
 * ownership tag, the wording of the warning); the listing plumbing it composes
 * lives in cloud/util/aws.
 *
 * Run on its own:
 *   bun src/fit/util/aws/warn-existing-instances.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { logAwsAction } from "../../../cloud/util/aws/aws-cli.js";
import { callerCreator, checkAwsCredentials } from "../../../cloud/util/aws/identity.js";
import { listInstances, LIVE_STATES } from "../../../cloud/util/aws/list-instances.js";
import { type InstanceInfo } from "../../../cloud/util/aws/parse-instance.js";
import { fitCliWarn } from "../../../util/non-fit/fit-cli-log.js";
import { FIT_OWNER_TAG } from "./fit-instance.js";
import { formatExistingInstancesBanner, type InstanceListContext } from "./lifecycle-warning.js";

/**
 * List the fit-owned instances already running and warn about each one, so the
 * user can reap a forgotten box before launching another. Returns the instances
 * found (empty if none), so callers can branch on the result if they want; on its
 * own it only warns and never blocks provisioning.
 *
 * Pass `{ warn: false }` to suppress the banner and only return the instance
 * list (useful when the caller will display its own combined banner).
 */
export async function warnAboutExistingInstances(
  context?: InstanceListContext,
  { warn = true, creator }: { warn?: boolean; creator?: string } = {},
): Promise<InstanceInfo[]> {
  const all = await listInstances(FIT_OWNER_TAG);
  const existing = creator ? all.filter((i) => i.creator === creator) : all;
  if (existing.length === 0 || !warn) {
    return existing;
  }

  fitCliWarn(`\n${formatExistingInstancesBanner(existing, context)}\n`);
  return existing;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const creds = await checkAwsCredentials();
    logAwsAction("Checking for existing fit-cli EC2 instances", {
      tag: `${FIT_OWNER_TAG.key}=${FIT_OWNER_TAG.value}`,
      states: LIVE_STATES,
    });
    const context: InstanceListContext | undefined = creds.ok
      ? { account: creds.identity.account, creator: callerCreator(creds.identity) }
      : undefined;
    const creator = context?.creator;
    const existing = await warnAboutExistingInstances(context, { creator });
    if (existing.length === 0) {
      console.log("No existing fit-cli EC2 instances — clear to provision.");
    }
  });
}
