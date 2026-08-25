/**
 * terminate-instance — delete a GCP compute instance by name. Pure plumbing
 * over the compute SDK. Deleting an already-deleted (or never-existing)
 * instance surfaces as a 404 from GCP; treated as success, same as EC2
 * terminate being a no-op on an already-terminated instance, so this stays
 * safe to call from cleanup paths.
 *
 * Run on its own:
 *   bun src/cloud/util/gcp/terminate-instance.ts --project <id> --zone us-west1-a --name fit-cli-abc123
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { instancesClient, zoneOperationsClient } from "./gcp-clients.js";
import { preflightGcpProject } from "./identity.js";
import { waitForZoneOperation } from "./wait-for-operation.js";
import { TIMED_OUT, withCallTimeout } from "./with-call-timeout.js";

const DELETE_CALL_TIMEOUT_MS = 120_000;

/**
 * GCP's "not found" error carries a code, not a distinct exception type — but
 * which code depends on transport: 404 for the REST status this client's HTTP
 * calls actually get back, 5 for the gRPC NOT_FOUND code some google-gax
 * layers normalize errors to. Match both rather than assume one.
 */
function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const code = (err as { code?: number }).code;
  return code === 404 || code === 5;
}

/** Delete an instance by name, waiting for the deletion to complete. */
export async function terminateGcpInstance(project: string, zone: string, name: string): Promise<void> {
  try {
    const result = await withCallTimeout(instancesClient.delete({ project, zone, instance: name }), DELETE_CALL_TIMEOUT_MS);
    if (result === TIMED_OUT) {
      throw new Error(`Timed out issuing the delete request for GCP instance ${name}.`);
    }
    const [operation] = result;
    await waitForZoneOperation(zoneOperationsClient, project, zone, operation.name ?? undefined);
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    const flag = (n: string): string | undefined => {
      const i = argv.indexOf(`--${n}`);
      return i !== -1 ? argv[i + 1] : undefined;
    };
    const project = flag("project");
    const zone = flag("zone");
    const name = flag("name");
    if (!project || !zone || !name) {
      throw new Error("Usage: terminate-instance.ts --project <id> --zone <zone> --name <name>");
    }
    await preflightGcpProject(project);
    console.log(`Terminating GCP instance ${name}...`);
    await terminateGcpInstance(project, zone, name);
    console.log(`✓ Terminated ${name}`);
  });
}
