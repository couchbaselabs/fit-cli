/**
 * instances-cli — the AWS-specific logic behind cloud-instances' list/remove/
 * remove-all/manage subcommands. cloud-instances.ts is glue: it parses argv,
 * decides which cloud(s) to call, and renders the combined table; the actual
 * AWS work (credential checks, filtering, confirmation prompts, termination)
 * lives here. Mirrors ../gcp/instances-cli.ts.
 */
import { logAwsAction } from "./aws-cli.js";
import { AWS_REGION } from "./aws-target.js";
import { callerCreator, checkAwsCredentials } from "./identity.js";
import { listInstances, LIVE_STATES } from "./list-instances.js";
import { terminateInstance } from "./terminate-instance.js";
import { describeInstance } from "./describe-instance.js";
import { deleteKeyPair } from "./key-pair.js";
import * as instanceAge from "./instance-age.js";
import { confirm } from "../../../util/non-fit/prompts.js";
import { FIT_OWNER_TAG } from "../../../fit/util/aws/fit-instance.js";
import {
  formatExistingInstancesBanner,
  terminateInstanceCommand,
  type InstanceListContext,
} from "../../../fit/util/aws/lifecycle-warning.js";
import { manageInstances, type InstanceQuery } from "./manage-instances.js";
import type { InstanceRow } from "../instance-row.js";

export { AWS_REGION };
export type { InstanceQuery };

export async function listInstanceRows(allUsers: boolean): Promise<InstanceRow[]> {
  const creds = await checkAwsCredentials();
  const creator = creds.ok ? callerCreator(creds.identity) : undefined;

  if (!allUsers && !creds.ok) {
    throw new Error(
      "Can't determine who you are from AWS credentials, so can't scope listing to your own instances. " +
        "Fix your credentials, or pass --all-users to list every fit-cli instance.",
    );
  }

  logAwsAction("Listing fit-cli EC2 instances", {
    tag: `${FIT_OWNER_TAG.key}=${FIT_OWNER_TAG.value}`,
    states: LIVE_STATES,
    scope: allUsers ? "all users" : "current user",
  });

  const all = await listInstances(FIT_OWNER_TAG);
  const instances = allUsers ? all : all.filter((i) => i.creator === creator);
  return instances.map((i) => ({
    cloud: "AWS" as const,
    id: i.instanceId,
    address: i.publicDns || i.publicIp || "-",
    state: i.state,
    creator: i.creator ?? "-",
  }));
}

/** Used by cloud-instances.ts's `remove` to auto-detect which cloud an identifier belongs to. */
export async function findInstance(identifier: string): Promise<boolean> {
  const creds = await checkAwsCredentials();
  if (!creds.ok) return false;
  return Boolean(await describeInstance(identifier).catch(() => null));
}

