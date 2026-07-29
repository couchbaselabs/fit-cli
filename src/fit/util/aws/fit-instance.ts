/**
 * fit-instance — provision a clean EC2 instance for a FIT run. This is the
 * FIT-specific glue that composes the generic AWS/SSH plumbing in
 * cloud/util/aws and util/non-fit/ssh into "give me a box I can run FIT on,
 * and a handle to tear it down". The reusable, FIT-agnostic pieces stay in
 * util/non-fit; only the opinions (instance defaults, the fit-cli ownership
 * tag, where the key lands) live here.
 *
 * Run on its own (provisions a box and prints how to reach it — does NOT
 * terminate it, so you can poke at it; tear it down with the printed command):
 *   bun src/fit/util/aws/fit-instance.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactFromPath, type Artifact, type Detail } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { AWS_REGION, AWS_SUBNET_ID, AWS_VPC_ID } from "../../../cloud/util/aws/aws-target.js";
import { loadEnvironments } from "../../util/environments.js";
import type { PrivateEndpointSetup } from "../../shared/definition/types.js";
import { checkAwsCredentials } from "../../../cloud/util/aws/identity.js";
import { findUbuntuAmi } from "../../../cloud/util/aws/image.js";
import { createInstance, waitForInstanceRunning, type BlockDeviceMapping } from "../../../cloud/util/aws/create-instance.js";
import { describeInstance } from "../../../cloud/util/aws/describe-instance.js";
import { findInstancesByKeyName } from "../../../cloud/util/aws/list-instances.js";
import { type InstanceInfo } from "../../../cloud/util/aws/parse-instance.js";
import { terminateInstance } from "../../../cloud/util/aws/terminate-instance.js";
import { createKeyPair, deleteKeyPair } from "../../../cloud/util/aws/key-pair.js";
import { ensureSecurityGroup } from "../../../cloud/util/aws/security-group.js";
import { instanceRunDir, instanceInternalRunDir } from "../../../util/non-fit/replay.js";
import { instanceLabel } from "../../shared/util/run-labels.js";
import { waitForSsh, type RemoteHost } from "../../../util/non-fit/ssh.js";
import { RemoteTarget } from "../../../util/non-fit/remote-target.js";
import { forceNtpSync } from "../../../util/non-fit/ntp-sync.js";
import { fitCliWarn } from "../../../util/non-fit/fit-cli-log.js";
import { formatBanner, formatEc2DeletionResponsibilityBanner, terminateInstanceCommand } from "./lifecycle-warning.js";
import { warnAboutExistingInstances } from "./warn-existing-instances.js";

/** Security group fit-cli reuses across runs (port 22 open). */
export const FIT_SECURITY_GROUP = "fit-cli";

/** Tag stamped on every box fit-cli launches, so they can be found later. */
export const FIT_OWNER_TAG = { key: "fit-cli", value: "owned" } as const;

/** Login user for manual SSH. */
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
  /** Path to the generated private key on this machine. */
  keyPath: string;
  /** The host descriptor used for SSH. */
  host: RemoteHost;
  /** An ExecutionTarget that runs commands on this instance. */
  target: RemoteTarget;
  /** Files produced (the key, an instance-info record) for the run summary. */
  artifacts: Artifact[];
  /** Useful commands and facts for debugging and cleanup. */
  details: Detail[];
  /** Terminate the instance and delete its key pair. Safe to call once. */
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
 * Provision a fresh EC2 instance suitable for a FIT run: latest Ubuntu LTS, the
 * shared fit-cli security group and a freshly-minted key pair. Waits until the
 * box is running and accepting SSH before returning. If anything fails after
 * the instance launches, it's terminated so we don't leak a paid box.
 */
