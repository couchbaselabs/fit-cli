/**
 * ssm-log-group — create-if-missing CloudWatch Logs group that captures SSM
 * SendCommand output (see ../../../util/non-fit/ssm-target.ts). Mirrors the
 * idempotent create-if-missing pattern in security-group.ts.
 *
 * Retention is intentionally short: this group is a transient relay for live
 * command output during a run, not an archive — fit-cli's own run artifacts
 * are the durable record of what a command produced.
 */
import { CreateLogGroupCommand, DescribeLogGroupsCommand, PutRetentionPolicyCommand } from "@aws-sdk/client-cloudwatch-logs";
import { cloudWatchLogsClient } from "./aws-clients.js";

export interface SsmLogGroup {
  name: string;
  arn: string;
}

async function findLogGroup(name: string): Promise<SsmLogGroup | null> {
  const resp = await cloudWatchLogsClient.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: name }));
  const found = resp.logGroups?.find((g) => g.logGroupName === name && g.arn);
  return found?.arn ? { name, arn: found.arn } : null;
}

/**
 * Ensure a CloudWatch Logs group named `name` exists with `retentionDays`
 * retention, returning its name and ARN. Creates the group if it's missing,
 * tolerating a create racing another process.
 */
export async function ensureSsmLogGroup(name: string, retentionDays: number): Promise<SsmLogGroup> {
  const existing = await findLogGroup(name);
  if (existing) return existing;

  try {
    await cloudWatchLogsClient.send(new CreateLogGroupCommand({ logGroupName: name }));
  } catch (err) {
    if (!(err instanceof Error && err.name === "ResourceAlreadyExistsException")) {
      throw err;
    }
  }
  await cloudWatchLogsClient.send(new PutRetentionPolicyCommand({ logGroupName: name, retentionInDays: retentionDays }));

  const created = await findLogGroup(name);
  if (!created) {
    throw new Error(`Created CloudWatch log group ${name} but couldn't read back its ARN.`);
  }
  return created;
}
