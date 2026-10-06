/**
 * What changed around the night a test changed: the SDK's own code, and the FIT driver's
 * (transactions-fit-performer, which holds the tests). For each finding with a change point -
 * the last good night (or, for a test that only just started running, the night before) and the
 * first failing night - it lists the commits between them and says which is the likely cause:
 *
 *   SDK changed   driver changed the test's own file   likely
 *   no            yes                                  the test changed
 *   yes           no                                   the SDK
 *   yes           yes                                  both: look at both
 *   no            no                                   the environment, the server, or flakiness
 *
 * "SDK changed" is path-aware: in a repo holding several SDKs (couchbase-jvm-clients), a
 * commit counts only if it touches this SDK's own paths or its shared core (core-io). Shared
 * test-harness changes are shown but never decide. On the driver side only the test's own file
 * decides; other test code it touched (helpers, base classes) is shown separately.
 *
 * The driver commit a nightly used isn't logged: it is inferred as the newest commit on the
 * driver's default branch at the time the run cloned it, unless the run's preset pinned a
 * Gerrit patchset, which is then the driver exactly.
 *
 * Everything that talks to GitHub is behind `ChangeSource`; the rest is pure.
 */
import type { RunManifest } from "../record/run-manifest.js";
import type { HealthOptIn } from "../registry/health-opt-ins.js";
import type { DriverCheckout } from "../log-parse/parse-run-log.js";
import type { TriageFinding, TriageNight, TriageReport } from "./triage.js";
import { sdkByValue } from "../../../util/sdk/sdks.js";
import { ANALYTICS_TEST_DRIVER_MODULE, DEFAULT_TEST_DRIVER_MODULE } from "../../shared/run-test-driver/run-test-driver.js";

export const DRIVER_REPO = "couchbaselabs/transactions-fit-performer";

/**
 * The driver module holding an SDK's tests: the Columnar and Enterprise Analytics SDKs run
 * columnar-test-driver,
 * the rest test-driver - the choice fit-cli itself makes per run (run-test-driver.ts).
 */
export function driverModuleFor(sdk: string): string {
  const family = sdkByValue(sdk)?.family;
  return family === "columnar" || family === "enterprise-analytics" ? ANALYTICS_TEST_DRIVER_MODULE : DEFAULT_TEST_DRIVER_MODULE;
}
export const DRIVER_BRANCH = "master";

export interface Commit {
  sha: string;
  title: string;
}

export interface ChangeSource {
  /** Commits reachable from `head` but not `base`, oldest first. */
  compare(repo: string, base: string, head: string): Promise<Commit[]>;
  /** Files a commit touched, repo-relative. */
  files(repo: string, sha: string): Promise<string[]>;
  /** Commits on `branch` landed in [since, until], newest first, with when they landed. */
  history(repo: string, branch: string, since: string, until: string): Promise<{ sha: string; landedAt: string }[]>;
  /** Every file path on `branch`. */
  tree(repo: string, branch: string): Promise<string[]>;
}

export type ChangeCategory = "test-changed" | "sdk" | "both" | "neither" | "unknown";

export interface SdkChanges {
  from: string;
  to: string;
  /** This SDK's own code, or its shared core, changed between the two nights. */
  changed: boolean;
  compareUrl?: string;
  /** Commits touching this SDK's own paths (every commit, for a repo with one SDK). */
  commits: Commit[];
  /** Commits touching shared core code (core-io): a change to every SDK built on it. */
  sharedCoreCommits: Commit[];
  /** Commits touching shared test harness code only: shown, never counted as an SDK change. */
  sharedHarnessCommits: Commit[];
}

export interface DriverSide {
  date: string;
  /** The driver commit the night ran: exact for a pinned patchset, otherwise inferred. */
  sha?: string;
  gerritRef?: string;
  branch?: string;
  clonedAt?: string;
  inferred: boolean;
}

export interface DriverChanges {
  from: DriverSide;
  to: DriverSide;
  changed: boolean | null;
  compareUrl?: string;
  /** The test's own file(s) in the driver. */
  testFiles: string[];
  /** Commits that touched the test's own file: these decide the category. */
  testFileCommits: Commit[] | null;
  /** Commits that touched other test code (helpers, base classes): shown, never decide. */
  helperCommits: Commit[] | null;
  /** Why the commits couldn't be listed, when they couldn't. */
  note?: string;
}

