/**
 * Workflow: list FIT test-driver test files and let the user run all of them
 * (the default) or a checked subset.
 *
 * Shared by every FIT flavour; callers pass a FitTestDomain to pick which slice
 * of the test-driver's tests they care about (functional vs situational, …).
 *
 * Run on its own (add --root <dir> to point elsewhere):
 *   bun src/fit/shared/select-fit-tests/select-fit-tests.ts
 */
import { basename } from "node:path";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { checkbox, qualifyPromptId, search, select } from "../../../util/non-fit/prompts.js";
import { createLocalFitExecutionContext, type FitExecutionContext } from "../util/remote-fit-run.js";
import { readFitTestPaths, toClassName } from "./fit-tests-cache.js";

export interface FitTestCase {
  /** Basename shown in the picker, e.g. StandardTest.java. */
  fileName: string;
  /** Relative path under test-driver/src/test, for disambiguation. */
  relativePath: string;
  /** Surefire selector for the test class. */
  className: string;
}

export interface FitTestSelection {
  /** All discovered FIT test-driver tests. */
  allTests: FitTestCase[];
  /** The tests the user chose to run. */
  selectedTests: FitTestCase[];
  /** `undefined` means "run all tests" (or defer to `presets` at runtime). */
  mavenTestSelector?: string;
  /**
   * When set, the selection includes named presets whose expansion is deferred
   * to run time (they need the listed tests on the box). The runner expands each
   * against the discovered tests and unions the result with {@link extraClasses}.
   */
  presets?: DeferredTestPreset[];
  /** Explicit class names to union in after `presets` expand (deferred path only). */
  extraClasses?: string[];
  /** Package names chosen via the "Run tests in a package" picker; serialised as `packages:` in definition files. */
  selectedPackages?: string[];
}

/** Presets whose expansion depends on the listed tests, so it's deferred to run time. */
export type DeferredTestPreset = "all-transactions" | "all-non-transactions" | "standard-qe";

export interface FitTestSelectionSummary {
  /** How many FIT test-driver tests were discovered. */
  totalTests: number;
  /** Whether the user kept the default "run all tests" selection. */
  selectionMode: "all" | "subset";
  /** How many tests will actually run. */
  selectedCount: number;
  /** A short preview of the selected test classes. */
  selectedClassPreview: string[];
  /** How many selected tests are omitted from the preview. */
  selectedClassPreviewOmitted: number;
  /** Surefire selector passed to Maven for subset runs. */
  mavenTestSelector?: string;
}

interface PromptChoiceLike {
  short?: string;
}

const ALL_FIT_TESTS_SELECTED = "All FIT tests selected";

/** Relative-path prefix (under test-driver/src/test) the situational tests live at. */
export const SITUATIONAL_TEST_PATH_PREFIX = "scala/com/couchbase/situational/";

/** Relative-path prefix (under test-driver/src/test) the transactions tests live at. */
export const TRANSACTIONS_TEST_PATH_PREFIX = "java/com/couchbase/transactions/";

/** Returns true if the test belongs to the transactions package. */
export function isTransactionsTest(test: FitTestCase): boolean {
  return test.relativePath.startsWith(TRANSACTIONS_TEST_PATH_PREFIX);
}

/**
 * Which slice of the test-driver's tests a flow cares about, and which test it
 * runs in "sanity" mode. Functional and situational tests share one test-driver
 * but live in different packages, so each flow filters the discovered list to
 * its own and offers its own quick sanity test.
 */
export interface FitTestDomain {
  /** Keep only tests whose relativePath starts with this prefix, if set. */
  includePrefix?: string;
  /** Drop tests whose relativePath starts with this prefix, if set. */
  excludePrefix?: string;
  /** Maven `-Dtest` selector (a class, or Class#method) used by the sanity run mode. */
  sanitySelector: string;
  /** Whether to offer "All transactions tests" / "All non-transactions tests" options. */
  showTransactionOptions?: boolean;
  /** Whether to offer the Standard QE Set preset (CbDinoRebalanceTest, non-PL). */
  showStandardQePreset?: boolean;
}

/** The functional flow: everything except the situational package. */
export const FUNCTIONAL_TEST_DOMAIN: FitTestDomain = {
  excludePrefix: SITUATIONAL_TEST_PATH_PREFIX,
  sanitySelector: "com.couchbase.client.kv.SanityTest",
  showTransactionOptions: true,
};

/** The situational flow: only the situational package and its cbdino sanity test. */
export const SITUATIONAL_TEST_DOMAIN: FitTestDomain = {
  includePrefix: SITUATIONAL_TEST_PATH_PREFIX,
  sanitySelector: "com.couchbase.situational.tests.SanityTest",
  showStandardQePreset: true,
};

