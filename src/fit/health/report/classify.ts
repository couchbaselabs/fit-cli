/**
 * The one place a test's night-by-night history becomes a class.
 *
 * The unit is an EPISODE: an unbroken run of failing nights. What separates "it broke" from
 * "it's flaky" is not how often a test failed but in how many separate runs:
 *   passing, then failing the last 4 nights   = one current episode  -> failing
 *   failed 10 times in a month, on and off    = many short episodes  -> intermittent
 *
 * Judged over the last WINDOW_DAYS calendar days up to the report's end date - calendar, not
 * "the series' last 30 runs", so a preset that stopped running is judged on what it did
 * recently (nothing), not on stale history. Unknown nights (bulk-errored, no results) and
 * nights the test didn't run (skipped, or missing from the results) are skipped, never
 * counted as a pass - except that a test that has stopped running altogether is classed as
 * such, not judged on the failures it had before it stopped.
 */
import { addDays } from "./dates.js";

export const WINDOW_DAYS = 30;
/** Consecutive failures that make a clean test "failing". */
export const FAIL_STREAK = 3;
/** ...if it passed at least this share of the window before the streak. */
export const PRIOR_CLEAN = 0.9;
/** A week straight is "failing" however flaky it was before. */
export const LONG_STREAK = 7;
/** Clean nights after an episode before calling it recovered. */
export const RECOVER_CLEAN = 3;
/** Fewer nights than this is too little to say "always". */
export const ALWAYS_MIN_RUNS = 10;
/** Nights in a row a test must not have run, at the end, to have "stopped running". */
export const STOPPED_RUNNING_NIGHTS = 3;

export const CLASS_ORDER = ["always", "failing", "new", "intermittent", "recovered", "oneoff", "stopped", "dormant"] as const;
export type TestClass = (typeof CLASS_ORDER)[number];

export const CLASS_LABELS: Record<TestClass, string> = {
  always: "Always fails",
  failing: "Failing since",
  new: "New · watch",
  intermittent: "Intermittent",
  recovered: "Recovered",
  oneoff: "One-off",
  stopped: "Stopped running",
  dormant: "Dormant",
};

export const CLASS_BLURBS: Record<TestClass, string> = {
  always: `Failed on every night it ran in the last ${WINDOW_DAYS} days. A pass would be the anomaly.`,
  failing: `Currently failing ${FAIL_STREAK}+ nights in a row after passing before (or ${LONG_STREAK}+ in a row, whatever came before). The date is when it turned.`,
  new: "Failing the last 1-2 nights after a clean window. Too early to call.",
  intermittent: `Two or more separate failure runs in the last ${WINDOW_DAYS} days: it flips.`,
  recovered: `One failure run of ${FAIL_STREAK}+ nights, then at least ${RECOVER_CLEAN} clean.`,
  oneoff: `Failed on only one or two consecutive nights in the last ${WINDOW_DAYS} days, now passing.`,
  stopped: `Failed in the last ${WINDOW_DAYS} days, then didn't run on its last ${STOPPED_RUNNING_NIGHTS}+ nights (skipped, or no longer in the results).`,
  dormant: `No failure in the last ${WINDOW_DAYS} days (or no runs at all).`,
};

/**
 * A night's outcome for one test: passed, failed, errored, unknown (the night can't say: the
 * suite errored in bulk, or the CI log hid this package's failures), or not run (skipped, or
 * missing from full JUnit results). Errored counts as a failure everywhere; it is kept apart
 * only so the report can say which.
 */
export type NightOutcome = "p" | "f" | "e" | "u" | "n";

/** Failed or errored. */
export const isFailure = (x: string): boolean => x === "f" || x === "e";
/** The test ran and the night can say how it did. */
export const isKnown = (x: string): boolean => x === "p" || x === "f" || x === "e";

export interface Classification {
  cls: TestClass;
  /** For "failing": the night the current failure run began. */
  since?: string;
  /** Consecutive failing nights up to the end of the window. */
  streak: number;
  /** Separate failure runs in the window. */
  episodes: number;
  windowFails: number;
  windowRuns: number;
  lastFail?: string;
  /** Consecutive passing nights up to the end of the window. */
  cleanTail: number;
  /** Failures older than the window, shown on the calm classes so old flakiness isn't hidden. */
  flakyBefore: number;
  /** The last night it ran (passed or failed), and the last night it passed. */
  lastRan?: string;
  lastPass?: string;
  /** For "stopped": how it did the last night it ran, and the first night it didn't. */
  lastResult?: "p" | "f" | "e";
  notRunSince?: string;
  /**
   * The most recent unbroken run of failures anywhere in the history, not just the window:
   * its first and last failing night and how many nights failed. Unknown and not-run nights
   * neither break it nor count.
   */
  lastEpisode?: { from: string; to: string; nights: number };
  /** The last passing night before `lastEpisode`. */
  lastGood?: string;
  /** With no `lastGood` (the test only just started running): the night before `lastEpisode`. */
  previousNight?: string;
}