export interface ChangeAnalysis {
  category: ChangeCategory;
  /** Why the category is "unknown", or what to bear in mind. */
  reason?: string;
  /** The two nights compared, and how many days apart they are (1 when nothing came between). */
  span?: { from: string; to: string; days: number };
}

/** Beyond this many days apart, a comparison takes in more than one night's changes and says so. */
export const WIDE_SPAN_DAYS = 2;

// ---------------------------------------------------------------------------------- pure

/** The newest commit that had landed by `at`; `history` is newest first. */
export function commitAt(history: { sha: string; landedAt: string }[], at: string): string | undefined {
  return history.find((c) => c.landedAt <= at)?.sha;
}

const under = (path: string, prefixes: readonly string[]) => prefixes.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));

/** Split a range's commits by which part of a multi-SDK repo they touch. */
export function splitSdkCommits(
  commits: { commit: Commit; files: string[] }[],
  optIn: Pick<HealthOptIn, "paths" | "sharedCorePaths" | "sharedHarnessPaths">,
): Pick<SdkChanges, "commits" | "sharedCoreCommits" | "sharedHarnessCommits"> {
  if (!optIn.paths) return { commits: commits.map((c) => c.commit), sharedCoreCommits: [], sharedHarnessCommits: [] };
  const own: Commit[] = [];
  const core: Commit[] = [];
  const harness: Commit[] = [];
  for (const { commit, files } of commits) {
    if (files.some((f) => under(f, optIn.paths!))) own.push(commit);
    else if (files.some((f) => under(f, optIn.sharedCorePaths ?? []))) core.push(commit);
    else if (files.some((f) => under(f, optIn.sharedHarnessPaths ?? []))) harness.push(commit);
  }
  return { commits: own, sharedCoreCommits: core, sharedHarnessCommits: harness };
}

const TEST_FILE = /(?:^|\/)[A-Za-z0-9_]+Tests?\.(?:java|scala|kt)$/;

/** The driver files that define test class `cls` (normally one). */
export function testFilesFor(cls: string, tree: readonly string[], module: string = DEFAULT_TEST_DRIVER_MODULE): string[] {
  // A package-qualified key ("kv/GetTest") matches by its package too; a nested class
  // (Outer$Inner) is in its outer class's file.
  const file = cls.replace(/\$.*$/, "");
  const names = ["java", "scala", "kt"].map((ext) => `/${file}.${ext}`);
  return tree.filter((p) => p.startsWith(`${module}/`) && names.some((n) => p.endsWith(n)));
}

/** Split a driver range's commits into those touching the test's own file and those touching other test code. */
export function splitDriverCommits(
  commits: { commit: Commit; files: string[] }[],
  testFiles: readonly string[],
  module: string = DEFAULT_TEST_DRIVER_MODULE,
): Pick<DriverChanges, "testFileCommits" | "helperCommits"> {
  const own: Commit[] = [];
  const helpers: Commit[] = [];
  for (const { commit, files } of commits) {
    if (files.some((f) => testFiles.includes(f))) own.push(commit);
    // Other code under the test driver that isn't itself a test: helpers, utils, base classes.
    else if (files.some((f) => f.startsWith(`${module}/`) && !TEST_FILE.test(f))) helpers.push(commit);
  }
  return { testFileCommits: own, helperCommits: helpers };
}

export function categorise(sdk: SdkChanges | undefined, driver: DriverChanges | undefined): ChangeAnalysis {
  if (!sdk) return { category: "unknown", reason: "the SDK commit of one of the nights isn't known" };
  if (!driver || driver.testFileCommits === null) {
    return { category: "unknown", reason: driver?.note ?? "the driver commits between the nights aren't known" };
  }
  const sdkChanged = sdk.changed;
  const testChanged = driver.testFileCommits.length > 0;
  if (sdkChanged && testChanged) return { category: "both" };
  if (testChanged) return { category: "test-changed" };
  if (sdkChanged) return { category: "sdk" };
  return { category: "neither", ...(driver.helperCommits?.length ? { reason: "the driver's shared test code changed, though not this test's file" } : {}) };
}

