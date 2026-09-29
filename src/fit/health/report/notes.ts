#!/usr/bin/env node
/**
 * Show or set an SDK's hand-written report notes (known fixes), kept in the store beside its
 * records as <sdk>/notes.json, so a report reads the same notes whichever store it runs on.
 *
 *   bun src/fit/health/report/notes.ts <sdk> [--set <file>] [--store <dir|s3://…>]
 */
import { readFileSync } from "node:fs";
import JSON5 from "json5";
import type { RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliInfo, printWithoutTimestamps } from "../../../util/non-fit/fit-cli-log.js";
import type { LocalHealthStore } from "../store/health-store.js";
import { openStore } from "../store/s3-store.js";
import type { ReportNotes } from "./build-report.js";

export const notesKey = (sdk: string) => `${sdk}/notes.json`;

export function readNotes(store: LocalHealthStore, sdk: string): ReportNotes {
  const raw = store.read(notesKey(sdk));
  return raw ? (JSON.parse(raw.toString("utf8")) as ReportNotes) : {};
}

/** Problems with a notes file, as sentences. */
export function validateNotes(n: unknown): string[] {
  const o = n as ReportNotes | null;
  if (!o || typeof o !== "object") return ["notes must be an object"];
  const problems: string[] = [];
  for (const k of Object.keys(o)) if (k !== "fixes") problems.push(`unknown field "${k}" (only "fixes" is supported)`);
  for (const [test, f] of Object.entries(o.fixes ?? {})) {
    if (!/^[\w$]+\.\S+$/.test(test)) problems.push(`fixes key "${test}" is not a Class.method test id`);
    if (!f || typeof f.text !== "string" || !f.text) problems.push(`fixes["${test}"] needs a text`);
  }
  return problems;
}

export async function runNotesCommand(argv: string[], prefix: string): Promise<Partial<RunOutput>> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    console.log(`Show or set an SDK's hand-written report notes (known fixes), kept in the store.

Usage:
  ${prefix} <sdk> [--set <file.json5>] [--store <dir|s3://bucket/prefix/>]

A notes file looks like:
  { fixes: { "SetAuthenticatorTest.canSetAuthenticator": { ticket: "NCBC-4304", text: "..." } } }`);
    return {};
  }
  const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const sdk = argv.find((a, i) => !a.startsWith("-") && !argv[i - 1]?.startsWith("--"))!;
  const file = opt("set");
  const opened = await openStore(opt("store") ?? process.env.FIT_HEALTH_STORE, sdk, { skipRawLogs: true });
  try {
    if (file) {
      const notes = JSON5.parse<unknown>(readFileSync(file, "utf8"));
      const problems = validateNotes(notes);
      if (problems.length) throw new Error(`Invalid notes in ${file}: ${problems.join("; ")}`);
      opened.store.write(notesKey(sdk), JSON.stringify(notes, null, 1) + "\n");
      await opened.flush();
      fitCliInfo(`Set ${sdk}'s notes in ${opened.location}`);
    }
    printWithoutTimestamps(JSON.stringify(readNotes(opened.store, sdk), null, 1));
  } finally {
    opened.close();
  }
  return {};
}

if (isMain(import.meta.url)) {
  runCli(() => runNotesCommand(process.argv.slice(2), "bun src/fit/health/report/notes.ts"));
}
