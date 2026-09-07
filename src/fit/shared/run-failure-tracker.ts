import type { FailureClassification, FailureFacts } from "./failure-classification.js";
import type { RecordedFailure } from "../../util/non-fit/artifacts.js";

const SEVERITY: Record<FailureClassification, number> = {
  NonFatal: 0,
  FatalToRun: 1,
  FatalToSession: 2,
  FatalToCluster: 3,
  FatalToInstance: 4,
  FatalToAll: 5,
};

/**
 * Where a failure happened, in the vocabulary of a definition file: an instance
 * holds clusters, a cluster holds sessions, and a session holds runs.
 * `clusterless` sessions (situational runs) aren't tied to a cluster, so they
 * carry a session but no cluster. All but `instanceIndex` are optional — a
 * failure raised before any run started (e.g. a precondition check) only knows
 * the instance, if that.
 *
 * `label` is the standardised human-friendly position (e.g.
 * `aws1 / 7.6-stable / java:main / func`, the same form built by `formatRunLabel`
 * and shown in log prefixes/headers) when the caller knew the run's inputs at
 * failure time; the summary prefers it over the bare `instance N, cluster N`
 * index form built from the indexes above.
 */
export interface FailureContext {
  instanceIndex: number;
  clusterIndex?: number;
  sessionIndex?: number;
  runIndex?: number;
  clusterless?: boolean;
  label?: string;
}

/**
 * Should `candidate` replace `current` as the run's worst failure? Severity decides it
 * normally. On a tie, a failure the test-results table doesn't already explain wins:
 * it's the one whose log tail the CI summary needs to show, and equal severity gives us
 * no other reason to prefer either.
 */
function beatsWorst(candidate: RecordedFailure, current: RecordedFailure): boolean {
  const candidateSeverity = SEVERITY[candidate.classification as FailureClassification];
  const currentSeverity = SEVERITY[current.classification as FailureClassification];
  if (candidateSeverity !== currentSeverity) return candidateSeverity > currentSeverity;
  return current.explainedByTestResults === true && candidate.explainedByTestResults !== true;
}

export class RunFailureTracker {
  private worstFailure?: RecordedFailure;
  private count = 0;

  record(classification: FailureClassification, message: string, context: FailureContext, facts: FailureFacts = {}): void {
    this.count++;
    const candidate: RecordedFailure = {
      classification,
      message,
      context,
      ...(facts.explainedByTestResults ? { explainedByTestResults: true } : {}),
    };
    if (!this.worstFailure || beatsWorst(candidate, this.worstFailure)) {
      this.worstFailure = candidate;
    }
  }

  get worst(): RecordedFailure | undefined {
    return this.worstFailure;
  }

  get failureCount(): number {
    return this.count;
  }

  shouldExitNonZero(): boolean {
    return (
      !!this.worstFailure && SEVERITY[this.worstFailure.classification as FailureClassification] >= SEVERITY.FatalToRun
    );
  }
}
