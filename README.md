This is a CLI tool to help make FIT easier to use.  It lets you:

* Generate a YAML/JSON5 definition file that will let you run functional FIT tests against any SDK.  (And later: FIT/SIT and FIT/PERF)
* Run a definition file locally.
* Run a definition file on a clean AWS EC2 instance you can SSH onto.  This is the exactly same command CI will ultimately execute, so you can reproduce (and debug!) CI locally.


If you're new to FIT in general see https://github.com/couchbaselabs/transactions-fit-performer/blob/master/README.md for an intro.

Currently not supported (but we want to get working):

* CNG testing.
* Performance testing.
* Analytics testing.

Everything else is expected to work, bugs excepted.


## Getting started

Install the [`fit` binary](https://github.com/couchbaselabs/fit-cli/releases):

```sh
curl -fsSL https://raw.githubusercontent.com/couchbaselabs/fit-cli/main/install.sh | bash

# CI scripts should use this instead to get the more stable "ci" channel:
# curl -fsSL https://raw.githubusercontent.com/couchbaselabs/fit-cli/main/install.sh | CHANNEL=ci bash
```

Then:

```sh
# One-off configuration
fit config edit

# Start the interactive wizard
fit wizard

# Or to see all commands
fit help
```
The interactive wizard will guide you through the available options in a (crosses fingers) self-documenting way.

### Issues
If you hit any problems, either ask on #the-fit-stop or consider just giving it to an LLM with something like:

```
Please read /tmp/fit-cli/<folder name>/AGENTS.md and investigate the failure.
```

LLMs can also be used to investigate GitHub Action runs - just point them at the URL.

### Contributing / running from source

If you're working on fit-cli itself, install Bun with `curl -fsSL https://bun.sh/install | bash` and then:

```sh
bun install

# One-off configuration
bun run config edit

# Start the interactive wizard
bun run wizard
```

## Running on a cloud instance (AWS EC2)

At the start of a FIT functional run you can choose to run on your own machine, or on a clean, throwaway AWS EC2 instance.
If you can run the `aws` command locally, then everything else should work. 

The AWS region and VPC are fixed (region `us-west-2`, VPC `fit-cli-vpc`, managed by `terraform/aws/vpc.tf`) and are not configurable because:

* Simplifies and derisks where to look for user's instances for cleanup.
* It means we always have a VPC and avoid hitting VPCIdNotSpecified if the user specifies a region that does not have a default one.

### Resuming
The output will guide you through how to resume where a failure happened, something like:

```
fit run definition --resume-at=after-cluster-creation examples/test.yaml
```

This can save valuable time when iterating a definition file.  It will try its best to resume, including checking that preceding steps such as cluster creation are resumable from.

But note that this is somewhat temperamental and experimental.  You may hit issues and patches are welcome.

You can also get very far by just rerunning the full definition file and using the performer onPortInUse and cluster useExisting settings to reuse existing resources.

## Running a single step or flow

To make debugging and development easier, most files have a header comment showing how to run it directly, e.g.

```
bun src/steps/ensure-repo.ts fit-performer
```
Note these aren't intended to be stable CLI commands.  They are just for transient debugging and development.  Paths may change, things may break, don't call these directly from CI - add a proper stable definition file if you need that.

If you find any are broken due to refactorings then please ask an AI to "sweep the files quickly".  It should find the instructions in this file.

## Scripts

User-facing (using the installed binary):
- `fit help` — show help.
- `fit wizard` — run the interactive wizard.
- `fit run preset <preset>` — generate a preset definition file and run it.
- `fit run definition <file>` — run an existing definition file (see Resuming for the resume flags).
- `fit definition validate | generate-desc` — author or inspect a definition file.
- `fit preset list | expand | generate` — list, expand or generate presets.
- `fit cloud-instances list | manage | delete | remove-all` — manage the EC2 instances fit-cli launched.
- `fit performer build <family> <ref>` — dispatch a performer image build on GitHub Actions (e.g. `fit performer build jvm refs/changes/01/248901/3`), wait for it, and print the resulting image names.
- `fit performer list [<sdk>]` — list the prebuilt performer container images published to GHCR for an SDK (e.g. `fit performer list scala`), or for every SDK if none is given.
- `fit performer run <sdk> [version]` — pull and start a single prebuilt performer image, for manual testing outside a full FIT run (e.g. `fit performer run scala`). Leaves it running; stop it yourself when done.
- `fit performer metadata <sdk> [version]` — pull a performer image and print all its metadata: Docker image labels (build time, revision, source, PR, CI run) and everything it reports over the `performerCapsFetch` gRPC call (user agent, library version, transactions protocol, and every capability).
- `fit caps table | sync` — show which FIT capabilities each SDK's performer reports (see Capabilities).

For development (from source with Bun):
- `bun run typecheck` — type-check without emitting.
- `bun run build` — compile TypeScript to `dist/`.
- `bun run test` — run the unit tests.  Note - these always need to be kept instant - business logic only.  If it's slow, just don't test it.

## Overriding preset versions (`--env-override`)
Presets don't hardcode versions - they template them in from `environments.json5`, e.g. `{{environments.defaults.clusterVersion}}`.
That file stays the source of truth, but a single run can override any of those values from the CLI:

```sh
# Run an on-prem preset against the previous server line instead of the default.
fit run preset op-onprem-func-lite --performer java-fit-performer:main --env-override defaults.clusterVersion=7.6-stable

# Capella situational presets key off capellaClusterVersion (composes with their `versions:` list).
fit run preset op-capella-sit-lite --performer java-fit-performer:main --env-override defaults.capellaClusterVersion=7.2

# Also works on generate-only: fit preset generate ... --env-override ...
```

The flag is repeatable and keyed by the placeholder's path. The override is baked into the generated
definition file, so that file alone still reproduces the run.

Two things fail fast rather than silently doing nothing: a path that isn't in `environments.json5` (a typo),
and one the chosen preset doesn't template in (e.g. `defaults.clusterVersion` on a Capella preset, which uses
`defaults.capellaClusterVersion`; or a CNG situational preset, whose server version is chosen at run time rather
than templated). When running a preset group, an override only has to apply to at least one preset in it.