/** Fully-qualified class name for the Standard QE Set's rebalance test. */
export const STANDARD_QE_REBALANCE_CLASS = "com.couchbase.situational.tests.cbdino_tests.CbDinoRebalanceTest";

/**
 * CNG counterpart of {@link STANDARD_QE_REBALANCE_CLASS} — `CbDinoRebalanceTest`
 * is `@Tag("cbDino")`, which a situational CNG run's Maven groups filter
 * excludes, so it would silently select zero tests. `CngTest` is the
 * `@Tag("openshift")` class with the equivalent rebalance coverage.
 */
export const STANDARD_QE_CNG_REBALANCE_CLASS = "com.couchbase.situational.tests.CngTest";

/**
 * Load all FIT test-driver test paths from the committed cache file and apply
 * domain filtering. To regenerate the cache file, run:
 *   bunx tsx src/fit/shared/select-fit-tests/generate-fit-tests-cache.ts --root /path/to/transactions-fit-performer
 */
export function loadFitTestsFromCache(domain: FitTestDomain = FUNCTIONAL_TEST_DOMAIN): FitTestCase[] {
  return parseFitTests(readFitTestPaths().join("\n"), domain);
}

/** Keep only the test paths the domain cares about (include/exclude prefixes). */
function matchesDomain(relativePath: string, domain: FitTestDomain): boolean {
  if (domain.includePrefix && !relativePath.startsWith(domain.includePrefix)) {
    return false;
  }
  if (domain.excludePrefix && relativePath.startsWith(domain.excludePrefix)) {
    return false;
  }
  return true;
}

