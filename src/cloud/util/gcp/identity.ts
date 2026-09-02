/**
 * Preflight checks for GCP.
 *
 * Run on its own:
 *   bun src/cloud/util/gcp/identity.ts check --project <id>
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { preflightGcloudCli } from "../../../util/non-fit/gcp-iap.js";
import { capture } from "../../../util/non-fit/proc.js";
import { projectsClient } from "./gcp-clients.js";

/** The bits of a GCP project confirmation we care about. */
export interface GcpProjectCheck {
  project: string;
  name?: string;
}

/** fit-cli + GCP explained, same spirit as AWS identity.ts's fit-cli-role summary. */
function printGcpContextSummary(): void {
  console.log("fit-cli and GCP explained:");
  console.log("  fit-cli reads whatever Application Default Credentials (ADC) are already active — there's no separate assume-role step like AWS's fit-cli-role.");
  console.log("  On a laptop, this is normally from `gcloud auth application-default login`.");
  console.log("  On a GCP VM, this is the attached service account via the metadata server (needs --scopes=cloud-platform), no login needed.");
}

/** Print a ✓/✗ checklist of which GCP ADC sources are present, mirroring AWS's printCredentialsDiagnostic. */
function printGcpCredentialsDiagnostic(env: NodeJS.ProcessEnv = process.env): void {
  const hasEnvVar = Boolean(env.GOOGLE_APPLICATION_CREDENTIALS?.trim());
  const home = env.HOME ?? homedir();
  const wellKnownFile = join(home, ".config", "gcloud", "application_default_credentials.json");
  const hasWellKnownFile = existsSync(wellKnownFile);

  console.log("GCP ADC sources (✓ indicates it exists):");
  console.log(`  ${hasEnvVar ? "✓" : "✗"} GOOGLE_APPLICATION_CREDENTIALS (env var pointing to a service-account key file)`);
  console.log(`  ${hasWellKnownFile ? "✓" : "✗"} ${wellKnownFile} (gcloud user ADC)`);
}

/**
 * Describe which identity ADC currently resolves to, for display only — never
 * throws; `preflightGcpProject`'s own `projectsClient.get` call is what
 * actually validates credentials work, this just labels what it finds.
 */
async function describeGcpIdentity(): Promise<string> {
  try {
    const [client, credentials] = await Promise.all([projectsClient.auth.getClient(), projectsClient.auth.getCredentials()]);
    if (credentials.client_email) {
      const source = client.constructor.name === "Compute" ? "GCE metadata server" : "service-account key file";
      return `${credentials.client_email} (${source})`;
    }
    return "user ADC (gcloud auth application-default login)";
  } catch (err) {
    return `could not be determined (${err instanceof Error ? err.message : String(err)})`;
  }
}

/**
 * The permissions `roles/iap.tunnelResourceAccessor` and `roles/compute.osLogin`
 * grant — checked directly via `testIamPermissions` rather than by reading IAM
 * policy bindings, since the latter needs `resourcemanager.projects.getIamPolicy`
 * (which the caller may not have either) while `testIamPermissions` only ever
 * reports on the caller's own effective access.
 */
const IAP_TUNNEL_PERMISSIONS = ["iap.tunnelInstances.accessViaIAP", "compute.instances.osLogin"] as const;

interface TestIamPermissionsResponse {
  permissions?: string[];
}

/**
 * Confirm the caller can actually open an IAP tunnel to a GCP instance, before
 * spending ~30s launching a billable one to find out. Missing either
 * permission means `waitForIapSsh` would just retry silently for its full
 * timeout (see util/non-fit/gcp-iap.ts) with no indication why — this fails
 * fast with the specific missing permission(s) instead.
 */
async function checkIapTunnelAccess(project: string): Promise<void> {
  const client = await projectsClient.auth.getClient();
  const res = await client.request<TestIamPermissionsResponse>({
    url: `https://cloudresourcemanager.googleapis.com/v1/projects/${project}:testIamPermissions`,
    method: "POST",
    data: { permissions: IAP_TUNNEL_PERMISSIONS },
  });
  const granted = new Set(res.data.permissions ?? []);
  const missing = IAP_TUNNEL_PERMISSIONS.filter((permission) => !granted.has(permission));
  if (missing.length > 0) {
    throw new Error(
      `Missing IAM permission(s) needed to reach fit-cli's GCP instances over IAP: ${missing.join(", ")}.\n` +
        `This means "roles/iap.tunnelResourceAccessor" and/or "roles/compute.osLogin" aren't granted to you on "${project}".\n` +
        `Ask someone with resourcemanager.projects.setIamPolicy on "${project}" to add your identity to terraform/gcp's ` +
        `"gcp_iap_members" and apply`,
    );
  }
  console.log(`✓ Confirmed IAP tunnel access (${IAP_TUNNEL_PERMISSIONS.join(", ")})`);
}

