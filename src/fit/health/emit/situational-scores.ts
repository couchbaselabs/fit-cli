/**
 * Situational scores: a situational test runs a workload through a change to the cluster
 * (a rebalance, a resize) and the test driver's Scorer grades the run from its per-second
 * results - below zero is a failure (errors, or too few successes, in a phase). The driver
 * never fails the JUnit test on its score, so a JUnit record alone calls such a run a pass.
 * fit-cli has failed the job on a negative score since 2026-09-30 (bb78cd3); this makes the
 * health records agree.
 *
 * Where the scores are: the run's archive holds, beside surefire-reports.tar.gz, the driver's
 * results as results.tar (results.tar.gz when fit-cli compressed a large one; archived since
 * 2026-09-09): one directory per scenario run, with run.json5 (its runUuid) and scores.json5
 * ({score, reasons}). The test that ran a scenario logs its runUuid, which junitOutcomes picks
 * out of the captured output (see StreamSectionStripper).
 */
import { parseRunJson5, parseScoresJson5 } from "../../ingest/parse.js";
import { forEachTarFile, type JunitOutcomes } from "./junit-outcomes.js";

export interface ScenarioScore {
  score: number;
  reasons: string[];
}

/** The archive member that holds a situational run's results, if it has one: beside its surefire tarball. */
export function resultsMember(names: string[], tarball: string): { member: string; gzip: boolean } | undefined {
  const dir = tarball.slice(0, tarball.lastIndexOf("/") + 1);
  for (const [file, gzip] of [["results.tar", false], ["results.tar.gz", true]] as const) {
    if (names.includes(dir + file)) return { member: dir + file, gzip };
  }
  return undefined;
}

/**
 * runUuid -> score, from a results.tar(.gz). A scenario with no score key wasn't scored and is
 * left out; one whose files can't be read is a warning, never a failed read.
 */
export async function scoresFromResultsTar(archive: Buffer, gzip: boolean): Promise<{ scores: Map<string, ScenarioScore>; warnings: string[] }> {
  const byDir = new Map<string, { run?: string; scores?: string }>();
  const file = /^(?:\.\/)?(.+)\/(run|scores)\.json5$/;
  await forEachTarFile(archive, { gzip }, (name) => file.test(name), async (name, data) => {
    const [, dir, kind] = file.exec(name)!;
    const parts: Buffer[] = [];
    for await (const chunk of data) parts.push(chunk);
    const entry = byDir.get(dir) ?? byDir.set(dir, {}).get(dir)!;
    entry[kind as "run" | "scores"] = Buffer.concat(parts).toString("utf8");
  });
  const scores = new Map<string, ScenarioScore>();
  const warnings: string[] = [];
  for (const [dir, f] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
    if (f.scores === undefined) continue;
    try {
      if (f.run === undefined) throw new Error("no run.json5");
      const { runUuid } = parseRunJson5(f.run);
      const s = parseScoresJson5(f.scores);
      if (typeof s.score !== "number") continue;
      scores.set(runUuid, { score: s.score, reasons: Array.isArray(s.reasons) ? s.reasons.map(String) : [] });
    } catch (err) {
      warnings.push(`situational results ${dir}: ${(err as Error).message}`);
    }
  }
  return { scores, warnings };
}

/**
 * Fail each test whose scenario scored below zero: it moves from passed (or skipped) to failed,
 * in `tests` and in the counts. A test that already failed or errored keeps that outcome. When
 * a test ran several scenarios, the lowest score is the one kept. Returns the failing scores by
 * test id, and a warning for each negative score no test claims.
 */
export function applyNegativeScores(junit: JunitOutcomes, scores: Map<string, ScenarioScore>): { failures: Record<string, ScenarioScore>; warnings: string[] } {
  const testOf = new Map<string, string>();
  for (const [test, uuids] of Object.entries(junit.runUuids)) for (const u of uuids) testOf.set(u, test);
  const failures: Record<string, ScenarioScore> = {};
  const warnings: string[] = [];
  for (const [uuid, s] of scores) {
    if (s.score >= 0) continue;
    const test = testOf.get(uuid);
    if (!test) {
      warnings.push(`situational run ${uuid} scored ${s.score}, but no test names it`);
      continue;
    }
    if (!failures[test] || s.score < failures[test].score) failures[test] = s;
  }
  for (const test of Object.keys(failures)) {
    const dot = test.indexOf(".");
    const o = junit.tests[test.slice(0, dot)];
    const method = test.slice(dot + 1);
    if (!o) continue;
    for (const [from, count] of [["p", "passed"], ["s", "skipped"]] as const) {
      const i = o[from]?.indexOf(method) ?? -1;
      if (i < 0) continue;
      o[from]!.splice(i, 1);
      if (!o[from]!.length) delete o[from];
      (o.f ??= []).push(method);
      junit.counts[count]--;
      junit.counts.failed++;
    }
  }
  return { failures, warnings };
}
