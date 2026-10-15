/**
 * Fetch a whole run's log, job by job, in the shape `gh run view --log` prints it:
 * `<job name>\t<step>\t<line>`. The parser reads only the job name and the line.
 *
 * Not `gh run view --log` itself: it reads each job's log with a line scanner that stops,
 * silently, at the first line longer than 64 KB, and drops the rest of that job. A FIT run
 * prints the SDK's serialized exceptions, which reach 100 KB (couchbase-python-client,
 * couchnode and couchbase-cxx-client on-prem jobs), so the end of the job - its results table
 * and the "Uploaded run artifacts to s3://..." line that leads to the full JUnit - was lost.
 * GitHub's per-job log endpoint returns the whole text: about 8s for a run's six jobs, against
 * about 5s for `gh run view --log`.
 */
import { readFileSync, rmSync } from "node:fs";
import { capture, streamToFile } from "../../../util/non-fit/proc.js";

/** The step column: like gh's, for a job whose step logs GitHub doesn't break out. */
const STEP = "UNKNOWN STEP";

export interface RunJob {
  id: number;
  name: string;
  conclusion: string | null;
}

/** One job's log text, as `gh run view --log` lines. */
export function prefixJobLog(name: string, text: string): string {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.map((l) => `${name}\t${STEP}\t${l}`).join("\n");
}

/**
 * The `gh api` arguments for one job's log. Since gh 2.97.0, `gh api` refuses a non-JSON
 * response that contains terminal escape sequences, even into a pipe or a file, unless given
 * --allow-escape-sequences - and a FIT job log is full of colour codes. An older gh doesn't
 * know the flag and rejects it, so it is passed only when this gh's help lists it.
 */
export function jobLogArgs(repo: string, jobId: number, allowEscapes: boolean): string[] {
  return ["api", ...(allowEscapes ? ["--allow-escape-sequences"] : []), `repos/${repo}/actions/jobs/${jobId}/logs`];
}

let allowEscapesProbe: Promise<boolean> | undefined;
/** Whether this gh has --allow-escape-sequences on `gh api` (asked once per process). */
function ghAllowsEscapes(): Promise<boolean> {
  return (allowEscapesProbe ??= capture("gh", ["api", "--help"], process.cwd(), { quiet: true }).then(
    (help) => help.includes("--allow-escape-sequences"),
    () => false,
  ));
}

/** A job GitHub never ran has no log to fetch. */
export const hasLog = (job: RunJob) => job.conclusion !== "skipped";

export async function listRunJobs(repo: string, runId: number, attempt: number): Promise<RunJob[]> {
  const out = await capture("gh", [
    "api",
    "--paginate",
    `repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
    "--jq",
    ".jobs[] | [.id, .name, (.conclusion // \"\")] | @tsv",
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [id, name, conclusion] = l.split("\t");
      return { id: Number(id), name, conclusion: conclusion || null };
    });
}

/**
 * Every job's log for one run attempt, joined in job order. Throws when a job's log can't be
 * fetched, with gh's own message (which says 410 Gone once GitHub has deleted the logs), so the
 * caller records the run as a fetch failure, as it did for `gh run view --log`.
 */
export async function fetchRunLog(repo: string, runId: number, attempt: number, scratch: string): Promise<string> {
  const jobs = (await listRunJobs(repo, runId, attempt)).filter(hasLog);
  const parts: string[] = [];
  const allowEscapes = await ghAllowsEscapes();
  for (const job of jobs) {
    rmSync(scratch, { force: true });
    try {
      await streamToFile("gh", jobLogArgs(repo, job.id, allowEscapes), scratch, process.cwd(), { quiet: true });
    } catch (err) {
      // streamToFile's error only carries the exit code; gh's own message is in the file.
      const ghSaid = readScratch(scratch).filter((l) => l.trim()).join(" ").trim().slice(0, 500);
      // A job cancelled before it started has no log; the run's other jobs still do.
      if (job.conclusion === "cancelled" && /\b404\b|Not Found/.test(ghSaid)) continue;
      throw new Error([`job ${job.name}: ${err instanceof Error ? err.message : String(err)}`, ghSaid].filter(Boolean).join(": "), { cause: err });
    }
    parts.push(prefixJobLog(job.name, readScratch(scratch).join("\n")));
  }
  rmSync(scratch, { force: true });
  return parts.join("\n") + "\n";
}

/** The file's lines, without the "# <time> <command>" line streamToFile writes first. */
function readScratch(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  if (lines[0]?.startsWith("# ")) lines.shift();
  return lines;
}
