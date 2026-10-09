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
import type { LocalHealthStore } from "../store/health-store.js";
import { openStore, showOrSetJson } from "../store/s3-store.js";
import type { ReportNotes } from "./build-report.js";
import { STORE_OPTION, parseSdkCommandArgs } from "../cli-args.js";

export const notesKey = (sdk: string) => `${sdk}/notes.json`;

export function readNotes(store: LocalHealthStore, sdk: string): ReportNotes {
  return store.readJson<ReportNotes>(notesKey(sdk)) ?? {};
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
  const usage = `Show or set an SDK's hand-written report notes (known fixes), kept in the store.

Usage:
  ${prefix} <sdk> [--set <file.json5>] [--store <dir|s3://bucket/prefix/>]

A notes file looks like:
  { fixes: { "SetAuthenticatorTest.canSetAuthenticator": { ticket: "NCBC-4304", text: "..." } } }`;
  const args = parseSdkCommandArgs(argv, { ...STORE_OPTION, set: { type: "string" } }, usage);
  if (!args) return {};
  const { values, sdk } = args;
  const file = values.set;
  const opened = await openStore(values.store, sdk, { skipRawLogs: true });
  await showOrSetJson<ReportNotes>(opened, notesKey(sdk), `${sdk}'s notes`, file ? () => {
    const notes = JSON5.parse<unknown>(readFileSync(file, "utf8"));
    const problems = validateNotes(notes);
    if (problems.length) throw new Error(`Invalid notes in ${file}: ${problems.join("; ")}`);
    return notes as ReportNotes;
  } : undefined);
  return {};
}

if (isMain(import.meta.url)) {
  runCli(() => runNotesCommand(process.argv.slice(2), "bun src/fit/health/report/notes.ts"));
}