/** How a night got the driver: from its run's manifest, by the CI job that produced it. */
export function driverCheckout(night: TriageNight, manifests: ReadonlyMap<string, RunManifest>): DriverCheckout | undefined {
  const m = manifests.get(`${night.run.runId}-${night.run.attempt}`);
  if (!m?.driver) return undefined;
  return (night.run.job ? m.driver[night.run.job] : undefined) ?? Object.values(m.driver)[0];
}

/** What the page shows for one finding's change: short, and only what was found. */
export interface ChangeSummary {
  category: ChangeCategory;
  reason?: string;
  /** Driver commits that touched the test's own file. */
  testFileCommits: Commit[];
  /** How many other driver commits touched shared test code. */
  helperCommits: number;
  /** SDK commits touching this SDK's own code, and its shared core. */
  sdkCommits: number;
  sharedCoreCommits: number;
  sdkCompareUrl?: string;
  driverCompareUrl?: string;
  /** Set when the driver was a pinned Gerrit patchset on either night. */
  driverPin?: { from?: string; to?: string };
}

/** Per series, per test: the summaries for the page, from an analysed triage report. */
export function summariseChanges(triage: TriageReport): Record<string, Record<string, ChangeSummary>> {
  const out: Record<string, Record<string, ChangeSummary>> = {};
  for (const f of triage.findings) {
    if (!f.changeAnalysis) continue;
    const d = f.driverChanges;
    const s = f.evidence.sdkChange;
    (out[f.series] ??= {})[f.test] = {
      ...f.changeAnalysis,
      testFileCommits: d?.testFileCommits ?? [],
      helperCommits: d?.helperCommits?.length ?? 0,
      sdkCommits: s?.commits?.length ?? 0,
      sharedCoreCommits: s?.sharedCoreCommits?.length ?? 0,
      ...(s?.compareUrl ? { sdkCompareUrl: s.compareUrl } : {}),
      ...(d?.compareUrl ? { driverCompareUrl: d.compareUrl } : {}),
      ...(d && (d.from.gerritRef || d.to.gerritRef) ? { driverPin: { from: d.from.gerritRef, to: d.to.gerritRef } } : {}),
    };
  }
  return out;
}

// ------------------------------------------------------------------------------- analysis

/** The night a finding is compared against: its last good night, or the night before it started failing. */
function baseline(f: TriageFinding): TriageNight | undefined {
  return f.evidence.lastGood ?? f.evidence.previousNight;
}

const MEMO = <T>() => new Map<string, Promise<T>>();

/**
 * Fill in each finding's `sdkChange` commits, `driverChanges` and `changeAnalysis`. Never
 * throws: a finding whose changes can't be worked out says why and carries on.
 */
