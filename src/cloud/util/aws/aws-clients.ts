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

export const ec2Client = new EC2Client({ region: AWS_REGION, credentials });
export const ssmClient = new SSMClient({ region: AWS_REGION, credentials });
// Backs SsmTarget's SendCommand output (CloudWatchOutputConfig) — GetCommandInvocation
// truncates inline stdout/stderr, so full output is read back from here.
export const cloudWatchLogsClient = new CloudWatchLogsClient({ region: AWS_REGION, credentials });
// 5-minute request timeout to accommodate large artifact uploads.
export const s3Client = new S3Client({
  region: AWS_REGION,
  credentials,
  requestHandler: { requestTimeout: 5 * 60 * 1000 },
});
