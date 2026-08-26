/**
 * aws-clients — shared AWS SDK v3 client instances. Credentials come from
 * {@link fitCliCredentialsProvider}, which re-assumes fit-cli-role when the session
 * expires; the SDK re-invokes it once the returned `expiration` passes, so these
 * long-lived singletons keep working across a run that outlives the assumed session
 * (e.g. teardown after a >1h situational suite) instead of failing with `RequestExpired`.
 */
import { EC2Client } from "@aws-sdk/client-ec2";
import { SSMClient } from "@aws-sdk/client-ssm";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { S3Client } from "@aws-sdk/client-s3";
import { AWS_REGION } from "./aws-target.js";
import { fitCliCredentialsProvider } from "./aws-cli.js";

// Reference the provider lazily (at credential-resolution time, not module-eval time): aws-cli.ts
// participates in an import cycle with config/secrets, so reading the binding at eval could hit it
// before initialization. The arrow defers that read until the SDK actually needs credentials.
const credentials = () => fitCliCredentialsProvider();

/**
 * All of ec2Client/ssmClient/cloudWatchLogsClient's calls are quick control-plane
 * requests (describe/list/get/send-command-enqueue) — none transfer bulk data, so a
 * generous fixed timeout is safe everywhere they're used. Without this, the SDK's
 * NodeHttpHandler defaults to no timeout at all: a stalled TCP connection (a network
 * blip, a dead NAT mapping) hangs the request forever rather than erroring, which is
 * exactly what stalled SsmTarget's streaming poll loop (runShellCommandStreamed in
 * ssm-target.ts) mid-run — the loop's own retry/backoff logic never got a chance to
 * run because the `await` it was blocked on never settled.
 *
 * throwOnRequestTimeout is required: without it, NodeHttpHandler only *logs* a warning
 * on timeout and leaves the request hanging (see @smithy/node-http-handler's
 * set-request-timeout.js) — a `requestTimeout` alone is silently a no-op.
 */
const CONTROL_PLANE_REQUEST_TIMEOUT_MS = 30_000;
const controlPlaneRequestHandler = { requestTimeout: CONTROL_PLANE_REQUEST_TIMEOUT_MS, throwOnRequestTimeout: true };

export const ec2Client = new EC2Client({ region: AWS_REGION, credentials, requestHandler: controlPlaneRequestHandler });
export const ssmClient = new SSMClient({ region: AWS_REGION, credentials, requestHandler: controlPlaneRequestHandler });
// Backs SsmTarget's SendCommand output (CloudWatchOutputConfig) — GetCommandInvocation
// truncates inline stdout/stderr, so full output is read back from here.
export const cloudWatchLogsClient = new CloudWatchLogsClient({ region: AWS_REGION, credentials, requestHandler: controlPlaneRequestHandler });
// 5-minute request timeout to accommodate large artifact uploads (throwOnRequestTimeout
// matters here even more than above — silently hanging on a multi-GB upload is worse).
export const s3Client = new S3Client({
  region: AWS_REGION,
  credentials,
  requestHandler: { requestTimeout: 5 * 60 * 1000, throwOnRequestTimeout: true },
});