/** `lastEpisode`, `lastGood` and `previousNight` (see Classification), in one walk back from the end. */
export function lastEpisode(dates: readonly string[], seq: readonly NightOutcome[]): Pick<Classification, "lastEpisode" | "lastGood" | "previousNight"> {
  let last = seq.length - 1;
  while (last >= 0 && !isFailure(seq[last])) last--;
  if (last < 0) return {};
  let first = last;
  let nights = 0;
  let i = last;
  for (; i >= 0 && seq[i] !== "p"; i--) {
    if (isFailure(seq[i])) {
      first = i;
      nights++;
    }
  }
  return {
    lastEpisode: { from: dates[first], to: dates[last], nights },
    ...(i >= 0 ? { lastGood: dates[i] } : first > 0 ? { previousNight: dates[first - 1] } : {}),
  };
}

/** Lengths of the unbroken fail runs in a pass/fail sequence, oldest first. */
export function episodes(seq: readonly ("p" | "f")[]): number[] {
  const out: number[] = [];
  let run = 0;
  for (const x of seq) {
    if (x === "f") run++;
    else if (run) {
      out.push(run);
      run = 0;
    }
  }
  if (run) out.push(run);
  return out;
}

/**
 * Classify one test. `dates` and `seq` are aligned, oldest first; `end` is the report's last
 * date, and the window is the WINDOW_DAYS days ending there.
 */
export function classify(dates: readonly string[], seq: readonly NightOutcome[], end: string): Classification {
  const start = addDays(end, -(WINDOW_DAYS - 1));
  const known: [string, "p" | "f"][] = [];
  dates.forEach((d, i) => {
    const x = seq[i];
    if (isKnown(x)) known.push([d, isFailure(x) ? "f" : "p"]);
  });
  // Stopped running: the last STOPPED_RUNNING_NIGHTS nights it could have run (unknown nights
  // aside), it didn't.
  const decided = dates.map((d, i) => [d, seq[i]] as const).filter(([, x]) => x !== "u");
  let notRun = 0;
  while (notRun < decided.length && decided[decided.length - 1 - notRun][1] === "n") notRun++;
  const lastRun = decided[decided.length - 1 - notRun];
  const w = known.filter(([d]) => d >= start);
  const before = known.filter(([d]) => d < start).map(([, x]) => x);
  const ws = w.map(([, x]) => x);

  let streak = 0;
  for (let i = ws.length - 1; i >= 0 && ws[i] === "f"; i--) streak++;
  const prior = ws.slice(0, ws.length - streak);
  const priorClean = prior.length ? prior.filter((x) => x === "p").length / prior.length : undefined;
  const eps = episodes(ws);
  let since = streak ? w[w.length - streak][0] : undefined;
  const lastFailIndex = ws.lastIndexOf("f");

  let cls: TestClass;
  if (!ws.includes("f")) {
    cls = "dormant";
  } else if (notRun >= STOPPED_RUNNING_NIGHTS && lastRun) {
    cls = "stopped";
    since = undefined;
  } else if (!ws.includes("p")) {
    cls = ws.length >= ALWAYS_MIN_RUNS ? "always" : "failing";
  } else if (streak >= LONG_STREAK || (streak >= FAIL_STREAK && priorClean !== undefined && priorClean >= PRIOR_CLEAN)) {
    cls = "failing";
  } else if (streak && !prior.includes("f")) {
    cls = "new"; // 1-2 nights, clean window before
  } else if (streak) {
    cls = "intermittent"; // a current fail on a test that already flipped
  } else if (eps.length >= 2) {
    cls = "intermittent";
  } else {
    // Exactly one episode, now passing. Only a couple of clean nights after a long run
    // isn't a recovery yet.
    const tail = ws.length - 1 - lastFailIndex;
    if (eps[0] >= FAIL_STREAK) {
      cls = tail >= RECOVER_CLEAN ? "recovered" : "failing";
      if (cls === "failing") since = w[lastFailIndex - eps[0] + 1][0];
    } else {
      cls = "oneoff";
    }
  }

  let cleanTail = 0;
  for (let i = ws.length - 1; i >= 0 && ws[i] === "p"; i--) cleanTail++;
  const fails = known.filter(([, x]) => x === "f");
  const calm = cls === "new" || cls === "oneoff" || cls === "recovered" || cls === "dormant";
  const stopped = cls === "stopped" && lastRun
    ? { lastResult: lastRun[1] as "p" | "f" | "e", notRunSince: decided[decided.length - notRun][0] }
    : {};
  const lastPass = known.filter(([, x]) => x === "p").at(-1)?.[0];
  return {
    cls,
    since,
    streak,
    episodes: eps.length,
    windowFails: ws.filter((x) => x === "f").length,
    windowRuns: ws.length,
    lastFail: fails.at(-1)?.[0],
    cleanTail,
    flakyBefore: calm ? before.filter((x) => x === "f").length : 0,
    ...(lastRun ? { lastRan: lastRun[0] } : {}),
    ...(lastPass ? { lastPass } : {}),
    ...stopped,
    ...lastEpisode(dates, seq),
  };
}
