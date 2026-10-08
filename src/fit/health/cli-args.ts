/**
 * Argument parsing for the `fit health` commands: node:util's parseArgs, with the SDK as the
 * one positional. Flags and the SDK can come in any order (`report --no-slack dotnet` and
 * `report dotnet --no-slack` are the same), and an unknown flag is an error, not ignored.
 */
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

/** The flag every command that works on a store takes. */
export const STORE_OPTION = { store: { type: "string" } } as const;

const HELP = { help: { type: "boolean", short: "h" } } as const;

/**
 * Parse `argv` against `options`, plus --help/-h. At most `maxPositionals` positionals (default
 * 1, the SDK; the first is returned as `sdk`). A parse error carries the command's usage text.
 */
export function parseHealthArgs<const O extends ParseArgsOptionsConfig>(argv: string[], options: O, usage: string, maxPositionals = 1) {
  const config = { args: argv, options: { ...options, ...HELP }, allowPositionals: true, strict: true } as const;
  let parsed: ReturnType<typeof parseArgs<typeof config>>;
  try {
    parsed = parseArgs(config);
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n\n${usage}`, { cause: err });
  }
  const { values, positionals } = parsed;
  if (positionals.length > maxPositionals) throw new Error(`Unexpected argument: ${positionals[maxPositionals]}\n\n${usage}`);
  return { values, sdk: positionals[0] as string | undefined, positionals, help: (values as { help?: boolean }).help === true };
}
