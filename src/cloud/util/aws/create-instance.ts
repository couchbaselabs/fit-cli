/**
 * create-instance — launch a single EC2 instance and (optionally) wait for it to
 * reach the running state. Pure plumbing over the EC2 SDK; the JSON shaping lives
 * in parse-instance.ts. Nothing here is FIT-specific — the caller passes the AMI,
 * instance type, key, security group and any user-data/tags.
 *
 * Run on its own (the AMI/key/SG must already exist — see image.ts, key-pair.ts,
 * security-group.ts):
 *   bun src/cloud/util/aws/create-instance.ts \
 *     --ami ami-0123 --type t3.micro --key my-key --sg sg-0123 [--subnet subnet-0123] [--tag fit-cli=owned] [--wait]
 */
import { type _InstanceType, RunInstancesCommand, type VolumeType, waitUntilInstanceRunning } from "@aws-sdk/client-ec2";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { logAwsAction, prepareAwsCli } from "./aws-cli.js";
import { ec2Client } from "./aws-clients.js";
import { parseInstances } from "./parse-instance.js";

/** A single EBS block-device mapping. */
export interface BlockDeviceMapping {
  deviceName: string;
  volumeSizeGB: number;
  volumeType?: string;
  deleteOnTermination?: boolean;
}

/** Everything needed to launch one instance. */
export interface CreateInstanceSpec {
  amiId: string;
  instanceType: string;
  /** EC2 key pair name (SSH). Omit for instances reached over SSM instead. */
  keyName?: string;
  securityGroupId: string;
  /** Additional security groups to attach alongside `securityGroupId`. */
  additionalSecurityGroupIds?: string[];
  /** Subnet to launch into. Required when the account/region has no default VPC. */
  subnetId?: string;
  /** Cloud-init / shell user-data run at first boot (plain text). */
  userData?: string;
  /** IAM instance profile (name) to attach — needed for the SSM Agent to register. */
  iamInstanceProfileName?: string;
  /** Tags applied to the instance, e.g. { "fit-cli": "owned" }. */
  tags?: Record<string, string>;
  /** EBS block-device mappings (e.g. root volume size & type). */
  blockDeviceMappings?: BlockDeviceMapping[];
}

/** Launch a single instance and return its id (it will still be "pending"). */
export async function createInstance(spec: CreateInstanceSpec): Promise<string> {
  const allSgIds = [spec.securityGroupId, ...(spec.additionalSecurityGroupIds ?? [])];
  const response = await ec2Client.send(new RunInstancesCommand({
    ImageId: spec.amiId,
    InstanceType: spec.instanceType as _InstanceType,
    SecurityGroupIds: allSgIds,
    MinCount: 1,
    MaxCount: 1,
    ...(spec.keyName ? { KeyName: spec.keyName } : {}),
    ...(spec.subnetId ? { SubnetId: spec.subnetId } : {}),
    // The SDK expects user data as base64 (the CLI encoded it for us automatically).
    ...(spec.userData ? { UserData: Buffer.from(spec.userData).toString("base64") } : {}),
    ...(spec.iamInstanceProfileName ? { IamInstanceProfile: { Name: spec.iamInstanceProfileName } } : {}),
    ...(spec.tags && Object.keys(spec.tags).length > 0
      ? {
          TagSpecifications: [{
            ResourceType: "instance",
            Tags: Object.entries(spec.tags).map(([Key, Value]) => ({ Key, Value })),
          }],
        }
      : {}),
    ...(spec.blockDeviceMappings && spec.blockDeviceMappings.length > 0
      ? {
          BlockDeviceMappings: spec.blockDeviceMappings.map((m) => ({
            DeviceName: m.deviceName,
            Ebs: {
              VolumeSize: m.volumeSizeGB,
              ...(m.volumeType ? { VolumeType: m.volumeType as VolumeType } : {}),
              ...(m.deleteOnTermination !== undefined ? { DeleteOnTermination: m.deleteOnTermination } : {}),
            },
          })),
        }
      : {}),
  }));
  const launched = parseInstances(response);
  if (launched.length === 0) {
    // AWS may have created an instance even though we couldn't read its id back
    // (e.g. an unexpected response shape). Surface the raw response so callers
    // can find and reap any box rather than silently leaking a paid instance.
    throw new Error(`RunInstances returned no parseable instance:\n${JSON.stringify(response)}`);
  }
  return launched[0].instanceId;
}

/** Block until the instance reaches the "running" state (EC2's own waiter). */
export async function waitForInstanceRunning(instanceId: string): Promise<void> {
  await waitUntilInstanceRunning(
    { client: ec2Client, maxWaitTime: 600 },
    { InstanceIds: [instanceId] },
  );
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    await prepareAwsCli();
    const argv = process.argv.slice(2);
    const flag = (name: string): string | undefined => {
      const index = argv.indexOf(`--${name}`);
      return index !== -1 ? argv[index + 1] : undefined;
    };
    const amiId = flag("ami");
    const instanceType = flag("type");
    const keyName = flag("key");
    const securityGroupId = flag("sg");
    if (!amiId || !instanceType || !keyName || !securityGroupId) {
      throw new Error(
        "Usage: create-instance.ts --ami <id> --type <type> --key <name> --sg <id> [--subnet <id>] [--tag k=v] [--user-data <text>] [--wait]",
      );
    }
    const subnetId = flag("subnet");
    const tagFlag = flag("tag");
    const tags = tagFlag ? { [tagFlag.split("=")[0]]: tagFlag.split("=")[1] ?? "" } : undefined;
    const userData = flag("user-data");
    const wait = argv.includes("--wait");
    logAwsAction("Creating EC2 instance", {
      amiId,
      instanceType,
      keyName,
      securityGroupId,
      subnetId,
      tag: tagFlag,
      wait,
      userData: userData ? "provided" : undefined,
    });
    const id = await createInstance({ amiId, instanceType, keyName, securityGroupId, subnetId, userData, tags });
    console.log(`✓ Launched ${id}`);
    if (wait) {
      console.log("Waiting for it to reach running...");
      await waitForInstanceRunning(id);
      console.log(`✓ ${id} is running`);
    }
  });
}
