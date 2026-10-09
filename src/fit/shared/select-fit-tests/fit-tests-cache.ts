/**
 * The committed list of FIT test-driver test files (fit-tests-cache.json5), and the class each
 * one defines. Read by the test picker and by fit health, which uses it to tell apart test
 * classes the driver names the same in different packages.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";

const FIT_TESTS_CACHE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fit-tests-cache.json5");
const bundledFitTestsCachePath = import.meta.url.includes("/$bunfs/")
  ? (
      await import("./fit-tests-cache.json5", {
        with: { type: "file" },
      }) as { default: string }
    ).default
  : undefined;

/**
 * Every FIT test-driver test path in the committed cache file. To regenerate the cache file, run:
 *   bunx tsx src/fit/shared/select-fit-tests/generate-fit-tests-cache.ts --root /path/to/transactions-fit-performer
 */
export function readFitTestPaths(): string[] {
  return JSON5.parse<string[]>(readFileSync(bundledFitTestsCachePath ?? FIT_TESTS_CACHE_PATH, "utf8"));
}

/** Convert a `java|scala/...` relative test path into its Maven-selectable FQCN. */
export function toClassName(relativePath: string): string {
  return relativePath
    .replace(/^(?:java|scala)\//, "")
    .replace(/\.(?:java|scala)$/, "")
    .replaceAll("/", ".");
}
