/**
 * Workflow: regenerate the FIT protobuf types the performance engine speaks.
 *
 * The .proto files are the performers' interface and live with them, in
 * transactions-fit-performer's `gRPC/` directory. This reads them from a checkout and writes
 * TypeScript into `src/fit/performance/generated/`, which is committed — fit-cli ships as a
 * `bun build --compile` binary and is usually run from a checkout with no protoc, so
 * generation is a deliberate developer action rather than part of the build.
 *
 * Run it after pulling protocol changes that the perf engine needs:
 *   bun src/fit/performance/generate-protocol/generate-protocol.ts
 *   bun src/fit/performance/generate-protocol/generate-protocol.ts --performer-dir /path/to/checkout
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { run } from "../../../util/non-fit/proc.js";
import { resolveFitPerformerDir } from "../../util/config.js";

/** Where in the performer checkout the .proto files live. */
export const PROTO_SUBDIR = "gRPC";

/** Where the generated TypeScript is written, relative to the repo root. */
export const GENERATED_DIR = join("src", "fit", "performance", "generated");

/**
 * The columnar protos are skipped.
 *
 * They sit in a subdirectory and import their siblings by bare filename, which only resolves
 * if that subdirectory is itself an import root — and buf doesn't add one. Performance testing
 * doesn't use them, so excluding them is cheaper than reshaping the input.
 */
export const EXCLUDED_PROTO_PATHS = ["columnar"];

/**
 * The buf args that generate the protocol, run from the fit-cli repo root.
 *
 * Excluded paths are absolute: buf resolves a relative `--exclude-path` against the working
 * directory, not against the input, and rejects one that escapes it.
 */
export function bufGenerateArgs(protoDir: string, templatePath: string): string[] {
  return ["generate", protoDir, "--template", templatePath, ...EXCLUDED_PROTO_PATHS.flatMap((path) => ["--exclude-path", join(protoDir, path)])];
}

export interface GenerateProtocolOptions {
  /** The transactions-fit-performer checkout. Defaults to the one fit-cli is configured with. */
  performerDir?: string;
  /** Repo root, i.e. where buf.gen.yaml lives. Defaults to the current working directory. */
  repoRoot?: string;
}

export async function generateProtocol(options: GenerateProtocolOptions = {}): Promise<void> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const performerDir = options.performerDir ?? resolveFitPerformerDir();
  if (!performerDir) {
    throw new Error(
      "No transactions-fit-performer checkout configured. Pass --performer-dir <path>, set FIT_PERFORMER_DIR, " +
        "or set localhost.repos.transactions-fit-performer.dir with `fit config edit`.",
    );
  }

  const protoDir = join(resolve(performerDir), PROTO_SUBDIR);
  if (!existsSync(protoDir)) {
    throw new Error(`${protoDir} does not exist — is ${performerDir} a transactions-fit-performer checkout?`);
  }
  const template = join(repoRoot, "buf.gen.yaml");
  if (!existsSync(template)) {
    throw new Error(`${template} does not exist — run this from the fit-cli repo root, or pass --repo-root.`);
  }

  // Run from the repo root: buf.gen.yaml's `out` is relative to the working directory.
  console.log(`Generating ${GENERATED_DIR} from ${protoDir}`);
  await run("bunx", ["buf", ...bufGenerateArgs(protoDir, template)], repoRoot);
  console.log(`\n✓ Wrote ${join(repoRoot, GENERATED_DIR)}`);
  console.log("  Commit the result: it is what the compiled binary ships with.");
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
      console.log(
        [
          "Regenerate the FIT protobuf types used by the performance engine.",
          "",
          "  --performer-dir <path>   transactions-fit-performer checkout to read gRPC/*.proto from.",
          "                           Defaults to the one fit-cli is configured with.",
          "  --repo-root <path>       fit-cli repo root (where buf.gen.yaml lives). Defaults to cwd.",
        ].join("\n"),
      );
      return { artifacts: [], details: [] };
    }
    const valueOf = (flag: string): string | undefined => {
      const index = argv.indexOf(flag);
      return index === -1 ? undefined : argv[index + 1];
    };
    await generateProtocol({ performerDir: valueOf("--performer-dir"), repoRoot: valueOf("--repo-root") });
    return { artifacts: [], details: [] };
  });
}
