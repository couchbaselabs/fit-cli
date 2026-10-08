/**
 * The same test on other SDKs. The driver's tests are shared, so a test id means the same test
 * for every SDK: for each finding, this says how every other SDK with a report fared on that
 * exact test, of the same test type, in the same 30-day window - and what that suggests:
 *
 *   only-this-sdk     every other SDK that runs it passes it: likely this SDK
 *   every-sdk         every other SDK that runs it fails it too: likely the test, the driver,
 *                     or the server or environment
 *   family            the SDKs of this one's family (e.g. jvm, built on core-io) fail it and the
 *                     others pass: likely the shared core
 *   mixed             some fail and some pass, in no family pattern
 *   not-enough-data   no other SDK is known to run it
 *
 * Only what the reports say is used: a test another SDK didn't run is "not_run", never a pass,
 * and one its log-only nights can't vouch for is "unknown". Nights failing at the same time
 * are noted (`sameStart`) but not called a server issue: the server build isn't captured yet.
 */
import type { TestClass } from "./classify.js";
import type { TriageFinding, TriageReport } from "./triage.js";
import { daysBetween } from "./dates.js";

export type PeerStatus = "failing" | "intermittent" | "recovered" | "stopped" | "passing" | "not_run" | "unknown";
export type CrossCategory = "only-this-sdk" | "every-sdk" | "family" | "mixed" | "not-enough-data";

export interface CrossPeer {
  sdk: string;
  family?: string;
  status: PeerStatus;
  /** The peer's own classification of the test, when it failed there in the window. */
  class?: TestClass;
  since?: string;
  lastFail?: string;
  /** The peer started failing it within a day of this SDK. */
  sameStart?: boolean;
}

export interface CrossSdk {
  peers: CrossPeer[];
  category: CrossCategory;
  reason?: string;
}

/** What the page shows for one finding. */
export interface CrossSummary {
  category: CrossCategory;
  failingOn: string[];
  passingOn: string[];
}

const STATUS_OF: Record<TestClass, PeerStatus> = {
  always: "failing",
  failing: "failing",
  new: "failing",
  intermittent: "intermittent",
  recovered: "recovered",
  oneoff: "recovered",
  stopped: "stopped",
  dormant: "passing",
};
const SEVERITY: PeerStatus[] = ["failing", "intermittent", "stopped", "recovered"];
const FAILS = new Set<PeerStatus>(["failing", "intermittent"]);
const RAN = new Set<PeerStatus>(["failing", "intermittent", "recovered", "stopped", "passing"]);

const kindOf = (t: TriageReport, f: TriageFinding) => t.series.find((s) => s.id === f.series)?.kind ?? "functional";

const daysApart = (a: string, b: string) => Math.abs(daysBetween(a, b));

/** How `peer` fared on `test` (of `kind`), seen from a finding that started failing on `start`. */
export function peerStatus(peer: TriageReport, test: string, kind: "functional" | "situational", start: string | undefined, family?: string): CrossPeer {
  const theirs = peer.findings.filter((f) => f.test === test && kindOf(peer, f) === kind);
  const worst = theirs.sort((a, b) => SEVERITY.indexOf(STATUS_OF[a.classification.class]) - SEVERITY.indexOf(STATUS_OF[b.classification.class]))[0];
  const base = { sdk: peer.sdk, ...(family ? { family } : {}) };
  if (worst) {
    const c = worst.classification;
    const theirStart = worst.evidence.firstFailing?.date;
    return {
      ...base,
      status: STATUS_OF[c.class],
      class: c.class,
      ...(c.since ? { since: c.since } : {}),
      ...(c.lastFail ? { lastFail: c.lastFail } : {}),
      ...(start && theirStart ? { sameStart: daysApart(start, theirStart) <= 1 } : {}),
    };
  }
  const seen = peer.testsSeen[kind];
  if (seen.tests.includes(test)) return { ...base, status: "passing" };
  return { ...base, status: seen.complete ? "not_run" : "unknown" };
}

export function categoriseCross(peers: CrossPeer[], family: string | undefined): { category: CrossCategory; reason?: string } {
  const ran = peers.filter((p) => RAN.has(p.status));
  if (ran.length === 0) return { category: "not-enough-data", reason: "no other SDK is known to run this test" };
  const failing = ran.filter((p) => FAILS.has(p.status));
  const few = ran.length === 1 ? { reason: `only ${ran[0].sdk} also runs it` } : {};
  if (failing.length === ran.length) return { category: "every-sdk", ...few };
  if (failing.length === 0) return { category: "only-this-sdk", ...few };
  if (family) {
    const kin = ran.filter((p) => p.family === family);
    const others = ran.filter((p) => p.family !== family);
    if (kin.length > 0 && others.length > 0 && kin.every((p) => FAILS.has(p.status)) && others.every((p) => !FAILS.has(p.status))) {
      return { category: "family", reason: `the ${family} SDKs fail it; the others pass` };
    }
  }
  return { category: "mixed" };
}

/**
 * Fill in every finding's `crossSdk`, comparing each SDK's report with every other's.
 * `families` maps an SDK to its family, if it has one.
 */
export function crossCompare(reports: TriageReport[], families: Record<string, string | undefined>): void {
  for (const t of reports) {
    const peers = reports.filter((p) => p.sdk !== t.sdk);
    for (const f of t.findings) {
      const kind = kindOf(t, f);
      const list = peers.map((p) => peerStatus(p, f.test, kind, f.evidence.firstFailing?.date, families[p.sdk])).sort((a, b) => a.sdk.localeCompare(b.sdk));
      f.crossSdk = { peers: list, ...categoriseCross(list, families[t.sdk]) };
    }
  }
}

/** Per series, per test: what the page shows, from a compared triage report. */
export function summariseCross(t: TriageReport): Record<string, Record<string, CrossSummary>> {
  const out: Record<string, Record<string, CrossSummary>> = {};
  for (const f of t.findings) {
    if (!f.crossSdk) continue;
    (out[f.series] ??= {})[f.test] = {
      category: f.crossSdk.category,
      failingOn: f.crossSdk.peers.filter((p) => FAILS.has(p.status)).map((p) => p.sdk),
      passingOn: f.crossSdk.peers.filter((p) => p.status === "passing" || p.status === "recovered").map((p) => p.sdk),
    };
  }
  return out;
}