export async function analyseChanges(
  triage: TriageReport,
  ctx: { manifests: RunManifest[]; optIn: HealthOptIn; source: ChangeSource },
): Promise<{ analysed: number; failed: number }> {
  const manifests = new Map(ctx.manifests.map((m) => [`${m.runId}-${m.runAttempt}`, m]));
  const module = driverModuleFor(triage.sdk);
  const compares = MEMO<Commit[]>();
  const files = MEMO<string[]>();
  const compare = (repo: string, a: string, b: string) => {
    const k = `${repo} ${a} ${b}`;
    if (!compares.has(k)) compares.set(k, ctx.source.compare(repo, a, b));
    return compares.get(k)!;
  };
  const filesOf = (repo: string, sha: string) => {
    const k = `${repo} ${sha}`;
    if (!files.has(k)) files.set(k, ctx.source.files(repo, sha));
    return files.get(k)!;
  };
  const withFiles = (repo: string, commits: Commit[]) => Promise.all(commits.map(async (commit) => ({ commit, files: await filesOf(repo, commit.sha) })));

  // The driver's history over the window, to place each clone, and its tree, to find test files.
  let history: { sha: string; landedAt: string }[] | undefined;
  let tree: string[] | undefined;
  let driverProblem: string | undefined;
  try {
    const since = new Date(Date.parse(`${triage.window.start}T00:00:00Z`) - 7 * 86_400_000).toISOString();
    const until = new Date(Date.parse(`${triage.window.end}T00:00:00Z`) + 2 * 86_400_000).toISOString();
    [history, tree] = await Promise.all([ctx.source.history(DRIVER_REPO, DRIVER_BRANCH, since, until), ctx.source.tree(DRIVER_REPO, DRIVER_BRANCH)]);
  } catch (err) {
    driverProblem = `couldn't read ${DRIVER_REPO}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
  }

  const side = (night: TriageNight): DriverSide => {
    const c = driverCheckout(night, manifests);
    if (!c) return { date: night.date, inferred: false };
    if (c.gerritRef) return { date: night.date, gerritRef: c.gerritRef, clonedAt: c.clonedAt, inferred: false };
    if (c.branch) return { date: night.date, branch: c.branch, clonedAt: c.clonedAt, inferred: false };
    const sha = history ? commitAt(history, c.clonedAt) : undefined;
    return { date: night.date, clonedAt: c.clonedAt, inferred: true, ...(sha ? { sha } : {}) };
  };

  let analysed = 0;
  let failed = 0;
  for (const f of triage.findings) {
    const before = baseline(f);
    const after = f.evidence.firstFailing;
    if (!before || !after) continue;
    analysed++;
    try {
      // The SDK side: the commits between the two nights' builds, split by path.
      let sdk: SdkChanges | undefined;
      const repo = after.run.repo;
      if (before.sdkCommit && after.sdkCommit) {
        const range = before.sdkCommit === after.sdkCommit ? [] : await withFiles(repo, await compare(repo, before.sdkCommit, after.sdkCommit));
        const split = splitSdkCommits(range, ctx.optIn);
        sdk = {
          from: before.sdkCommit,
          to: after.sdkCommit,
          changed: split.commits.length + split.sharedCoreCommits.length > 0,
          ...(before.sdkCommit !== after.sdkCommit ? { compareUrl: `https://github.com/${repo}/compare/${before.sdkCommit}...${after.sdkCommit}` } : {}),
          ...split,
        };
        f.evidence.sdkChange = sdk;
      }

      // The driver side.
      const from = side(before);
      const to = side(after);
      const testFiles = tree ? testFilesFor(f.class, tree, module) : [];
      let driver: DriverChanges;
      if (from.branch || to.branch) {
        // A branch moves: the same name on both nights doesn't mean the same commit.
        driver = { from, to, changed: null, testFiles, testFileCommits: null, helperCommits: null, note: "the driver was cloned from a branch, whose commit on each night isn't known" };
      } else if (from.gerritRef || to.gerritRef) {
        // A Gerrit patchset is a fixed commit: the same one on both nights is the same driver.
        driver = from.gerritRef === to.gerritRef
          ? { from, to, changed: false, testFiles, testFileCommits: [], helperCommits: [] }
          : { from, to, changed: true, testFiles, testFileCommits: null, helperCommits: null, note: "the driver was pinned to a different Gerrit patchset; its files aren't compared" };
      } else if (!from.sha || !to.sha) {
        driver = { from, to, changed: null, testFiles, testFileCommits: null, helperCommits: null, note: driverProblem ?? "the driver commit of one of the nights isn't known (no clone line in its log)" };
      } else {
        const range = from.sha === to.sha ? [] : await withFiles(DRIVER_REPO, await compare(DRIVER_REPO, from.sha, to.sha));
        driver = {
          from,
          to,
          changed: range.length > 0,
          ...(from.sha !== to.sha ? { compareUrl: `https://github.com/${DRIVER_REPO}/compare/${from.sha}...${to.sha}` } : {}),
          testFiles,
          ...splitDriverCommits(range, testFiles, module),
          // Without the test's own file, whether it changed isn't known - not "it didn't".
          ...(testFiles.length === 0 ? { testFileCommits: null, note: `no file for ${f.class} found under ${module}/; only other test code is listed` } : {}),
        };
      }
      f.driverChanges = driver;
      const days = Math.round((Date.parse(`${after.date}T00:00:00Z`) - Date.parse(`${before.date}T00:00:00Z`)) / 86_400_000);
      const analysis = categorise(sdk, driver);
      const wide = days > WIDE_SPAN_DAYS ? `the two nights are ${days} days apart, so the commits cover more than one night` : undefined;
      f.changeAnalysis = {
        ...analysis,
        ...(wide ? { reason: analysis.reason ? `${analysis.reason}; ${wide}` : wide } : {}),
        span: { from: before.date, to: after.date, days },
      };
    } catch (err) {
      failed++;
      f.changeAnalysis = { category: "unknown", reason: `couldn't read the commits: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
    }
  }
  return { analysed, failed };
}