/** Parse the `find` output produced by {@link listFitTests}. */
export function parseFitTests(output: string, domain: FitTestDomain = FUNCTIONAL_TEST_DOMAIN): FitTestCase[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((relativePath) => matchesDomain(relativePath, domain))
    .map((relativePath) => ({
      relativePath,
      fileName: basename(relativePath),
      className: toClassName(relativePath),
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

/** List test-driver tests from the committed cache (see fit-tests-cache.json5). */
export function listFitTests(_execution: FitExecutionContext, domain: FitTestDomain = FUNCTIONAL_TEST_DOMAIN): FitTestCase[] {
  return loadFitTestsFromCache(domain);
}

/** Convert the chosen tests into the data needed by the next workflow. */
export function buildFitTestSelection(
  allTests: FitTestCase[],
  selectedClassNames: readonly string[],
): FitTestSelection {
  const selectedTests = allTests.filter((test) => selectedClassNames.includes(test.className));
  return {
    allTests,
    selectedTests,
    mavenTestSelector:
      selectedTests.length === allTests.length
        ? undefined
        : selectedTests.map((test) => test.className).join(","),
  };
}

/** Fall back to Maven's default behavior of running all tests. */
export function buildDefaultFitTestSelection(): FitTestSelection {
  return {
    allTests: [],
    selectedTests: [],
    mavenTestSelector: undefined,
  };
}

/**
 * Build a selection from explicit fully-qualified class names, without
 * discovering the test files first. Used to drive a run from a definition file,
 * where the tests are named up front rather than picked interactively. Only the
 * `mavenTestSelector` reaches Maven; the test-case fields are reconstructed from
 * each class name so the selection stays self-describing.
 */
export function buildFitTestSelectionFromClassNames(classNames: readonly string[]): FitTestSelection {
  const tests: FitTestCase[] = classNames.map((className) => ({
    className,
    fileName: className.split(".").pop() ?? className,
    relativePath: className,
  }));
  return {
    allTests: tests,
    selectedTests: tests,
    mavenTestSelector: classNames.join(","),
  };
}

/** Build a concise CLI-friendly summary instead of dumping every discovered test. */
export function summarizeFitTestSelection(
  selection: FitTestSelection,
  previewLimit = 10,
): FitTestSelectionSummary {
  const selectedClassPreview = selection.selectedTests
    .slice(0, previewLimit)
    .map((test) => test.className);

  return {
    totalTests: selection.allTests.length,
    selectionMode: selection.mavenTestSelector ? "subset" : "all",
    selectedCount: selection.selectedTests.length,
    selectedClassPreview,
    selectedClassPreviewOmitted: Math.max(selection.selectedTests.length - selectedClassPreview.length, 0),
    mavenTestSelector: selection.mavenTestSelector,
  };
}

/** Format standalone CLI output for the selected FIT tests. */
export function formatFitTestSelectionOutput(selection: FitTestSelection): string {
  if (selection.mavenTestSelector === undefined) {
    return ALL_FIT_TESTS_SELECTED;
  }

  return JSON.stringify(summarizeFitTestSelection(selection), null, 2);
}

/** Keep the checkbox confirmation short when the user leaves every test selected. */
export function renderSelectedFitTestsAnswer(
  selectedChoices: readonly PromptChoiceLike[],
  allChoices: readonly PromptChoiceLike[],
): string {
  if (selectedChoices.length === allChoices.length) {
    return ALL_FIT_TESTS_SELECTED;
  }

  return selectedChoices.map((choice) => choice.short ?? "").join(", ");
}

/** Keep replay logs compact when the user leaves every FIT test selected. */
export function serializeSelectedFitTestsForReplay(
  selectedClassNames: readonly string[],
  allTests: readonly FitTestCase[],
): unknown {
  if (selectedClassNames.length === allTests.length) {
    return ALL_FIT_TESTS_SELECTED;
  }

  return [...selectedClassNames];
}

/** Show relative test paths in the picker while keeping answer chips concise. */
export function buildFitTestChoices(tests: readonly FitTestCase[]) {
  return tests.map((test) => ({
    name: test.relativePath,
    short: test.fileName,
    value: test.className,
    checked: true,
  }));
}

/** Filter tests for the single-test search box by file name, path, or class name. */
export function filterFitTests(tests: readonly FitTestCase[], term: string | undefined): FitTestCase[] {
  const needle = (term ?? "").trim().toLowerCase();
  if (needle.length === 0) {
    return [...tests];
  }
  return tests.filter(
    (test) =>
      test.fileName.toLowerCase().includes(needle) ||
      test.relativePath.toLowerCase().includes(needle) ||
      test.className.toLowerCase().includes(needle),
  );
}

/** Build a `source` callback for the single-test {@link search} prompt. */
export function fitTestSearchSource(tests: readonly FitTestCase[]) {
  return (term: string | undefined) => {
    const results = filterFitTests(tests, term).map((test) => ({
      name: test.relativePath,
      short: test.fileName,
      value: test.className,
    }));

    const needle = (term ?? "").trim();
    if (needle.length > 0 && results.length === 0) {
      // The typed term may be a `java|scala/...` relative path (copy-pasted from
      // elsewhere) rather than a dotted FQCN - normalize it so Maven can select it.
      const className = toClassName(needle);
      return [{ name: `Use "${needle}" directly (not found in discovered tests)`, short: needle, value: className }];
    }

    return results;
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Expand compact replay log values back into a concrete FIT test selection. */
export function deserializeSelectedFitTestsFromReplay(
  response: unknown,
  allTests: readonly FitTestCase[],
): string[] {
  if (response === ALL_FIT_TESTS_SELECTED) {
    return allTests.map((test) => test.className);
  }

  if (!isStringArray(response)) {
    throw new Error("Invalid replayed FIT test selection.");
  }

  return response;
}

type FitTestRunMode = "all" | "all-transactions" | "all-non-transactions" | "standard-qe" | "single" | "multiple" | "package" | "sanity";

/** Ask whether to run everything, a single searchable test, a sanity test, or a chosen subset. */
async function askFitTestRunMode(domain: FitTestDomain, promptIdPrefix?: string): Promise<FitTestRunMode> {
  return select<FitTestRunMode>({
    promptId: qualifyPromptId("fit.tests.mode", promptIdPrefix),
    message: "Which FIT test-driver tests do you want to run?",
    default: "all",
    choices: [
      { name: "Run everything", value: "all" },
      ...(domain.showTransactionOptions
        ? [
            { name: "All transactions tests", value: "all-transactions" as FitTestRunMode },
            { name: "All non-transactions tests", value: "all-non-transactions" as FitTestRunMode },
          ]
        : []),
      ...(domain.showStandardQePreset
        ? [{ name: "Standard QE set", value: "standard-qe" as FitTestRunMode }]
        : []),
      {
        name: `Run a single sanity test (${domain.sanitySelector})`,
        value: "sanity",
      },
      { name: "Pick a single test", value: "single" },
      { name: "Pick multiple tests", value: "multiple" },
      { name: "Run tests in a package", value: "package" },
    ],
  });
}

/**
 * Pick the domain's sanity test without prompting for a searchable test name.
 * The selector may be a plain class (matched against the discovered tests) or a
 * `Class#method` form, which won't match a discovered class — so we fall back to
 * passing it straight to Maven as the `-Dtest` selector.
 */
export function buildSanityFitTestSelection(
  tests: FitTestCase[],
  domain: FitTestDomain = FUNCTIONAL_TEST_DOMAIN,
): FitTestSelection {
  const sanitySelection = buildFitTestSelection(tests, [domain.sanitySelector]);
  if (sanitySelection.selectedTests.length > 0) {
    return sanitySelection;
  }
  return buildFitTestSelectionFromClassNames([domain.sanitySelector]);
}

/** Single-test picker backed by a type-to-filter search box. */
async function selectSingleFitTest(tests: FitTestCase[], promptIdPrefix?: string): Promise<FitTestSelection> {
  const className = await search<string>({
    promptId: qualifyPromptId("fit.tests.single", promptIdPrefix),
    message: "Search for the FIT test to run:",
    source: fitTestSearchSource(tests),
  });
  const selection = buildFitTestSelection(tests, [className]);
  if (selection.selectedTests.length > 0) {
    return selection;
  }
  // The typed name didn't match a discovered test (e.g. not yet in the cache) - fall
  // back to passing it straight to Maven, mirroring buildSanityFitTestSelection.
  return buildFitTestSelectionFromClassNames([className]);
}

/** Extract the unique package names from a list of test cases (everything before the class name). */
export function extractFitTestPackages(tests: readonly FitTestCase[]): string[] {
  const packages = new Set<string>();
  for (const test of tests) {
    const lastDot = test.className.lastIndexOf(".");
    if (lastDot > 0) {
      packages.add(test.className.slice(0, lastDot));
    }
  }
  return [...packages].sort();
}

/** Package picker: checkbox list of unique packages, none pre-selected. */
async function selectByPackage(tests: FitTestCase[], promptIdPrefix?: string): Promise<FitTestSelection> {
  const packages = extractFitTestPackages(tests);
  const selectedPackages = await checkbox<string>({
    promptId: qualifyPromptId("fit.tests.package", promptIdPrefix),
    message: "Which packages do you want to run?",
    choices: packages.map((pkg) => ({ name: pkg, value: pkg, checked: false })),
    required: true,
  });
  const selectedTests = tests.filter((t) => selectedPackages.some((pkg) => t.className.startsWith(`${pkg}.`)));
  return {
    allTests: tests,
    selectedTests,
    selectedPackages,
    mavenTestSelector: selectedTests.map((t) => t.className).join(",") || undefined,
  };
}

/** Multi-test picker: the checkbox list, all tests pre-selected. */
async function selectMultipleFitTests(tests: FitTestCase[], promptIdPrefix?: string): Promise<FitTestSelection> {
  const selectedClassNames = await checkbox<string>({
    promptId: qualifyPromptId("fit.tests.select", promptIdPrefix),
    message: "Which FIT test-driver tests do you want to run?  (Default is everything)",
    choices: buildFitTestChoices(tests),
    required: true,
    theme: {
      style: {
        renderSelectedChoices: renderSelectedFitTestsAnswer,
      },
    },
    replay: {
      serializeResponse: (selectedClassNames: string[]) =>
        serializeSelectedFitTestsForReplay(selectedClassNames, tests),
      deserializeResponse: (response: unknown) =>
        deserializeSelectedFitTestsFromReplay(response, tests),
    },
  });
  return buildFitTestSelection(tests, selectedClassNames);
}

/** Prompt for which FIT test-driver tests to run from a pre-listed test set. */
export async function promptForFitTestSelection(
  tests: FitTestCase[],
  domain: FitTestDomain = FUNCTIONAL_TEST_DOMAIN,
  promptIdPrefix?: string,
): Promise<FitTestSelection> {
  const mode = await askFitTestRunMode(domain, promptIdPrefix);
  switch (mode) {
    case "all-transactions": {
      const selected = tests.filter(isTransactionsTest);
      return {
        allTests: tests,
        selectedTests: selected,
        mavenTestSelector: selected.map((t) => t.className).join(",") || undefined,
        presets: ["all-transactions"],
      };
    }
    case "all-non-transactions": {
      const selected = tests.filter((t) => !isTransactionsTest(t));
      return {
        allTests: tests,
        selectedTests: selected,
        mavenTestSelector: selected.map((t) => t.className).join(",") || undefined,
        presets: ["all-non-transactions"],
      };
    }
    case "standard-qe":
      return { allTests: [], selectedTests: [], presets: ["standard-qe"] };
    case "single":
      return await selectSingleFitTest(tests, promptIdPrefix);
    case "sanity":
      return buildSanityFitTestSelection(tests, domain);
    case "multiple":
      return await selectMultipleFitTests(tests, promptIdPrefix);
    case "package":
      return await selectByPackage(tests, promptIdPrefix);
    default:
      return buildDefaultFitTestSelection();
  }
}

/** Prompt for which FIT test-driver tests to run. */
export async function selectFitTests(
  execution: FitExecutionContext,
  domain: FitTestDomain = FUNCTIONAL_TEST_DOMAIN,
  promptIdPrefix?: string,
): Promise<FitTestSelection> {
  try {
    return await promptForFitTestSelection(listFitTests(execution, domain), domain, promptIdPrefix);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`\nCould not select specific FIT tests (${message}). Continuing with all tests.`);
    return buildDefaultFitTestSelection();
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const execution = createLocalFitExecutionContext();
    console.log(formatFitTestSelectionOutput(await selectFitTests(execution)));
  });
}
