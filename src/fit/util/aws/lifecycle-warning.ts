import { type InstanceInfo } from "../../../cloud/util/aws/parse-instance.js";
import { AWS_REGION } from "../../../cloud/util/aws/aws-target.js";
import { runScriptPrefix } from "../../../util/non-fit/fit-cli-log.js";
import { instanceAgeMs, formatAge } from "../../../cloud/util/aws/instance-age.js";

export function formatBanner(title: string, lines: string[]): string {
  const content = [title, ...lines];
  const width = Math.max(...content.map((line) => line.length), 24) + 4;
  const border = "=".repeat(width);
  return [
    border,
    ...content.map((line) => `= ${line.padEnd(width - 4)} =`),
    border,
  ].join("\n");
}

function formatLaunchInfo(inst: InstanceInfo): string {
  if (!inst.launchTime) return "";
  const age = instanceAgeMs(inst, Date.now());
  const ageStr = age !== undefined ? `  age: ${formatAge(age)}` : "";
  return `  created: ${inst.launchTime}${ageStr}`;
}

export function terminateInstanceCommand(instanceId: string): string {
  return `bun src/cloud/util/aws/terminate-instance.ts --id ${instanceId}`;
}

/**
 * The human debug-access command: a real interactive shell over SSM Session
 * Manager. No SSH key, no open port — just `ssm:StartSession` IAM permission
 * and the `session-manager-plugin` binary (fine for a human at a terminal;
 * fit-cli's own automation uses SendCommand instead, which needs neither).
 */
export function ssmStartSessionCommand(instanceId: string): string {
  return `aws ssm start-session --target ${instanceId} --region ${AWS_REGION}`;
}

export function formatEc2DeletionResponsibilityBanner(
  instanceId: string,
  address?: string,
  otherInstances?: InstanceInfo[],
  context?: InstanceListContext,
  interactive?: boolean,
): string {
  const lines: string[] = [
    `Instance: ${instanceId}${address ? ` (${address})` : ""}`,
    `Region: ${AWS_REGION}`,
  ];
  if (context?.account || context?.creator) {
    const parts: string[] = [];
    if (context.account) parts.push(`account: ${context.account}`);
    if (context.creator) parts.push(`user: ${context.creator}`);
    lines.push(parts.join("  ·  "));
  }
  const cleanupLine = interactive
    ? "fit-cli will offer to delete it at the end of the run."
    : "fit-cli will automatically delete it at the end of the run.";
  lines.push(
    `Console: ${awsConsoleInstancesUrl()}`,
    "",
    "This instance keeps incurring AWS charges until it is terminated.",
    cleanupLine,
    "If you keep it running, or leave before cleanup, you must delete it yourself.",
    "Terminate it with:",
    `  ${terminateInstanceCommand(instanceId)}`,
    "",
    "Or sweep all your instances older than a given age, e.g.:",
    `  ${runScriptPrefix("cloud-instances")} remove-all --older-than 2h`,
    "",
    "Automated cleanup: a scheduled job terminates fit-cli instances older than 24h.",
    "  https://github.com/couchbaselabs/fit-cli/actions/workflows/cleanup-instances.yaml",
  );
  if (otherInstances && otherInstances.length > 0) {
    const uniqueOwners = [...new Set(otherInstances.map((i) => i.creator).filter(Boolean))];
    const ownerStr = uniqueOwners.length > 0 ? `, owned by: ${uniqueOwners.join(", ")}` : "";
    lines.push(
      "",
      `${otherInstances.length} other fit-cli instance${otherInstances.length === 1 ? "" : "s"} also running in ${AWS_REGION}${ownerStr} — each keeps incurring AWS charges:`,
    );
    for (const inst of otherInstances) {
      const addr = inst.publicDns || inst.publicIp || "";
      const creator = inst.creator ? `  created-by: ${inst.creator}` : "";
      const launch = formatLaunchInfo(inst);
      lines.push(`  ${inst.instanceId}${addr ? ` (${addr})` : ""}${creator}${launch}`);
      lines.push(`    terminate: ${terminateInstanceCommand(inst.instanceId)}`);
    }
    const allIds = [instanceId, ...otherInstances.map((i) => i.instanceId)];
    lines.push(
      "",
      `Delete all ${allIds.length} in one shot with:`,
      `  aws --region ${AWS_REGION} ec2 terminate-instances --instance-ids ${allIds.join(" ")}`,
      "",
      "Or manage them interactively with:",
      `  ${runScriptPrefix("cloud-instances")} manage`,
    );
  }
  return formatBanner("EC2 LIFECYCLE WARNING", lines);
}

export interface InstanceListContext {
  account?: string;
  creator?: string;
}

/** AWS console URL pre-filtered to the fit-cli tag in the fixed region. */
export function awsConsoleInstancesUrl(): string {
  return (
    `https://${AWS_REGION}.console.aws.amazon.com/ec2/home` +
    `?region=${AWS_REGION}#Instances:v=3;tag:fit-cli=owned`
  );
}

export function formatExistingInstancesBanner(
  instances: InstanceInfo[],
  context?: InstanceListContext,
): string {
  const count = instances.length;
  const lines: string[] = [`Region: ${AWS_REGION}`];
  if (context?.account || context?.creator) {
    const parts: string[] = ["Filter: tag:fit-cli=owned"];
    if (context.account) parts.push(`account: ${context.account}`);
    if (context.creator) parts.push(`user: ${context.creator}`);
    lines.push(parts.join("  ·  "));
  } else {
    lines.push("Filter: tag:fit-cli=owned");
  }
  lines.push(`Console: ${awsConsoleInstancesUrl()}`);
  lines.push("", `${count} instance${count === 1 ? "" : "s"} already running — each keeps incurring AWS charges:`);
  for (const inst of instances) {
    const addr = inst.publicDns || inst.publicIp;
    const creator = inst.creator ? `  created-by: ${inst.creator}` : "";
    const launch = formatLaunchInfo(inst);
    lines.push(`  ${inst.instanceId}${addr ? ` (${addr})` : ""}${creator}${launch}`);
    lines.push(`    terminate: ${terminateInstanceCommand(inst.instanceId)}`);
  }
  lines.push(
    "",
    `Delete ${count === 1 ? "it" : "them all"} in one shot with:`,
    `  aws --region ${AWS_REGION} ec2 terminate-instances --instance-ids ${instances.map((inst) => inst.instanceId).join(" ")}`,
    "",
    "Or sweep only the ones older than a given age, e.g.:",
    `  ${runScriptPrefix("cloud-instances")} remove-all --older-than 2h`,
    "",
    "Or manage them interactively with:",
    `  ${runScriptPrefix("cloud-instances")} manage`,
  );
  return formatBanner("EXISTING FIT-CLI INSTANCES", lines);
}

export function formatEc2CleanupPromptBanner(instanceId: string, address?: string): string {
  return formatBanner("EC2 CLEANUP DECISION", [
    `Instance: ${instanceId}${address ? ` (${address})` : ""}`,
    `Region: ${AWS_REGION}`,
    "This instance is still running and still billable.",
    "Choose No to terminate it now (recommended, and the default).",
    "Choose Yes only if you want to keep debugging and will delete it yourself.",
    "Terminate later with:",
    `  ${terminateInstanceCommand(instanceId)}`,
  ]);
}
