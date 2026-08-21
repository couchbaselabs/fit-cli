#!/usr/bin/env node
/**
 * fit slack — internal command backing the GHA preset-group Slack summary.
 *
 * A GHA preset group expands into one matrix job per preset (see
 * .github/workflows/fit-cli.yaml), each its own process — unlike a local
 * `fit run preset <group>`, no single process ever sees the whole group, so
 * `run.ts`'s in-memory combined-message trick (see RunFromDefinitionOptions.deferSlackTo)
 * doesn't apply. Each matrix job instead writes its own SlackRunResult[] to a file via
 * `fit run preset ... --slack-result-file <path>`, uploads it as a GHA artifact, and a
 * final job (needs: the matrix job, if: always()) downloads every artifact — each lands
 * in its own subdirectory, since every matrix job's file has the same name — and calls
 * this to post them all as a single combined message. `collectSlackResults` walks `dir`
 * recursively, so the raw download-artifact output can be passed straight through with
 * no flattening step in the workflow itself.
 *
 *   bun src/fit/slack/slack-cli.ts post-collected <permalink|channel:ts> <title> <dir>
 *
 * Each result file is a SlackResultFile — one per preset that ran, e.g.:
 *   {
 *     "passed": true,
 *     "results": [
 *       {
 *         "label": "aws1 / java:main / functional",
 *         "sdk": "java:main",
 *         "ok": true,
 *         "testsRun": 5824,
 *         "failures": 0,
 *         "errors": 0,
 *         "skipped": 381,
 *         "durationMs": 2106000
 *       }
 *     ]
 *   }
 * A preset that crashed before producing any result (see run.ts) writes a placeholder
 * instead, e.g.:
 *   {"passed":false,"results":[{"label":"op-crashed-preset","sdk":"op-crashed-preset","ok":false}]}
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import { postSlackRunResults } from "./post-run-summary.js";
import type { SlackRunResult } from "./util/slack-results.js";

/** The shape `--slack-result-file` writes — see run.ts. */
export interface SlackResultFile {
  passed: boolean;
  results: SlackRunResult[];
}

/** Every `*.json` file under `dir`, at any depth — download-artifact nests each matrix job's file in its own subdirectory. */
function findJsonFilesRecursively(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...findJsonFilesRecursively(full));
    else if (entry.name.endsWith(".json")) files.push(full);
  }
  return files;
}

/** Read every `*.json` file under `dir` (one per matrix job, at any depth) and merge into one summary. */
export function collectSlackResults(dir: string): SlackResultFile {
  const files = findJsonFilesRecursively(dir);
  const results: SlackRunResult[] = [];
  let passed = true;
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as SlackResultFile;
    results.push(...parsed.results);
    if (!parsed.passed) passed = false;
  }
  return { passed, results };
}

async function cmdPostCollected(slackThread: string, title: string, dir: string): Promise<void> {
  const { passed, results } = collectSlackResults(dir);
  if (results.length === 0) {
    console.warn(`Slack: no result files found in ${dir}; skipping combined run summary.`);
    return;
  }
  await postSlackRunResults({ slackThread, title, results, passed });
}

/** Write a single-row "failed, no results" SlackResultFile — see run.ts's --slack-result-file. */
export function cmdWritePlaceholder(path: string, label: string): void {
  const placeholder: SlackResultFile = { passed: false, results: [{ label, sdk: label, ok: false }] };
  writeFileSync(path, JSON.stringify(placeholder), "utf8");
}

function helpText(): string {
  const p = runScriptPrefix("slack");
  return `fit-cli internal Slack helper (backs the GHA preset-group summary).

Usage:
  ${p} post-collected <permalink|channel:ts> <title> <dir-of-result-files>
  ${p} write-placeholder <path> <label>

post-collected merges every *.json file in <dir> (each a {passed, results} written by
\`fit run preset ... --slack-result-file\`) and posts one combined Slack summary.

write-placeholder writes a single failed row for <label> to <path> — used as a
before-the-fact fallback (see .github/workflows/fit-cli.yaml) so a preset that crashes
before \`fit run\` even starts still shows up in the combined message, instead of
silently vanishing.`;
}

export function runSlackMain(): void {
  runCli(async () => {
    const [command, ...rest] = process.argv.slice(2);
    switch (command) {
      case "post-collected": {
        const [slackThread, title, dir] = rest;
        if (!slackThread || !title || !dir) {
          throw new Error("post-collected needs <permalink|channel:ts> <title> <dir-of-result-files>.");
        }
        await cmdPostCollected(slackThread, title, dir);
        return;
      }
      case "write-placeholder": {
        const [path, label] = rest;
        if (!path || !label) {
          throw new Error("write-placeholder needs <path> <label>.");
        }
        cmdWritePlaceholder(path, label);
        return;
      }
      default:
        console.log(helpText());
        if (command !== undefined && command !== "--help" && command !== "-h") process.exit(2);
    }
  });
}

if (isMain(import.meta.url)) {
  runSlackMain();
}
