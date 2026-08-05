/**
 * Workflow: decide where the FIT run should execute — the user's own machine, a
 * clean, throwaway AWS EC2 instance, or an EC2 instance that's already running
 * (e.g. one a previous run left up for debugging). Returns an ExecutionTarget the
 * rest of the flow can run commands against, plus a cleanup handle: a no-op for
 * local and for an existing instance (the user brought it, so we leave it alone);
 * for a freshly provisioned box, enough information for the caller to decide
 * whether to terminate it or keep it for debugging.
 *
 * The EC2 paths need AWS credentials. We read them from the normal environment
 * and the user's fit-cli config file; if they're missing or invalid we
 * say so and loop back to the choice, so the user can fall back to local
 * without re-running.
 *
 * Run this workflow on its own (picks a target, runs `uname -a` on it, cleans up):
 *   bun src/fit/functional/select-execution-target/select-execution-target.ts
 *
 * To preview what the various AWS credentials failure/success outputs look like:
 *   bun src/cloud/util/aws/identity.ts simulate <no-creds|wrong-tenant|assume-fail|success>
 */
import { type RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { resolveCloudInstanceType, type CloudInstancePurpose } from "../../util/config.js";
import { fitCliError, fitCliWarn } from "../../../util/non-fit/fit-cli-log.js";
import { input, select } from "../../../util/non-fit/prompts.js";
import { LocalTarget } from "../../../util/non-fit/local-target.js";
import { checkAwsCredentials } from "../../../cloud/util/aws/identity.js";
import { listInstances } from "../../../cloud/util/aws/list-instances.js";
import { terminateInstance } from "../../../cloud/util/aws/terminate-instance.js";
import { type InstanceInfo } from "../../../cloud/util/aws/parse-instance.js";
import { type ExecutionTarget } from "../../../util/non-fit/target.js";
import { FIT_INSTANCE_USER, provisionFitInstance } from "../../util/aws/fit-instance.js";
import { ssmStartSessionCommand } from "../../util/aws/lifecycle-warning.js";
import { SsmTarget, waitForSsmReady } from "../../../util/non-fit/ssm-target.js";
import type { ResolvedInstance } from "../../shared/definition/resolve-definition.js";
import type { ResumeTargetState } from "../run-from-definition/resume-state.js";

/**
 * How to tear down (or leave up) the chosen target. The run owns the decision —
 * see the unified "leave everything up?" prompt in run-from-definition — so this
 * carries the primitives rather than prompting itself. `terminate` is present
 * only for an instance fit-cli is responsible for.
 */
export interface ExecutionTargetTeardown {
  kind: "local" | "remote";
  instanceId?: string;
  /** Whether fit-cli provisioned this instance (vs. the user bringing an existing one). */
  owned?: boolean;
  /** Terminate the instance. */
  terminate?: () => Promise<void>;
}

/** The outcome of choosing where to run. */
export type ExecutionTargetOutcome =
  /** A target is ready; `teardown` carries how to dispose of (or keep) it. */
  | (RunOutput & { ready: true; target: ExecutionTarget; teardown: ExecutionTargetTeardown })
  /** No target is ready; the reason was already printed. */
  | (RunOutput & { ready: false });

type TargetChoice = "local" | "ec2" | "existing";

/** The connection details for a user-brought EC2 instance, reused across a run. */
export interface ExistingInstanceConnection {
  instanceId: string;
}

/**
 * The run-wide choice over where a definition's execution groups run: honour the
 * file ("definition"), force everything onto localhost, or run every group on one
 * existing EC2 instance the user picked up front (good for rapid iteration).
 */
export type ExecutionOverride =
  | { kind: "definition" }
  | { kind: "localhost" }
  | { kind: "aws" }
  | { kind: "existing"; existing: ExistingInstanceConnection };

/** Sentinel value for the "type the connection details myself" choice. */
const MANUAL_INSTANCE = "__manual__";

function promptId(attempt: number, suffix: string): string {
  return `execution-target.attempt-${attempt}.${suffix}`;
}

const LOCAL_TEARDOWN: ExecutionTargetTeardown = { kind: "local" };

/**
 * Reconnect to the target a previous run used, without prompting — the resume
 * path. Local is immediate; a remote target is reached over SSM using the saved
 * instance id, and is verified reachable before returning.
 */
export async function reconnectExecutionTarget(target: ResumeTargetState): Promise<ExecutionTargetOutcome> {
  if (target.kind === "local") {
    return { ready: true, target: new LocalTarget(), teardown: LOCAL_TEARDOWN, artifacts: [], details: [] };
  }

  const { instanceId } = target;
  if (!instanceId) {
    fitCliError("\nresume: the saved run state is missing the instance id.");
    return { ready: false, artifacts: [], details: [] };
  }

  process.stdout.write(`Reconnecting to ${instanceId}...`);
  if (!(await waitForSsmReady(instanceId))) {
    console.log(" unreachable");
    fitCliError(`\nresume: couldn't reach ${instanceId} over SSM. The instance may be stopped or gone.`);
    return { ready: false, artifacts: [], details: [] };
  }
  console.log(" ready");

  const teardown: ExecutionTargetTeardown = {
    kind: "remote",
    instanceId,
    owned: target.owned,
    ...(target.owned ? { terminate: () => terminateInstance(instanceId) } : {}),
  };
  return {
    ready: true,
    target: new SsmTarget(instanceId, FIT_INSTANCE_USER),
    teardown,
    artifacts: [],
    details: [{ label: "Debug access (SSM)", value: ssmStartSessionCommand(instanceId) }],
  };
}

/**
 * Acquire the execution target a single execution group declared in its definition, without
 * prompting for *which* kind of target to use — that choice lives in the file (or in the
 * run-wide `override`). A localhost execution group (or any execution group under the
 * localhost override) runs here on this machine; under the "existing" override every group
 * runs on the one user-brought EC2 instance (nothing to provision or tear down); otherwise
 * an AWS execution group checks credentials and provisions a clean EC2 box whose key lands
 * under the instance's run directory. Returns `ready: false` (reason already printed) if EC2
 * credentials are unusable or provisioning fails, so the caller can treat it as fatal to the
 * execution group.
 */
export async function resolveExecutionGroupTarget(
  instance: ResolvedInstance,
  override: ExecutionOverride,
  executionGroupIndex: number,
  purpose: CloudInstancePurpose,
  interactive?: boolean,
): Promise<ExecutionTargetOutcome> {
  // The run-wide "existing EC2 instance" override: every group runs on the box
  // the user picked up front. They brought it, so cleanup is a no-op.
  if (override.kind === "existing") {
    const { instanceId } = override.existing;
    return {
      ready: true,
      target: new SsmTarget(instanceId, FIT_INSTANCE_USER),
      teardown: { kind: "remote", instanceId },
      artifacts: [],
      details: [{ label: "Debug access (SSM)", value: ssmStartSessionCommand(instanceId) }],
    };
  }

  if (override.kind === "localhost" || (override.kind === "definition" && instance.kind === "localhost")) {
    return { ready: true, target: new LocalTarget(), teardown: LOCAL_TEARDOWN, artifacts: [], details: [] };
  }

  // AWS EC2 needs a working fit-cli-role session — check very early, before any provisioning.
  const creds = await checkAwsCredentials();
  if (!creds.ok) {
    fitCliError(`\nCan't use EC2 for this execution group: ${creds.message}`);
    return { ready: false, artifacts: [], details: [] };
  }

  try {
    // The definition's explicit instanceType wins; otherwise use the configured
    // default for this run's purpose (functional/situational/perf).
    const instanceType = (instance.kind === "aws" ? instance.instanceType : undefined) ?? resolveCloudInstanceType(purpose);
    const privateEndpoint = instance.kind === "aws" ? instance.privateEndpoint : undefined;
    const provisioned = await provisionFitInstance({
      instanceIndex: executionGroupIndex,
      instanceType,
      interactive,
      ...(privateEndpoint !== undefined ? { privateEndpoint } : {}),
    });
    const teardown: ExecutionTargetTeardown = {
      kind: "remote",
      instanceId: provisioned.instanceId,
      owned: true,
      terminate: provisioned.terminate,
    };
    return { ready: true, target: provisioned.target, teardown, artifacts: provisioned.artifacts, details: provisioned.details };
  } catch (err) {
    fitCliError(`\n✗ Could not provision an EC2 instance: ${err instanceof Error ? err.message : String(err)}`);
    return { ready: false, artifacts: [], details: [] };
  }
}

/**
 * Ask where the FIT run should execute and return a ready-to-use target. Local
 * is immediate; the EC2 paths check credentials (looping back to the prompt if
 * they're missing) and then either provision a fresh instance or connect to one
 * that's already running.
 */
export async function selectExecutionTarget(): Promise<ExecutionTargetOutcome> {
  let attempt = 1;
  for (;;) {
    const choice = await select<TargetChoice>({
      promptId: promptId(attempt, "choose"),
      message: "Where should this FIT run execute?",
      choices: [
        { name: "A clean AWS EC2 instance", value: "ec2" },
        { name: "This machine (local)", value: "local" },
          // Temporarily hidden as not sure how well this works currently..  Also it's maybe better handled with resume.
        // { name: "An existing EC2 instance", value: "existing" },
      ],
    });

    if (choice === "local") {
      return { ready: true, target: new LocalTarget(), teardown: LOCAL_TEARDOWN, artifacts: [], details: [] };
    }

    // Both EC2 paths need a working fit-cli-role session.
    const creds = await checkAwsCredentials();
    if (!creds.ok) {
      fitCliError(`\nCan't use EC2: ${creds.message}`);
      attempt += 1;
      continue; // back to the target prompt
    }

    if (choice === "existing") {
      const outcome = await connectExistingInstance(attempt);
      if (outcome === "back") {
        attempt += 1;
        continue; // back to the target prompt
      }
      return outcome;
    }

    try {
      const instance = await provisionFitInstance({ interactive: true });
      const teardown: ExecutionTargetTeardown = {
        kind: "remote",
        instanceId: instance.instanceId,
        owned: true,
        terminate: instance.terminate,
      };
      return { ready: true, target: instance.target, teardown, artifacts: instance.artifacts, details: instance.details };
    } catch (err) {
      console.error(`\n✗ Could not provision an EC2 instance: ${err instanceof Error ? err.message : String(err)}`);
      return { ready: false, artifacts: [], details: [] };
    }
  }
}

/**
 * Connect to an already-running EC2 instance the user supplies — typically one a
 * previous run left up for debugging. We list the fit-cli–owned boxes so they can
 * be picked from a menu (or the address typed by hand), then ask for the SSH key
 * and login user and verify the box is reachable. Cleanup is a no-op: the user
 * brought this instance, so tearing it down isn't ours to do.
 *
 * Returns "back" if the user wants to return to the target prompt (e.g. SSH never
 * came up), so the caller can loop without re-running.
 */
async function connectExistingInstance(attempt: number): Promise<ExecutionTargetOutcome | "back"> {
  let running: InstanceInfo[];
  try {
    running = (await listInstances()).filter((instance) => instance.state === "running");
  } catch (err) {
    fitCliError(`\nCould not list fit-cli instances: ${err instanceof Error ? err.message : String(err)}\n`);
    return "back"; // back to the target prompt
  }

  if (running.length === 0) {
    fitCliWarn("\nNo running fit-cli EC2 instances found to reuse — pick another way to run.\n");
    return "back"; // back to the target prompt
  }

  const chosen = await select<string>({
    promptId: promptId(attempt, "existing.choose"),
    message: "Which instance should this FIT run use?",
    choices: [
      ...running.map((instance) => {
        const addr = instance.publicDns || instance.publicIp;
        return { name: `${instance.instanceId}${addr ? ` (${addr})` : ""}`, value: instance.instanceId };
      }),
      { name: "Enter an instance id manually", value: MANUAL_INSTANCE },
    ],
  });

  const instanceId = chosen === MANUAL_INSTANCE
    ? await input({
        promptId: promptId(attempt, "existing.instance-id"),
        message: "EC2 instance id:",
        validate: (value) => (value.trim().length > 0 ? true : "Enter an instance id."),
      }).then((value) => value.trim())
    : chosen;

  process.stdout.write(`Checking SSM on ${instanceId}...`);
  if (!(await waitForSsmReady(instanceId))) {
    console.log(" unreachable");
    fitCliError(`\nCouldn't reach ${instanceId} over SSM. Check the instance id and that it's registered with SSM.\n`);
    return "back";
  }
  console.log(" ready");

  console.log(`\n✓ Connected to existing instance ${instanceId}`);
  // The user brought this instance, so fit-cli won't terminate it — no `terminate`.
  return {
    ready: true,
    target: new SsmTarget(instanceId, FIT_INSTANCE_USER),
    teardown: { kind: "remote", instanceId, owned: false },
    artifacts: [],
    details: [{ label: "Debug access (SSM)", value: ssmStartSessionCommand(instanceId) }],
  };
}

/**
 * For the run-wide "existing EC2 instance" override: check AWS credentials, then
 * connect to an instance the user picks, returning just the connection details so
 * the caller can run every execution group on it. Returns "back" (reason already
 * printed) when the user should be re-prompted — missing credentials, no running
 * instances, or an unreachable box.
 */
export async function selectExistingInstanceForOverride(
  attempt: number,
): Promise<ExistingInstanceConnection | "back"> {
  const creds = await checkAwsCredentials();
  if (!creds.ok) {
    fitCliError(`\nCan't use an existing EC2 instance: ${creds.message}`);
    return "back";
  }

  const outcome = await connectExistingInstance(attempt);
  if (outcome === "back" || !outcome.ready) {
    return "back";
  }
  const { instanceId } = outcome.teardown;
  if (!instanceId) {
    return "back";
  }
  return { instanceId };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const outcome = await selectExecutionTarget();
    if (!outcome.ready) {
      process.exit(1);
    }
    console.log(`\nTarget: ${outcome.target.description} (${outcome.target.kind})`);
    await outcome.target.run("uname", ["-a"]);
    if (outcome.teardown.terminate) {
      await outcome.teardown.terminate();
    }
    return { artifacts: outcome.artifacts, details: outcome.details };
  });
}