## Capella
When running locally, we use Capella creds from your fit-cli config.  Generally you just need to provide your email address.  We default to using Capella's production environment.
When running on CI, the user chooses what Capella environment to use (stage, dev, etc.) and we use previously-setup accounts for those. 
cbdinocluster's cloud deployer authenticates with a Capella v4 organization API key.  By default the shared per-environment key is read from AWS Secrets Manager; override it with CAPELLA_API_KEY / CAPELLA_API_SECRET (or `config edit`).  The v2 username/password are still used for custom image deploys, server version changes, and columnar operations.

## Capabilities
Each performer declares what it supports — a set of "caps" — over the `performerCapsFetch` gRPC call.
There are three independent cap enums: SDK, transactions, and the performer harness itself.

```sh
# Start every SDK's performer, ask each what it supports, print the matrix
fit caps table
```

No cluster is needed: performers answer this call before connecting to anything. Each performer is
started from its `main` image, queried, and stopped again.

`caps.json5` is the catalogue of what each cap means. Performers report bare enum numbers, so that file
maps a number to its name, its description, and **the Jira ticket tracking it** — fill that in as caps
are added. When the FIT protos gain a cap, pick it up with:

```sh
fit caps sync <path-to-transactions-fit-performer>
```

which adds new caps and never overwrites the `jira` / `description` / `notes` you have written. A cap a
performer reports that `caps.json5` doesn't know about still appears in the table, flagged, so it can't
go unnoticed.

Note the Analytics performers don't implement this call (they use the separate columnar-test-driver), so
they aren't queried by default.

## General rules
Everyone - AI and human - please follow these as best you can.

- Run `bun run lint` and `bun run typecheck` and `bun run test` after writing code.

### Stability
This project aims to strike a balance between actively encouraging collaboration, and the need for a stable and reliable tool - particularly as it is used from CI.
There are three kinds of release channel, with installation instructions at https://github.com/couchbaselabs/fit-cli/releases:
- `ci` — manually promoted, infrequently, with advance notice. **Default for most users and CI.**
- `latest` — built on every push to main. For development and testing of fit-cli itself.
- branch channels — one per git branch (`CHANNEL=<branch>`), published and pruned automatically by the Maintenance workflow so you can install any branch's build. Ephemeral: removed when the branch is deleted.

To promote to `ci`, run https://github.com/couchbaselabs/fit-cli/actions/workflows/promote-ci.yaml.
Branch channels are managed by `fit maintenance channels` (see `--help`); the scheduled [Maintenance workflow](.github/workflows/maintenance.yaml) runs `channels sync --prune`.

### Documentation
While this project is generally very LLM-friendly - please keep project docs such as this README human-written, clear and concise.
The overall goal is 'spec-driven' development.  Coding is largely handled by LLMs, but the specs are human-written and reviewed.  
Targeted, specific, reviewed LLM edits are permitted; but keep all project docs (including this one) concise and accurate.
If you are an LLM, you must read relevant project docs and follow them.

This README has got very long and we are in the process of migrating parts to a `specs` directory.  
LLMs (and humans :) ) you MUST read the following spec files if they relate to something you are working on:

`specs/artifacts.md` - Covers how artifacts are stored and surfaced to the user.
`specs/credentials-and-secrets.md` - Covers how credentials and secrets are stored and used.
`specs/external-processes.md` - Covers running external processes, and handling their logging and errors consistently.
`specs/fit-definition-files.md` - Covers the FIT definition file.  Contains important rules that must be followed when extending that format, including versioning guidelines.
`specs/timers-and-lifetimes.md` - Covers things like how long EC2 instances will last, the max time for a GHA, etc.
`specs/errors.md` - Covers the error model: failure severities and how they map to CI exit behaviour.
`specs/cng.md` - Covers how CNG (Cloud Native Gateway) testing works, including the shared ROSA OpenShift cluster.
`specs/fit-testing-overview.md` - Concise overview of FIT itself (drivers, test types) as distinct from fit-cli.


