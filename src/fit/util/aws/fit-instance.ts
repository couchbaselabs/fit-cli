/**
 * fit-instance — provision a clean EC2 instance for a FIT run. This is the
 * FIT-specific glue that composes the generic AWS plumbing in cloud/util/aws
 * into "give me a box I can run FIT on, and a handle to tear it down". The
 * reusable, FIT-agnostic pieces stay in util/non-fit; only the opinions
 * (instance defaults, the fit-cli ownership tag) live here.
 *
 * Run on its own (provisions a box and prints how to reach it — does NOT
 * terminate it, so you can poke at it; tear it down with the printed command):
 *   bun src/fit/util/aws/fit-instance.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactFromPath, type Artifact, type Detail } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { AWS_REGION, AWS_SUBNET_ID, AWS_VPC_ID } from "../../../cloud/util/aws/aws-target.js";
import { loadEnvironments } from "../../util/environments.js";
import type { PrivateEndpointSetup } from "../../shared/definition/types.js";
import { callerCreator, checkAwsCredentials } from "../../../cloud/util/aws/identity.js";
import { findUbuntuAmi } from "../../../cloud/util/aws/image.js";
import { createInstance, waitForInstanceRunning, type BlockDeviceMapping } from "../../../cloud/util/aws/create-instance.js";
import { describeInstance } from "../../../cloud/util/aws/describe-instance.js";
import { listInstances } from "../../../cloud/util/aws/list-instances.js";
import { type InstanceInfo } from "../../../cloud/util/aws/parse-instance.js";
import { terminateInstance } from "../../../cloud/util/aws/terminate-instance.js";
import { ensureSecurityGroup } from "../../../cloud/util/aws/security-group.js";
import { instanceRunDir } from "../../../util/non-fit/replay.js";
import { instanceLabel } from "../../shared/util/run-labels.js";
import { SsmTarget, waitForSsmReady } from "../../../util/non-fit/ssm-target.js";
import { forceNtpSync } from "../../../util/non-fit/ntp-sync.js";
import { fitCliWarn } from "../../../util/non-fit/fit-cli-log.js";
import { formatBanner, formatEc2DeletionResponsibilityBanner, ssmStartSessionCommand, terminateInstanceCommand } from "./lifecycle-warning.js";
import { warnAboutExistingInstances } from "./warn-existing-instances.js";

/** Security group fit-cli reuses across runs (no ports open — SSM needs none). */
export const FIT_SECURITY_GROUP = "fit-cli";

/** Tag stamped on every box fit-cli launches, so they can be found later. */
export const FIT_OWNER_TAG = { key: "fit-cli", value: "owned" } as const;

/** The box's normal login user — commands run as this user (via SsmTarget's sudo -u), not root. */
export const FIT_INSTANCE_USER = "ubuntu";

/**
 * The EC2 `Name` tag (the display name in the AWS console) for a box fit-cli
 * launches: `fit-cli`, the creating user, and the launch time in UTC down to the
 * minute, so an instance is identifiable at a glance and sorts by launch time.
 * e.g. `fit-cli-alice-20260612-1037`.
 */
export function fitInstanceName(creator: string, now: Date = new Date()): string {
  const iso = now.toISOString(); // 2026-06-12T10:37:00.000Z
  const stamp = `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 16).replace(":", "")}`;
  return `fit-cli-${creator}-${stamp}`;
}

/**
 * Default instance type for FIT EC2 instances.
 *
 * Used as it's what has historically been used for FIT/PERF.
 * Should technically go into the database to allow apples-to-apples comparisons.
 *
 * Override with FIT_EC2_INSTANCE_TYPE.
 */
export function defaultInstanceType(): string {
  return process.env.FIT_EC2_INSTANCE_TYPE ?? "c5.4xlarge";
}

/**
 * Root EBS volume configuration for FIT instances.
 *
 * CBD-5001 - seeing issues with the default 8GB.
 * Bumping as also seeing issues with 50GB:
 * https://couchbase.slack.com/archives/C08FV3X1CCA/p1773408987562519?thread_ts=1773392405.251509&cid=C08FV3X1CCA
 */
