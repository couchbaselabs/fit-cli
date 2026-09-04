/**
 * Mini CLI: fetch rows from the results database's `runs` table by id — every
 * column of `runs` (id, datetime, params), and nothing from `buckets` or the
 * other timeseries tables, which are much larger and rarely what you want when
 * just checking a specific run.
 *
 *   bun run src/fit/shared/query-runs/query-runs.ts <run-id> [<run-id>...] [--env dev|prod]
 *
 * Requires the vpn-public VPN (same as the results database generally).
 */
import postgres from "postgres";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { resolveResultsDbCredentials, DEFAULT_RESULTS_ENV, type ResolvedResultsDbCredentials } from "../../util/config.js";

const RESULTS_DB_PORT = 5432;
const RESULTS_DB_NAME = "perf";
// A canonical dashed UUID (8-4-4-4-12 hex), the shape of a run id.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


/** A row from the `runs` table — shape is whatever columns that table has. */
export type RunRow = Record<string, unknown>;

/** Validate run ids look like UUIDs before hitting the DB, so typos fail fast. */
export function validateRunIds(ids: string[]): void {
  if (ids.length === 0) {
    throw new Error("Provide at least one run id.");
  }
  const bad = ids.filter((id) => !UUID_RE.test(id));
  if (bad.length > 0) {
    throw new Error(`Not a valid run id (expected a UUID): ${bad.join(", ")}`);
  }
}

/**
 * Fetch every column of `runs` for the given ids. Deliberately only queries
 * `runs` — never joins or follows into `buckets`/`metrics`/etc.
 */
export async function queryRuns(
  credentials: Pick<ResolvedResultsDbCredentials, "host" | "username" | "password">,
  ids: string[],
): Promise<RunRow[]> {
  validateRunIds(ids);
  const sql = postgres({
    host: credentials.host,
    port: RESULTS_DB_PORT,
    database: RESULTS_DB_NAME,
    username: credentials.username,
    password: credentials.password,
    max: 1,
  });
  try {
    const rows = await Promise.all(ids.map((id) => sql`SELECT * FROM runs WHERE id = ${id}::uuid`));
    return rows.flat();
  } finally {
    await sql.end();
  }
}

function helpText(): string {
  return `Fetch rows from the results database's "runs" table by id (runs only — not buckets).

Usage:
  bun run src/fit/shared/query-runs/query-runs.ts <run-id> [<run-id>...] [--env dev|prod]
  bun run src/fit/shared/query-runs/query-runs.ts --help

<run-id>  One or more run UUIDs.
--env     Results environment to query (from environments.json5's "results" block).
          Defaults to "${DEFAULT_RESULTS_ENV}".

Requires the vpn-public VPN to reach the database.`;
}

export function parseArgs(argv: string[]): { ids: string[]; env: string } {
  const ids: string[] = [];
  let env = DEFAULT_RESULTS_ENV;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--env") {
      env = argv[++i];
      if (!env) throw new Error("--env needs a value.");
    } else if (arg.startsWith("--env=")) {
      env = arg.slice("--env=".length);
    } else {
      ids.push(arg);
    }
  }
  return { ids, env };
}

export function runQueryRunsMain(): void {
  const argv = process.argv.slice(2);
  runCli(async () => {
    if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
      console.log(helpText());
      if (argv.length === 0) process.exit(2);
      return;
    }

    const { ids, env } = parseArgs(argv);
    validateRunIds(ids);
    const credentials = await resolveResultsDbCredentials({ block: env });
    console.log(`Querying "${env}" results database at ${credentials.host} for ${ids.length} run(s)...`);
    const rows = await queryRuns(credentials, ids);
    console.log(JSON.stringify(rows, null, 2));

    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      console.log(`\nNo row found for: ${missing.join(", ")}`);
    }
    return { artifacts: [], details: [{ label: "Runs found", value: `${rows.length}/${ids.length}` }] };
  });
}

if (isMain(import.meta.url)) {
  runQueryRunsMain();
}