/**
 * Confirm the `gcloud` CLI itself has a valid, non-stale login session —
 * separate from Application Default Credentials, which only covers the
 * `@google-cloud/*` SDK's own direct API calls (project reachability, IAM
 * permission checks, instance create/delete/etc.). IAP-tunneled SSH
 * (util/non-fit/gcp-iap.ts) is the one transport with no SDK equivalent, so
 * it shells out to the `gcloud` binary directly, which keeps its own
 * `gcloud auth login` session — that session can go stale (e.g. overnight)
 * independently of ADC. Without this check, a stale `gcloud` session let
 * every ADC-based check above pass, then only surfaced as
 * "Reauthentication failed" deep inside `waitForIapSsh`'s full multi-minute
 * timeout, after an instance had already been launched. Checked upfront
 * instead, alongside everything else.
 */
async function checkGcloudCliAuth(): Promise<void> {
  await preflightGcloudCli();
  try {
    await capture("gcloud", ["auth", "print-access-token"], undefined, { quiet: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `The "gcloud" CLI's own login session looks stale — this is separate from Application Default ` +
        `Credentials (which just passed) and is what IAP-tunneled SSH shells out to directly. Run ` +
        `"gcloud auth login" to refresh it.\n(${detail})`,
      { cause: err },
    );
  }
  console.log(`✓ Confirmed "gcloud" CLI has a valid login session (needed for IAP-tunneled SSH)`);
}

/**
 * Confirm ADC resolves to *some* usable identity and that identity can read
 * the given project — the GCP equivalent of AWS's `GetCallerIdentity` +
 * fit-cli-role assume, minus the assume step (there's nothing to assume into).
 * Always prints (success or failure): the fit-cli/GCP context, which ADC
 * sources are present, and the resolved identity — mirroring AWS's
 * `checkAwsCredentials`, which never runs silently either way. Throws with
 * guidance on failure rather than returning a null/error union, since every
 * caller needs this to have succeeded before doing anything else.
 */
export async function preflightGcpProject(project: string): Promise<GcpProjectCheck> {
  printGcpContextSummary();
  printGcpCredentialsDiagnostic();
  console.log(`GCP identity: ${await describeGcpIdentity()}`);
  let info;
  try {
    [info] = await projectsClient.get({ project });
    console.log(`✓ Confirmed project "${project}" is reachable (name: ${info.name ?? "unknown"})`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not reach GCP project "${project}" using Application Default Credentials: ${detail}\n` +
        `If you're on a laptop: run "gcloud auth application-default login".\n` +
        `If you're on a GCP VM: confirm it was launched with --scopes=cloud-platform and a service account attached.\n` +
        `Either way, confirm "${project}" is the right project and you have compute.viewer (or better) on it.`,
      { cause: err },
    );
  }
  await checkIapTunnelAccess(project);
  await checkGcloudCliAuth();
  return { project, name: info.name ?? undefined };
}

/** The result of {@link checkGcpCredentials}: a usable project, or why we don't have one. */
export type GcpCredentialsResult = ({ ok: true } & GcpProjectCheck) | { ok: false; message: string };

let cachedResult: GcpCredentialsResult | undefined;

/**
 * Non-throwing wrapper around {@link preflightGcpProject}, in the same
 * `{ok:true,...} | {ok:false,message}` shape AWS's `checkAwsCredentials` uses,
 * so callers (e.g. select-execution-target.ts) can loop back to a prompt on
 * failure instead of catching an exception. Cached for the lifetime of the
 * process (per project) so calling it again later in the same run doesn't
 * reprint the whole diagnostic a second time.
 */
export async function checkGcpCredentials(project: string): Promise<GcpCredentialsResult> {
  if (cachedResult?.ok && cachedResult.project === project) return cachedResult;
  try {
    const result = await preflightGcpProject(project);
    const ok: GcpCredentialsResult = { ok: true, ...result };
    cachedResult = ok;
    return ok;
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    const projectIndex = argv.indexOf("--project");
    const project = projectIndex !== -1 ? argv[projectIndex + 1] : undefined;
    if (argv[0] !== "check" || !project) {
      throw new Error("Usage: identity.ts check --project <id>");
    }
    await preflightGcpProject(project);
  });
}