export async function provisionFitInstance(options: ProvisionOptions = {}): Promise<ProvisionedInstance> {
  const creds = await checkAwsCredentials();
  if (!creds.ok) {
    throw new Error(`AWS credentials are not usable: ${creds.message}`);
  }
  // Last segment of the ARN is the most readable creator identifier:
  //   arn:aws:iam::123:user/alice          → alice
  //   arn:aws:sts::123:assumed-role/R/sess → sess
  const creatorTag = creds.identity.arn.split("/").at(-1) ?? creds.identity.userId;

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
    { name: FIT_SECURITY_GROUP, description: "fit-cli ephemeral test instances", ingressPorts: [22], vpcId: AWS_VPC_ID },
  );

  // Private endpoint mode: also attach the VPC default SG (opened for intra-VPC traffic)
  // so the box can reach the Capella private endpoint that lands in that SG.
  const peVpcSgId = pe ? loadEnvironments().defaults.aws.privateEndpointVpcSgId ?? undefined : undefined;
  const additionalSecurityGroupIds = peVpcSgId ? [peVpcSgId] : undefined;

  if (pe) {
    console.log(`  private endpoint: VPC default SG ${peVpcSgId ?? "(not configured in environments.json5)"}`);
  }

  const keyName = `fit-cli-${Date.now().toString(36)}`;
  const instanceIdx = options.instanceIndex ?? 0;
  const instancePathObj = { instanceIndex: instanceIdx, dirSegments: { instance: instanceLabel({ instanceIndex: instanceIdx }, "aws") } };
  const instanceDir = instanceRunDir(instancePathObj);
  mkdirSync(instanceDir, { recursive: true, mode: 0o700 });
  // The SSH private key should not be uploaded, in case the artifact ever ends up
  // public (which it will not with the current setup).  The key is useless since the
  // instance is removed before the end of the run, but it is not a good look to have
  // keys in artifacts.
  // Keep it in the per-instance _internal dir, which both
  // artifact sinks exclude. Local debug/resume tooling still finds it via the keyPath
  // recorded in ec2-instance.json.

  // In non-interactive (CI) runs we go further still and delete the key as part of
  // standard flow to add a redundant layer that it doesn't end up in the artifact.
  const keyIsEphemeral = !options.interactive;
  const keyDir = keyIsEphemeral
    ? mkdtempSync(join(tmpdir(), "fit-cli-key-"))
    : instanceInternalRunDir(instancePathObj);
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const keyPath = join(keyDir, `${keyName}.pem`);
  await createKeyPair(keyName, keyPath);
  const cleanupKeyFile = (): void => {
    if (keyIsEphemeral) rmSync(keyDir, { recursive: true, force: true });
  };

  // Install EC2 Instance Connect so any team member with the
  // ec2-instance-connect:SendSSHPublicKey IAM permission can SSH mid-run:
  //   aws ec2-instance-connect ssh --instance-id <id> --os-user ubuntu --region <region>
  const userData = "#!/bin/bash\napt-get update -y\napt-get install -y ec2-instance-connect";

  let instanceId: string | undefined;
  try {
    instanceId = await createInstance(
      {
        amiId,
        instanceType,
        keyName,
        securityGroupId,
        additionalSecurityGroupIds,
        subnetId: AWS_SUBNET_ID,
        userData,
        tags: {
          Name: fitInstanceName(creatorTag),
          [FIT_OWNER_TAG.key]: FIT_OWNER_TAG.value,
          "created-by": creatorTag,
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

    const host: RemoteHost = { host: address, user: FIT_INSTANCE_USER, identityFile: keyPath, agentForwarding: false };
    process.stdout.write("  waiting for SSH...");
    if (!(await waitForSsh(host))) {
      throw new Error(`Timed out waiting for SSH on ${address}.`);
    }
    console.log(" ready");

    const target = new RemoteTarget(host);
    // A fresh box's clock can be off until chrony's first sync settles, which is enough to trip
    // tests with a tight elapsed-time margin (see forceNtpSync's doc comment). Best-effort: never
    // blocks provisioning on failure.
    await forceNtpSync(target);

    const id = instanceId;
    const terminate = async (): Promise<void> => {
      await terminateInstance(id);
      await deleteKeyPair(keyName).catch(() => {});
      cleanupKeyFile();
    };

    const vpcId = info?.vpcId;
    const infoPath = join(instanceDir, "ec2-instance.json");
    writeFileSync(
      infoPath,
      `${JSON.stringify({ instanceId: id, address, region: AWS_REGION, instanceType, keyPath, ...(vpcId ? { vpcId } : {}) }, null, 2)}\n`,
    );
    const artifacts = [
      artifactFromPath(infoPath, "EC2 test instance details (id, address, region)"),
    ];
    const ec2icCommand = `aws ec2-instance-connect ssh --instance-id ${id} --os-user ${FIT_INSTANCE_USER} --region ${AWS_REGION}`;
    const details = [
      {
        label: "SSH debug command",
        value: `ssh -i ${keyPath} ${FIT_INSTANCE_USER}@${address}`,
      },
      {
        label: "EC2 Instance Connect (no key needed — requires ec2-instance-connect:SendSSHPublicKey IAM permission)",
        value: ec2icCommand,
      },
      {
        label: "Terminate instance command",
        value: terminateInstanceCommand(id),
      },
    ];

    console.log(`\n✓ EC2 instance ${id} is ready at ${address}${vpcId ? `  (VPC: ${vpcId})` : ""}`);
    fitCliWarn(`\n${formatEc2DeletionResponsibilityBanner(id, address, existingInstances, { account: creds.identity.account, creator: creatorTag }, options.interactive)}\n`);
    console.log(formatBanner("SSH ACCESS", [
      "Direct (requires key):",
      `  ssh -i ${keyPath} ${FIT_INSTANCE_USER}@${address}`,
      "Via EC2 Instance Connect (no key needed — requires ec2-instance-connect:SendSSHPublicKey):",
      `  ${ec2icCommand}`,
    ]));
    return { instanceId: id, address, keyPath, host, target, artifacts, details, terminate };
  } catch (err) {
    // Don't leave a paid box (or its key) lying around if bring-up failed. If we
    // never captured the instance id (e.g. launch threw mid-call), sweep by the
    // run's unique key name so an instance AWS created anyway can't leak.
    const leaked = instanceId
      ? [instanceId]
      : await findInstancesByKeyName(keyName)
          .then((found) => found.map((i) => i.instanceId))
          .catch(() => []);
    for (const id of leaked) {
      await terminateInstance(id).catch(() => {});
    }
    await deleteKeyPair(keyName).catch(() => {});
    cleanupKeyFile();
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