export function fitBlockDeviceMappings(): BlockDeviceMapping[] {
  return [
    {
      deviceName: "/dev/sda1",
      volumeSizeGB: 250,
      volumeType: "gp3",
      deleteOnTermination: true,
    },
  ];
}

/** A provisioned EC2 instance, ready to use, with a teardown handle. */
export interface ProvisionedInstance {
  instanceId: string;
  /** Address used to reach it (public DNS, or public IP if DNS is absent). */
  address: string;
  /** An ExecutionTarget that runs commands on this instance over SSM. */
  target: SsmTarget;
  /** Files produced (an instance-info record) for the run summary. */
  artifacts: Artifact[];
  /** Useful commands and facts for debugging and cleanup. */
  details: Detail[];
  /** Terminate the instance. Safe to call once. */
  terminate: () => Promise<void>;
}

/** Options for provisioning (all optional; sensible FIT defaults apply). */
export interface ProvisionOptions {
  instanceType?: string;
  /** Instance this execution target belongs to; its key and info land under that instance dir. */
  instanceIndex?: number;
  /** Whether the run is interactive; affects the lifecycle warning message shown to the user. */
  interactive?: boolean;
  /**
   * When present, launch the instance with the fit-cli VPC's default SG (opened intra-VPC)
   * so it can reach a Capella PrivateLink endpoint, which lands in the same SG.
   */
  privateEndpoint?: PrivateEndpointSetup;
}

/**
 * Provision a fresh EC2 instance suitable for a FIT run: latest Ubuntu LTS and
 * the shared fit-cli security group. Waits until the box is running and
 * registered with SSM before returning. If anything fails after the instance
 * launches, it's terminated so we don't leak a paid box.
 */