export async function removeInstance(instanceId: string, force: boolean): Promise<void> {
  const creds = await checkAwsCredentials();
  if (!creds.ok) {
    throw new Error(creds.message);
  }
  logAwsAction("Terminating EC2 instance", { instanceId });

  const info = await describeInstance(instanceId);
  if (!info) {
    throw new Error(`Instance ${instanceId} not found in ${AWS_REGION}.`);
  }

  const addr = info.publicDns || info.publicIp;
  const creatorPart = info.creator ? `  created-by: ${info.creator}` : "";
  console.log(`Instance: ${instanceId}${addr ? ` (${addr})` : ""}${creatorPart}  state: ${info.state}`);
  console.log(`Terminate command: ${terminateInstanceCommand(instanceId)}`);

  if (!force) {
    const confirmed = await confirm({
      promptId: "cloud-instances.remove.confirm",
      message: `Terminate ${instanceId}? This cannot be undone.`,
      default: false,
    });
    if (!confirmed) {
      console.log("Cancelled — instance left running.");
      return;
    }
  }

  await terminateInstance(instanceId);
  console.log(`✓ Terminating ${instanceId}`);

  if (info.keyName) {
    try {
      await deleteKeyPair(info.keyName);
      console.log(`✓ Deleted key pair ${info.keyName}`);
    } catch (err) {
      console.error(`✗ Failed to delete key pair ${info.keyName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function removeAllInstances(opts: {
  allUsers: boolean;
  force: boolean;
  dryRun: boolean;
  olderThan?: string;
}): Promise<void> {
  const { allUsers, force, dryRun, olderThan } = opts;
  // Parse up front so a bad duration fails before we touch AWS.
  const cutoffMs = olderThan !== undefined ? instanceAge.parseDuration(olderThan) : undefined;

  const creds = await checkAwsCredentials();

  logAwsAction("Removing fit-cli EC2 instances", {
    tag: `${FIT_OWNER_TAG.key}=${FIT_OWNER_TAG.value}`,
    states: LIVE_STATES,
    scope: allUsers ? "all users" : "current user",
    ...(olderThan !== undefined ? { olderThan } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  });

  const context: InstanceListContext | undefined = creds.ok
    ? { account: creds.identity.account, creator: callerCreator(creds.identity) }
    : undefined;
  if (!allUsers && !creds.ok) {
    throw new Error(
      "Can't determine who you are from AWS credentials, so can't scope removal to your own instances. " +
        "Fix your credentials, or pass --all-users to remove every fit-cli instance.",
    );
  }

  const all = await listInstances(FIT_OWNER_TAG);
  const scoped = allUsers ? all : all.filter((instance) => instance.creator === context?.creator);

  // Age-gate when asked. Anything younger than the cutoff (or whose age we can't
  // determine) is left alone — see selectAgedOut.
  let mine = scoped;
  if (cutoffMs !== undefined) {
    const now = Date.now();
    const { reap, keep } = instanceAge.selectAgedOut(scoped, cutoffMs, now);
    mine = reap;
    if (keep.length > 0) {
      console.log(
        `Skipping ${keep.length} instance(s) younger than ${olderThan} (or with unknown age): ` +
          keep
            .map((i) => {
              const age = instanceAge.instanceAgeMs(i, now);
              return `${i.instanceId} (${age === undefined ? "age unknown" : instanceAge.formatAge(age)})`;
            })
            .join(", "),
      );
    }
  }

  if (mine.length === 0) {
    const scope = allUsers ? "" : ` created by ${context?.creator}`;
    const ageNote = cutoffMs !== undefined ? ` older than ${olderThan}` : "";
    console.log(`No fit-cli EC2 instances${scope}${ageNote} found in ${AWS_REGION}.`);
    return;
  }

  console.log(formatExistingInstancesBanner(mine, context));

  if (dryRun) {
    console.log(`\nDry run — would terminate ${mine.length} instance(s); leaving them running.`);
    return;
  }

  if (!force) {
    const confirmed = await confirm({
      promptId: "cloud-instances.remove-all.confirm",
      message: `Terminate all ${mine.length} instance(s) above? This cannot be undone.`,
      default: false,
    });
    if (!confirmed) {
      console.log("Cancelled — instances left running.");
      return;
    }
  }

  const failures: { instanceId: string; error: string }[] = [];
  for (const instance of mine) {
    try {
      await terminateInstance(instance.instanceId);
      console.log(`✓ Terminating ${instance.instanceId}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failures.push({ instanceId: instance.instanceId, error });
      console.error(`✗ Failed to terminate ${instance.instanceId}: ${error}`);
      continue;
    }

    if (instance.keyName) {
      try {
        await deleteKeyPair(instance.keyName);
        console.log(`✓ Deleted key pair ${instance.keyName}`);
      } catch (err) {
        console.error(`✗ Failed to delete key pair ${instance.keyName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to terminate ${failures.length} of ${mine.length} instance(s).`);
  }
  console.log(`\n✓ Terminating ${mine.length} instance(s).`);
}

export async function manageInstancesCli(opts: { allUsers: boolean; query: InstanceQuery }): Promise<void> {
  const { allUsers, query } = opts;
  const creds = await checkAwsCredentials();
  const creator = creds.ok ? callerCreator(creds.identity) : undefined;

  if (!allUsers && !creator) {
    throw new Error(
      "Can't determine who you are from AWS credentials, so can't scope manage to your own instances. " +
        "Fix your credentials, or pass --all-users to manage every fit-cli instance.",
    );
  }

  logAwsAction(
    "Managing EC2 instances",
    query.kind === "key"
      ? { keyName: query.keyName, states: LIVE_STATES, scope: allUsers ? "all users" : "current user" }
      : {
          tag: query.tag ? `${query.tag.key}=${query.tag.value}` : "fit-cli=owned",
          states: LIVE_STATES,
          scope: allUsers ? "all users" : "current user",
        },
  );

  await manageInstances(query, allUsers ? undefined : creator);
}
