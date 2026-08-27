/**
 * fit-instance — provision a clean GCP compute instance for a FIT run, reached
 * over an IAP-tunneled SSH connection (IapTarget). GCP counterpart of
 * ../aws/fit-instance.ts; see that file's header for the general shape. The
 * main plumbing differences: GCP instances are identified by
 * (project, zone, name) rather than one opaque id, and we choose the name
 * ourselves before launching (AWS assigns the id), so cleanup on a failed
 * launch never needs launch-id tracking — the name is always known.
 *
 * Run on its own (provisions a box and prints how to reach it — does NOT
 * terminate it, so you can poke at it; tear it down with the printed command):
 *   bun src/fit/util/gcp/fit-instance.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactFromPath, type Artifact, type Detail } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import type { PrivateEndpointSetup } from "../../shared/definition/types.js";
import { checkGcpCredentials } from "../../../cloud/util/gcp/identity.js";
import { localGcpCreator } from "../../../cloud/util/gcp/gcp-cli.js";
import { createGcpInstance, waitForGcpInstanceRunning } from "../../../cloud/util/gcp/create-instance.js";
import { describeGcpInstance } from "../../../cloud/util/gcp/describe-instance.js";
import { terminateGcpInstance } from "../../../cloud/util/gcp/terminate-instance.js";
import { loadEnvironments, type GcpDefaults } from "../environments.js";
import { instanceRunDir } from "../../../util/non-fit/replay.js";
import { instanceLabel } from "../../shared/util/run-labels.js";
import { IapTarget } from "../../../util/non-fit/iap-target.js";
import { DEFAULT_IAP_USER, waitForIapSsh, type IapHost } from "../../../util/non-fit/gcp-iap.js";
import { forceNtpSync } from "../../../util/non-fit/ntp-sync.js";
import { fitCliWarn } from "../../../util/non-fit/fit-cli-log.js";
import { formatBanner } from "../aws/lifecycle-warning.js";
import { formatGcpDeletionResponsibilityBanner, gcpDebugAccessCommand, gcpTerminateInstanceCommand } from "./lifecycle-warning.js";

/** The box's normal login user, reached via OS Login through the IAP tunnel. */
export const FIT_INSTANCE_USER = DEFAULT_IAP_USER;

/** Boot image: latest Ubuntu 22.04 LTS, resolved by GCP at launch time. */
const UBUNTU_SOURCE_IMAGE = "projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts";

/** Root disk size, matching the AWS side's fitBlockDeviceMappings (see CBD-5001). */
const BOOT_DISK_SIZE_GB = 250;

/**
 * Network tag matched by the fit-cli-allow-private-endpoint firewall rule
 * (terraform/gcp/firewall.tf), which admits traffic from a Capella PSC
 * endpoint. GCP's counterpart of AWS's privateEndpointVpcSgId attach.
 */
const PRIVATE_ENDPOINT_NETWORK_TAG = "fit-cli-private-endpoint";

/** Default instance type for FIT GCP instances. Override with FIT_GCP_INSTANCE_TYPE. */
export function defaultGcpInstanceType(): string {
  return process.env.FIT_GCP_INSTANCE_TYPE ?? "n2-standard-8";
}

/**
 * GCP instance names must be RFC1035 labels: start with a lowercase letter,
 * then lowercase letters/digits/hyphens, <= 63 chars. `creator` is folded to
 * fit that (AWS's Name tag has no such restriction, so its fitInstanceName
 * doesn't need this).
 */
export function gcpFitInstanceName(creator: string, now: Date = new Date()): string {
  const iso = now.toISOString(); // 2026-06-12T10:37:00.000Z
  const stamp = `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 16).replace(":", "")}`;
  const safeCreator = creator.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "user";
  return `fit-cli-${safeCreator}-${stamp}`;
}

type RequiredGcpDefaults = { [K in "project" | "zone" | "network" | "subnet" | "serviceAccountEmail"]: string };

/**
 * Read defaults.gcp from environments.json5, failing fast (with guidance) if any
 * required field is unset. Exported so callers that need just the project id for
 * an upfront credentials check (run-from-definition.ts's willRunOnGcp check) don't
 * have to duplicate this parsing.
 */
export function requireGcpConfig(): RequiredGcpDefaults {
  const gcp: GcpDefaults = loadEnvironments().defaults.gcp ?? {};
  const keys = ["project", "zone", "network", "subnet", "serviceAccountEmail"] as const;
  const missing = keys.filter((key) => !gcp[key]);
  if (missing.length > 0) {
    throw new Error(
      `GCP is not fully configured in environments.json5 (defaults.gcp): missing ${missing.join(", ")}.`,
    );
  }
  return Object.fromEntries(keys.map((key) => [key, gcp[key] as string])) as RequiredGcpDefaults;
}

/** A provisioned GCP instance, ready to use, with a teardown handle. */
export interface ProvisionedGcpInstance {
  instanceName: string;
  project: string;
  zone: string;
  /** Address used to reach it for display (internal IP, falling back to the instance name). */
  address: string;
  /** An ExecutionTarget that runs commands on this instance over an IAP tunnel. */
  target: IapTarget;
  /** Files produced (an instance-info record) for the run summary. */
  artifacts: Artifact[];
  /** Useful commands and facts for debugging and cleanup. */
  details: Detail[];
  /** Delete the instance. Safe to call once. */
  terminate: () => Promise<void>;
}