### Steps and flows
The basic idea is to break everything down into small steps that compose into larger flows.
A step generally is a sequence of one or more prompts to the user, though sometimes a step is entirely non-interactive.
Inputs and outputs from steps are ideally clear and well-defined.

Each step should be runnable independently from the CLI wherever possible - see 'mini cli tools' below.  
This is for debugging and development rather than intended for end-users. 
End-users should be starting at `fit wizard`.

### Comments and code style
- Avoid comments that have "Step 1", "Step 2", etc.  They need updating too often.
- Avoid documenting the iterative steps during back-and-forth development between the LLM and developer.  Only document what you think a reader a year from now will still find relevant and useful. 

### Code structure
- Feel free to create files - think one file per clear step - and use a clear directory structure.
- Small utility business logic - consider moving this under a `util` sub-directory.
- Prefer `fit/shared/create-definition/create-definition.ts` over `fit/shared/create-definition/index.ts`, as it's easier to look for. 

### Mini CLI tools
- Each step should be easily runnable independently via a mini CLI tool that can be called directly, for debugging and development iteration purposes.  
- Keep this in the same file with its associated step.
- Include directions in that file on how to call the CLI tool.
- For these CLI tools, make sure I can test each individual step/function, as well as the full flow.
- Make the CLI tools take a `--help/-h` argument that explains it and the subcommands.
- If you move any files around, make sure these instructions continue to work.
- If asked to "sweep the files quickly" then please check all these CLI tools still look accurate.  You don't have to run them, just make sure the paths are correct.
- If asked to "sweep the files carefully" then do the above and also check each CLI tool also follows the instructions in this section.
- Whenever showing a step is about to run, include (if fairly simple) how that can be repro-ed on the cli using this cli tool.
- The mini CLI tool should output any final artifacts in a table (see Artifacts section).
- LLMs: after making changes, if possible give me the mini CLI command to run that step/workflow.
- For anything that can work on remote instances, make sure they support the `--dir /tmp/fit-cli/20260609-162046/instances/0` syntax.

### Top-level commands
These are ones exposed as `fit` subcommands e.g. `fit definition [execute|validate]`. `definition` is a top-level command, `execute` is a subcommand of it.
Top-level commands should appear in both packages.json and COMMANDS in main.ts.
Unlike Mini CLI these _are_ meant to be stable.  We should try not to break.
All top-level commands have at least one subcommand.  This gives room to expand in future.
If the user ran `fit` all when outputting commands they should generally show `fit X`.  If they ran with `bun` then generally `bun run X`.
Commands should never have `bun run X --` or `fit X --`, e.g. the `--` is totally superfluous now we've moved away from npm.

### Performers
We exclusively use the new prebuilt Docker performer images, and no longer support building them from source (jenkins-sdk `buildPerformer`).
All performer images should behave identically; existing in the same repo, with the same metadata.  If they don't then stop and raise, as that's a smell.

### Testing
- Anytime there's easy testable business logic, e.g. it doesn't require file access or similar, add unit tests.  Put these in a tests directory off the one being tested.
- But much of the code is hard and slow to test, depending on external repos, building Docker images etc.  Do not add tests for these. 
- Do not use mocks.  Only test easy business logic.
- Golden rule for LLMs: tests should not have side effects, and should not use mocks. Just do not add a test if it would contravene these rules. 

### Running workflows and steps
- Before a step does something, generally explain what will be done.  E.g. File X was written and contains contents Y.
  A goal here is to teach people how the individual steps work, so they can easily debug, reproduce, or just work without fit-cli if they prefer.
- Save the full output from each run to a unique debug logfile under /tmp/fit-cli.  Save that as an Artifact.

### Reproducibility:
Very key to this project is reproducibility.  It should be possible to recreate the same env that CI runs.
This leads us either to Docker or using cloud instances, and the latter is both more natively Windows friendly, and supports some key testing such as private links.

It's important that whatever inputs a user gives to a workflow be saved and be reusable, for both debugging and re-running.
Each fit-cli should create a user log file under /tmp/fit-cli with a unique name.  Display this name.
Associate each user prompt with a unique id.  Save the prompt id and the user's response into the log file.
The user can replay that with `fit replay <logfile>`.
Note that replays are inherently less reliable than definition files, since workflows change, and should be regarded as somewhat experimental and perhaps buggy at present.  So definition files are recommended usually.

### Iteration
Reproducibility is crucial - see above.
But creating a clean room every single iteration is also very slow, so we also allow many options that balance it with developer productivity.
Namely, we endeavour to support in addition to the primary clean instance flow:
- Running locally.
- Running on existing remote instances.
- Logic to handle pre-existing clusters, performers, etc. 

### Remote instances
- Automatically use new temporary keys (`aws ec2 create-key-pair`).
- Lifetime: we give the user the option on whether to delete the instance at the end, or leave it running for debugging.
  There is no built-in TTL system for EC2 so we make it very clear the user has to delete instances if they choose to leave them running.
- To clean up afterwards: `fit cloud-instances list` shows what's still running, and `fit cloud-instances remove-all` terminates every `fit-cli`-owned instance you created.

