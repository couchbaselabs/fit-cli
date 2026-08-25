/**
 * create-instance — launch a single GCP compute instance and (optionally) wait
 * for it to reach RUNNING. Pure plumbing over the @google-cloud/compute SDK;
 * the JSON shaping lives in parse-instance.ts. Mirrors
 * src/cloud/util/aws/create-instance.ts's shape.
 *
 * `insert` only returns once GCP has *accepted* the request; the launch itself
 * is a long-running zone operation, tracked here with ZoneOperationsClient.wait
 * (a server-side long-poll, capped per call, so it's looped until DONE).
 *
 * Defaults to the `fit-cli=owned` label (override with --label k=v) so
 * list-instances.ts can find it again by ownership.
 *
 * Run on its own (the image/network/subnet/service-account must already
 * exist — see gcp2.md's Prerequisites):
    bun src/cloud/util/gcp/create-instance.ts \
      --project couchbase-qe --zone us-west1-a --name fit-cli-test \
      --machine-type n2-standard-8 --image-family ubuntu-2204-lts --image-project ubuntu-os-cloud \
      --network default --subnet default --service-account 84079313096-compute@developer.gserviceaccount.com --wait
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { instancesClient, zoneOperationsClient } from "./gcp-clients.js";
import { preflightGcpProject } from "./identity.js";
import { parseInstance } from "./parse-instance.js";
import { waitForZoneOperation } from "./wait-for-operation.js";

/** Everything needed to launch one instance. */
export interface CreateGcpInstanceSpec {
  project: string;
  zone: string;
  name: string;
  machineType: string;
  /** Boot disk image, e.g. "projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts". */
  sourceImage: string;
  bootDiskSizeGb: number;
  /** VPC network name (not URL) the box sits in — required for PSC to bind to it. */
  network: string;
  /** Subnet name within `network`. */
  subnet: string;
  /**
   * Service account attached to the box, with the `cloud-platform` scope so
   * ADC on the box resolves to it.
   */
  serviceAccountEmail: string;
  /**
   * Whether the box gets an ephemeral external IP. Defaults to false (we want to use IAP).
   */
  assignExternalIp?: boolean;
  /** Labels applied to the instance, e.g. { "fit-cli": "owned" }. GCP's counterpart of EC2 tags. */
  labels?: Record<string, string>;
  /**
   * Network tags (GCP's mechanism for scoping firewall rules to specific instances —
   * distinct from `labels`, which is just metadata). E.g. ["fit-cli-private-endpoint"]
   * to match the firewall rule that admits traffic from a Capella PSC endpoint.
   */
  networkTags?: string[];
}

/** Launch a single instance and return its name (it will still be starting up). */
export async function createGcpInstance(spec: CreateGcpInstanceSpec): Promise<string> {
  const [operation] = await instancesClient.insert({
    project: spec.project,
    zone: spec.zone,
    instanceResource: {
      name: spec.name,
      machineType: `zones/${spec.zone}/machineTypes/${spec.machineType}`,
      disks: [{
        boot: true,
        autoDelete: true,
        initializeParams: { sourceImage: spec.sourceImage, diskSizeGb: String(spec.bootDiskSizeGb) },
      }],
      networkInterfaces: [{
        network: `global/networks/${spec.network}`,
        subnetwork: `regions/${spec.zone.replace(/-[a-z]$/, "")}/subnetworks/${spec.subnet}`,
        ...(spec.assignExternalIp === true ? { accessConfigs: [{ name: "External NAT", type: "ONE_TO_ONE_NAT" }] } : {}),
      }],
      serviceAccounts: [{ email: spec.serviceAccountEmail, scopes: ["https://www.googleapis.com/auth/cloud-platform"] }],
      ...(spec.labels && Object.keys(spec.labels).length > 0 ? { labels: spec.labels } : {}),
      ...(spec.networkTags && spec.networkTags.length > 0 ? { tags: { items: spec.networkTags } } : {}),
    },
  });
  await waitForZoneOperation(zoneOperationsClient, spec.project, spec.zone, operation.name ?? undefined);
  return spec.name;
}

const GET_CALL_TIMEOUT_MS = 120_000;

/** Block until the instance reaches RUNNING, polling describeInstance (GCP has no dedicated waiter like EC2's waitUntilInstanceRunning). */
export async function waitForGcpInstanceRunning(
  project: string,
  zone: string,
  name: string,
  { timeoutMs = 600_000, intervalMs = 5_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: string | undefined;
  for (;;) {
    // Each get() is raced against its own timeout so a stalled call (network
    // blip, stuck token refresh) can't hang the loop forever without the
    // deadline below ever getting checked. A genuine error from get() itself
    // still propagates immediately, rather than being swallowed as a timeout.
    let timedOut = false;
    const raw = await Promise.race([
      instancesClient.get({ project, zone, instance: name }).then(([r]) => r),
      new Promise<undefined>((resolve) => setTimeout(() => { timedOut = true; resolve(undefined); }, GET_CALL_TIMEOUT_MS)),
    ]);
    if (!timedOut && raw) {
      lastStatus = raw.status ?? undefined;
      if (parseInstance(raw)?.status === "RUNNING") return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${name} to reach RUNNING (last status: ${lastStatus ?? "unknown"}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    const flag = (name: string): string | undefined => {
      const index = argv.indexOf(`--${name}`);
      return index !== -1 ? argv[index + 1] : undefined;
    };
    const project = flag("project");
    const zone = flag("zone");
    const name = flag("name");
    const machineType = flag("machine-type");
    const imageFamily = flag("image-family");
    const imageProject = flag("image-project");
    const network = flag("network");
    const subnet = flag("subnet");
    const serviceAccount = flag("service-account");
    if (!project || !zone || !name || !machineType || !imageFamily || !imageProject || !network || !subnet || !serviceAccount) {
      throw new Error(
        "Usage: create-instance.ts --project <id> --zone <zone> --name <name> --machine-type <type> " +
          "--image-family <family> --image-project <project> --network <name> --subnet <name> --service-account <email> " +
          "[--label k=v] [--wait]",
      );
    }
    const labelFlag = flag("label");
    const labels = labelFlag
      ? { [labelFlag.split("=")[0]]: labelFlag.split("=")[1] ?? "" }
      : { "fit-cli": "owned" };
    const wait = argv.includes("--wait");
    await preflightGcpProject(project);
    console.log(`Creating GCP instance ${name} in ${project}/${zone}...`);
    await createGcpInstance({
      project,
      zone,
      name,
      machineType,
      sourceImage: `projects/${imageProject}/global/images/family/${imageFamily}`,
      bootDiskSizeGb: 250,
      network,
      subnet,
      serviceAccountEmail: serviceAccount,
      labels,
    });
    console.log(`✓ Launched ${name}`);
    if (wait) {
      console.log("Waiting for it to reach RUNNING...");
      await waitForGcpInstanceRunning(project, zone, name);
      console.log(`✓ ${name} is RUNNING`);
    }
  });
}
