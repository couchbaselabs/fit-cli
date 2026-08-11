import { AWS_REGION } from "../../cloud/util/aws/aws-target.js";
import { loadEnvironments } from "../../fit/util/environments.js";
import type { CapellaCloudProvider } from "./build-cluster-def.js";

/** The docker network clean FIT environments allocate their clusters on. */
export const DEFAULT_CBDINOCLUSTER_DOCKER_NETWORK = "fit";

/**
 * The `cbdinocluster init` flags shared by every clean remote FIT environment:
 * docker-only, on a dedicated `fit` network, with cloud/k8s/dns disabled. The
 * `capella` choice differs by purpose (see {@link defaultCbdinoclusterInitArgs}
 * vs {@link situationalCbdinoclusterInitArgs}), so it's not baked in here.
 *
 * GitHub is intentionally left unmentioned — fit-cli appends
 * `--github-user/--github-token` when it has credentials, or `--disable-github`
 * when it doesn't, rather than baking either choice into the definition.
 */
function baseCbdinoclusterInitArgs(dockerNetwork: string, disableCapella: boolean, awsRegion?: string): string {
  return [
    "--auto",
    ...(awsRegion ? [`--aws-region ${awsRegion}`] : ["--disable-aws"]),
    "--disable-azure",
    ...(disableCapella ? ["--disable-capella"] : []),
    "--disable-gcp",
    "--disable-k8s",
    "--disable-dns",
    `--docker-network ${dockerNetwork}`,
  ].join(" ");
}

/**
 * The default `cbdinocluster init` arguments for a clean remote FIT environment:
 * docker-only, on a dedicated `fit` network, with everything else (Capella
 * included) disabled. This is the editable string carried in the definition
 * file's `cbdinocluster.init.args`; fit-cli runs `cbdinocluster init <args>` on
 * the box and appends the GitHub credentials at runtime (so they stay out of the
 * file).
 */
export function defaultCbdinoclusterInitArgs(
  dockerNetwork: string = DEFAULT_CBDINOCLUSTER_DOCKER_NETWORK,
): string {
  return baseCbdinoclusterInitArgs(dockerNetwork, true);
}

/**
 * Like {@link defaultCbdinoclusterInitArgs} but leaves Capella *enabled* so that
 * `cbdinocluster init --auto` populates the `capella` block from the `CAPELLA_*`
 * environment variables fit-cli forwards to the box (see
 * `uploadRemoteCapellaConfig` / cbdinocluster's `cmd/init.go`). With a
 * `CAPELLA_API_SECRET` present, `--auto` enables and fills in Capella; without
 * one it leaves Capella disabled.
 *
 * `cloudProvider` picks which direct cloud-infra block cbdinocluster also needs:
 * situational PE (`private-endpoints setup-link`) calls the CSP's API directly, so
 * whichever CSP the instance/cluster is on needs its block enabled — mirroring
 * {@link capellaFunctionalCbdinoclusterInitArgs}. AWS credentials are uploaded
 * before init runs (see `uploadRemoteAwsCredentials` in `run-from-definition.ts`),
 * so `--aws-region` here lets `--auto` enable the aws block directly. GCP needs no
 * equivalent upload — the box's attached service account already provides ADC, so
 * `--gcp-project-id`/`--gcp-region` alone are enough for `--auto` to enable the
 * gcp block.
 */
export function situationalCbdinoclusterInitArgs(
  dockerNetwork: string = DEFAULT_CBDINOCLUSTER_DOCKER_NETWORK,
  cloudProvider: "aws" | "gcp" = "aws",
): string {
  const gcp = loadEnvironments().defaults.gcp;
  return [
    "--auto",
    ...(cloudProvider === "aws" ? [`--aws-region ${AWS_REGION}`] : ["--disable-aws"]),
    "--disable-azure",
    ...(cloudProvider === "gcp" && gcp?.project && gcp.region
      ? [`--gcp-project-id ${gcp.project}`, `--gcp-region ${gcp.region}`]
      : ["--disable-gcp"]),
    "--disable-k8s",
    "--disable-dns",
    `--docker-network ${dockerNetwork}`,
  ].join(" ");
}

/**
 * The `cbdinocluster init` arguments for a functional run that creates a Capella
 * cloud cluster. Capella is enabled (no `--disable-capella`) and the chosen
 * cloud provider is set as the default. Direct cloud-infrastructure access
 * (AWS/GCP/Azure) is not normally needed — Capella manages the underlying infra
 * through its own API — so those blocks stay disabled.
 *
 * `privateEndpoint` is the exception: `cbdinocluster private-endpoints setup-link`
 * calls the CSP's API directly to wire up the private link (AWS `CreateVpcEndpoint`/
 * `ModifyVpcEndpoint`, or GCP's PSC forwarding-rule equivalent), so it needs the
 * matching cloud block enabled — whichever one matches `cloudProvider`, since PE
 * only makes sense when the test box and the Capella cluster share a CSP.
 * AWS credentials are uploaded before init runs (see `uploadRemoteAwsCredentials`
 * in `run-from-definition.ts`), so `--aws-region` here lets `--auto` enable the aws
 * block directly. GCP needs no equivalent upload: the box's attached service
 * account (see `terraform/gcp/service-account.tf`) already provides ADC, so
 * `--gcp-project-id`/`--gcp-region` alone are enough for `--auto` to enable the
 * gcp block.
 *
 * `--capella-provider` sets the default provider in `~/.cbdinocluster`;
 * `--capella-*-region` pre-fills the per-provider region defaults so
 * `cbdinocluster init --auto` doesn't interactively prompt for them.
 * The CAPELLA_* credentials are forwarded as environment variables before init
 * runs (see `uploadRemoteCapellaConfig` in `run-from-definition.ts`).
 */
export function capellaFunctionalCbdinoclusterInitArgs(
  cloudProvider: CapellaCloudProvider,
  dockerNetwork: string = DEFAULT_CBDINOCLUSTER_DOCKER_NETWORK,
  privateEndpoint = false,
): string {
  const gcp = loadEnvironments().defaults.gcp;
  return [
    "--auto",
    ...(privateEndpoint && cloudProvider === "aws" ? [`--aws-region ${AWS_REGION}`] : ["--disable-aws"]),
    "--disable-azure",
    ...(privateEndpoint && cloudProvider === "gcp" && gcp?.project && gcp.region
      ? [`--gcp-project-id ${gcp.project}`, `--gcp-region ${gcp.region}`]
      : ["--disable-gcp"]),
    `--capella-provider ${cloudProvider}`,
    // Pre-fill region defaults for all three providers so init --auto never prompts.
    "--capella-aws-region us-west-2",
    "--capella-azure-region westus2",
    "--capella-gcp-region us-west1",
    "--disable-k8s",
    "--disable-dns",
    `--docker-network ${dockerNetwork}`,
  ].join(" ");
}

/**
 * Like {@link situationalCbdinoclusterInitArgs} but without AWS: Capella Analytics
 * uses cbdinocluster's `cloud` deployer (Capella control plane) for cluster
 * allocation rather than direct EC2, so no `--aws-region` is needed. Capella is
 * left enabled so `--auto` writes the capella block from the `CAPELLA_*` env vars
 * that fit-cli uploads before init runs (see `uploadCapellaCredsForCloudDeployer`).
 */
export function capellaAnalyticsCbdinoclusterInitArgs(
  dockerNetwork: string = DEFAULT_CBDINOCLUSTER_DOCKER_NETWORK,
): string {
  return baseCbdinoclusterInitArgs(dockerNetwork, false);
}

