/**
 * describe-instance — look up a single GCP compute instance by name, returning
 * the fields we use (status, addresses) or null if it isn't found. Pure
 * plumbing over the compute SDK; the shaping lives in parse-instance.ts.
 * Mirrors src/cloud/util/aws/describe-instance.ts.
 *
 * Run on its own:
 *   bun src/cloud/util/gcp/describe-instance.ts --project <id> --zone us-west1-a --name fit-cli-abc123
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { instancesClient } from "./gcp-clients.js";
import { preflightGcpProject } from "./identity.js";
import { parseInstance, type GcpInstanceInfo } from "./parse-instance.js";
import { TIMED_OUT, withCallTimeout } from "./with-call-timeout.js";

/**
 * Per-call bound, matching create-instance.ts's GET_CALL_TIMEOUT_MS. The compute
 * client has no deadline of its own, and unlike the polling loops there this is
 * a single un-retried call with nothing above it to notice it never returned —
 * so a stalled get() here hangs the whole run outright.
 */
const GET_CALL_TIMEOUT_MS = 120_000;

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

/** Describe a single instance, or null if it isn't found. */
export async function describeGcpInstance(project: string, zone: string, name: string): Promise<GcpInstanceInfo | null> {
  try {
    const result = await withCallTimeout(instancesClient.get({ project, zone, instance: name }), GET_CALL_TIMEOUT_MS);
    // Deliberately throws rather than returning null: null means "no such
    // instance", and a caller acting on that after a mere timeout would decide
    // a perfectly healthy box had vanished.
    if (result === TIMED_OUT) {
      throw new Error(`Timed out describing GCP instance ${name} in ${project}/${zone}.`);
    }
    const [raw] = result;
    return parseInstance(raw);
  } catch (err) {
    if (isNotFound(err)) return null;
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
      throw new Error("Usage: describe-instance.ts --project <id> --zone <zone> --name <name>");
    }
    await preflightGcpProject(project);
    console.log(JSON.stringify(await describeGcpInstance(project, zone, name), null, 2));
  });
}