/** Options for provisioning (all optional; sensible FIT defaults apply). */
export interface GcpProvisionOptions {
  instanceType?: string;
  /** Instance this execution target belongs to; its key and info land under that instance dir. */
  instanceIndex?: number;
  /** Whether the run is interactive; affects the lifecycle warning message shown to the user. */
  interactive?: boolean;
  /**
   * When present, tag the instance so it can reach a Capella PSC endpoint (see
   * PRIVATE_ENDPOINT_NETWORK_TAG). GCP counterpart of the AWS side's
   * ProvisionOptions.privateEndpoint.
   */
  privateEndpoint?: PrivateEndpointSetup;
}

/**
 * Provision a fresh GCP compute instance suitable for a FIT run: latest
 * Ubuntu LTS, the fit-cli VPC/subnet, and the fit-cli-gcp service account.
 * Waits until the box is running and reachable over an IAP tunnel before
 * returning. If anything fails after the instance launches, it's deleted so
 * we don't leak a paid box — safe because, unlike AWS, we chose the name
 * ourselves before launching, so it's always known even if the launch call
 * itself threw.
 */
export async function provisionFitGcpInstance(options: GcpProvisionOptions = {}): Promise<ProvisionedGcpInstance> {
  const config = requireGcpConfig();
  const creds = await checkGcpCredentials(config.project);
  if (!creds.ok) {
    throw new Error(`GCP credentials are not usable: ${creds.message}`);
  }

  const creatorTag = localGcpCreator();

  const instanceType = options.instanceType ?? defaultGcpInstanceType();
  const pe = options.privateEndpoint;
  const peDesc = pe ? " [private-endpoint mode]" : "";
  console.log(`Provisioning a ${instanceType} GCP instance in ${config.project}/${config.zone}${peDesc}...`);
  if (pe) {
    console.log(`  private endpoint: network tag ${PRIVATE_ENDPOINT_NETWORK_TAG}`);
  }

  const instanceIdx = options.instanceIndex ?? 0;
  const instancePathObj = { instanceIndex: instanceIdx, dirSegments: { instance: instanceLabel({ instanceIndex: instanceIdx }, "gcp") } };
  const instanceDir = instanceRunDir(instancePathObj);
  mkdirSync(instanceDir, { recursive: true, mode: 0o700 });

  const name = gcpFitInstanceName(creatorTag);
  try {
    await createGcpInstance({
      project: config.project,
      zone: config.zone,
      name,
      machineType: instanceType,
      sourceImage: UBUNTU_SOURCE_IMAGE,
      bootDiskSizeGb: BOOT_DISK_SIZE_GB,
      network: config.network,
      subnet: config.subnet,
      serviceAccountEmail: config.serviceAccountEmail,
      labels: { "fit-cli": "owned", "created-by": creatorTag },
      ...(pe ? { networkTags: [PRIVATE_ENDPOINT_NETWORK_TAG] } : {}),
    });
    console.log(`  launched ${name}, waiting for it to start...`);
    await waitForGcpInstanceRunning(config.project, config.zone, name);

    const info = await describeGcpInstance(config.project, config.zone, name);
    const address = info?.internalIp ?? name;

    const host: IapHost = { instance: name, zone: config.zone, project: config.project, user: FIT_INSTANCE_USER };
    process.stdout.write("  waiting for IAP-tunneled SSH to become reachable...");
    if (!(await waitForIapSsh(host))) {
      throw new Error(`Timed out waiting for IAP-tunneled SSH on ${name}.`);
    }
    console.log(" ready");

    const target = new IapTarget(host);
    // See aws/fit-instance.ts's forceNtpSync call for why: a fresh box's clock can
    // be off until chrony's first sync settles. Best-effort: never blocks provisioning.
    await forceNtpSync(target);

    const terminate = async (): Promise<void> => {
      await terminateGcpInstance(config.project, config.zone, name);
    };

    const infoPath = join(instanceDir, "gcp-instance.json");
    writeFileSync(
      infoPath,
      `${JSON.stringify({ instanceName: name, project: config.project, zone: config.zone, address, instanceType }, null, 2)}\n`,
    );
    const artifacts = [artifactFromPath(infoPath, "GCP test instance details (name, project, zone, address)")];
    const debugCommand = gcpDebugAccessCommand(name, config.zone, config.project);
    const details = [
      { label: "Debug access (IAP)", value: debugCommand },
      { label: "Terminate instance command", value: gcpTerminateInstanceCommand(name, config.zone, config.project) },
    ];

    console.log(`\n✓ GCP instance ${name} is ready (${address})`);
    fitCliWarn(`\n${formatGcpDeletionResponsibilityBanner(name, config.zone, config.project, address, options.interactive)}\n`);
    console.log(formatBanner("DEBUG ACCESS (IAP)", [`  ${debugCommand}`]));
    return { instanceName: name, project: config.project, zone: config.zone, address, target, artifacts, details, terminate };
  } catch (err) {
    // The name was chosen before launching, so it's always known — delete
    // unconditionally rather than needing launch-id tracking like the AWS side.
    await terminateGcpInstance(config.project, config.zone, name).catch(() => {});
    throw err;
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const provisioned = await provisionFitGcpInstance();
    console.log(`\nLeaving it running. Delete when done with:`);
    console.log(`  ${gcpTerminateInstanceCommand(provisioned.instanceName, provisioned.zone, provisioned.project)}`);
    return { artifacts: provisioned.artifacts, details: provisioned.details };
  });
}
