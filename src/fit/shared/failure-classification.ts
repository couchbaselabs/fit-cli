/**
 * How a failing process (non-zero exit) affects the current definition run. The
 * names mirror the definition-file hierarchy: an instance holds clusters, a
 * cluster holds sessions, and a session holds runs.
 *
 * FatalToAll      – stops the entire definition run immediately.
 * FatalToInstance – this instance cannot continue (e.g. the box couldn't be
 *                   acquired or set up), but the next instance is allowed to run.
 * FatalToCluster  – this cluster cannot continue (e.g. cluster setup failed), but
 *                   the next cluster on the instance is allowed to run.
 * FatalToSession  – only this session is abandoned; the next session in the same
 *                   cluster is allowed to run.
 * FatalToRun      – only this run is abandoned (e.g. a failing test, or no JUnit
 *                   report produced); the next run in the same session may run.
 * NonFatal        – the failure is recorded but the current run continues.
 */
export type FailureClassification =
  | "FatalToAll"
  | "FatalToInstance"
  | "FatalToCluster"
  | "FatalToSession"
  | "FatalToRun"
  | "NonFatal";

/**
 * Extra facts about a failure that only the code raising it knows.
 *
 * `explainedByTestResults` marks a failure the run's test-results table already
 * spells out: the test-driver ran to completion and surefire reported failing tests.
 * Such a failure needs no hoisted snippet at the top of the CI summary — the table
 * says it better, and by then the log tail is teardown chatter rather than a cause.
 * See `appendFailureSnippetToGhaSummary`.
 */
export interface FailureFacts {
  explainedByTestResults?: boolean;
}

/** A process failure tagged with how the run should react to it. */
export class ClassifiedFailure extends Error {
  readonly explainedByTestResults: boolean;

  constructor(
    message: string,
    public readonly classification: FailureClassification,
    facts: FailureFacts = {},
  ) {
    super(message);
    this.name = "ClassifiedFailure";
    this.explainedByTestResults = facts.explainedByTestResults ?? false;
  }
}

export function throwFatalToAll(message: string): never {
  throw new ClassifiedFailure(message, "FatalToAll");
}

export function throwFatalToInstance(message: string): never {
  throw new ClassifiedFailure(message, "FatalToInstance");
}

export function throwFatalToCluster(message: string): never {
  throw new ClassifiedFailure(message, "FatalToCluster");
}

export function throwFatalToSession(message: string, facts: FailureFacts = {}): never {
  throw new ClassifiedFailure(message, "FatalToSession", facts);
}

export function throwFatalToRun(message: string): never {
  throw new ClassifiedFailure(message, "FatalToRun");
}