export async function provisionFitInstance(options: ProvisionOptions = {}): Promise<ProvisionedInstance> {
  const creds = await checkAwsCredentials();
  if (!creds.ok) {
    throw new Error(`AWS credentials are not usable: ${creds.message}`);
  }
  const creatorTag = callerCreator(creds.identity);

  // Before launching anything, silently fetch fit-cli boxes already running in
  // this region. We suppress the banner here — it will be shown in the
  // post-launch lifecycle warning so the user sees everything in one place.
  // If the account lacks DescribeInstances permission, warn and continue — this
  // is non-fatal; the rest of provisioning may still succeed.
  let existingInstances: InstanceInfo[] = [];
  try {
    existingInstances = await warnAboutExistingInstances(
      { account: creds.identity.account, creator: creatorTag },
      { warn: false, creator: creatorTag },
    );
  } catch (err) {
    fitCliWarn(`Warning: could not check for existing EC2 instances (insufficient permissions): ${err instanceof Error ? err.message : String(err)}`);
  }

  const instanceType = options.instanceType ?? defaultInstanceType();
  const pe = options.privateEndpoint;
  const peDesc = pe ? " [private-endpoint mode]" : "";
  console.log(`Provisioning a ${instanceType} EC2 instance in ${AWS_REGION} (VPC: ${AWS_VPC_ID})${peDesc}...`);

  const amiId = await findUbuntuAmi();
  const securityGroupId = await ensureSecurityGroup(
    { name: FIT_SECURITY_GROUP, description: "fit-cli ephemeral test instances", ingressPorts: [], vpcId: AWS_VPC_ID },
  );

  // Private endpoint mode: also attach the VPC default SG (opened for intra-VPC traffic)
  // so the box can reach the Capella private endpoint that lands in that SG.
  const peVpcSgId = pe ? loadEnvironments().defaults.aws.privateEndpointVpcSgId ?? undefined : undefined;
  const additionalSecurityGroupIds = peVpcSgId ? [peVpcSgId] : undefined;

  if (pe) {
    console.log(`  private endpoint: VPC default SG ${peVpcSgId ?? "(not configured in environments.json5)"}`);
  }

  const ssmInstanceProfileName = loadEnvironments().defaults.aws.ssmInstanceProfileName ?? undefined;
  if (!ssmInstanceProfileName) {
    fitCliWarn(
      "\nWarning: defaults.aws.ssmInstanceProfileName isn't configured in environments.json5 — the launched " +
        "instance won't register with SSM and commands on it will fail. See the SSM migration plan for the AWS-side setup.",
    );
  }

  // Unique per launch attempt: lets a failed launch be swept even if we never
  // captured the instance id (e.g. the RunInstances call threw mid-request).
  const launchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const instanceIdx = options.instanceIndex ?? 0;
  const instancePathObj = { instanceIndex: instanceIdx, dirSegments: { instance: instanceLabel({ instanceIndex: instanceIdx }, "aws") } };
  const instanceDir = instanceRunDir(instancePathObj);
  mkdirSync(instanceDir, { recursive: true, mode: 0o700 });

  let instanceId: string | undefined;
  try {
    instanceId = await createInstance(
      {
        amiId,
        instanceType,
        securityGroupId,
        additionalSecurityGroupIds,
        subnetId: AWS_SUBNET_ID,
        ...(ssmInstanceProfileName ? { iamInstanceProfileName: ssmInstanceProfileName } : {}),
        tags: {
          Name: fitInstanceName(creatorTag),
          [FIT_OWNER_TAG.key]: FIT_OWNER_TAG.value,
          "created-by": creatorTag,
          "fit-cli-launch-id": launchId,
        },
        blockDeviceMappings: fitBlockDeviceMappings(),
      },
    );
    console.log(`  launched ${instanceId}, waiting for it to start...`);
    await waitForInstanceRunning(instanceId);

    const info = await describeInstance(instanceId);
    const address = info?.publicDns || info?.publicIp;
    if (!address) {
      throw new Error(`Instance ${instanceId} is running but has no public address.`);
    }

    process.stdout.write("  waiting for SSM to register...");
    if (!(await waitForSsmReady(instanceId))) {
      throw new Error(`Timed out waiting for ${instanceId} to register with SSM.`);
    }
    console.log(" ready");

    const target = new SsmTarget(instanceId, FIT_INSTANCE_USER);
    // A fresh box's clock can be off until chrony's first sync settles, which is enough to trip
    // tests with a tight elapsed-time margin (see forceNtpSync's doc comment). Best-effort: never
    // blocks provisioning on failure.
    await forceNtpSync(target);

    const id = instanceId;
    const terminate = async (): Promise<void> => {
      await terminateInstance(id);
    };

    const vpcId = info?.vpcId;
    const infoPath = join(instanceDir, "ec2-instance.json");
    writeFileSync(
      infoPath,
      `${JSON.stringify({ instanceId: id, address, region: AWS_REGION, instanceType, ...(vpcId ? { vpcId } : {}) }, null, 2)}\n`,
    );
    const artifacts = [
      artifactFromPath(infoPath, "EC2 test instance details (id, address, region)"),
    ];
    const ssmCommand = ssmStartSessionCommand(id);
    const details = [
      { label: "Debug access (SSM)", value: ssmCommand },
      { label: "Terminate instance command", value: terminateInstanceCommand(id) },
    ];

    console.log(`\n✓ EC2 instance ${id} is ready at ${address}${vpcId ? `  (VPC: ${vpcId})` : ""}`);
    fitCliWarn(`\n${formatEc2DeletionResponsibilityBanner(id, address, existingInstances, { account: creds.identity.account, creator: creatorTag }, options.interactive)}\n`);
    console.log(formatBanner("DEBUG ACCESS (SSM)", [`  ${ssmCommand}`]));
    return { instanceId: id, address, target, artifacts, details, terminate };
  } catch (err) {
    // Don't leave a paid box lying around if bring-up failed. If we never
    // captured the instance id (e.g. launch threw mid-call), sweep by the
    // run's unique launch-id tag so an instance AWS created anyway can't leak.
    const leaked = instanceId
      ? [instanceId]
      : await listInstances({ key: "fit-cli-launch-id", value: launchId })
          .then((found) => found.map((i) => i.instanceId))
          .catch(() => []);
    for (const id of leaked) {
      await terminateInstance(id).catch(() => {});
    }
    throw err;
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const provisioned = await provisionFitInstance();
    console.log(`\nLeaving it running. Terminate when done with:`);
    console.log(`  ${terminateInstanceCommand(provisioned.instanceId)}`);
    return { artifacts: provisioned.artifacts, details: provisioned.details };
  });
}
