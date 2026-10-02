/**
 * The class part of a test id. It is the simple class name - what fit-cli's ❌ lines print, and
 * the same for every SDK - except where the FIT driver has two classes of that name in
 * different packages (kv.GetTest and transactions.states.GetTest): those get the shortest
 * package suffix that tells them apart, joined with "/" (never ".", which separates the class
 * from the method in an id): "kv/GetTest", "states/GetTest",
 * "client/observability/ObservabilityTest".
 *
 * Which names are ambiguous comes from fit-cli's committed list of driver test files
 * (fit-tests-cache.json5), not from which classes a night happened to run, so every SDK and
 * every night name a test the same way.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";

const CACHE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../shared/select-fit-tests/fit-tests-cache.json5");
const bundledCachePath = import.meta.url.includes("/$bunfs/")
  ? ((await import("../../shared/select-fit-tests/fit-tests-cache.json5", { with: { type: "file" } })) as { default: string }).default
  : undefined;

/** "java/com/couchbase/client/kv/GetTest.java" -> "com.couchbase.client.kv.GetTest". */
export function classOfPath(path: string): string {
  return path.replace(/^(java|scala|kotlin)\//, "").replace(/\.(java|scala|kt)$/, "").replace(/\//g, ".");
}

/** For each simple class name defined in more than one package: each class's qualified key. */
export function qualifiers(paths: readonly string[]): Map<string, Map<string, string>> {
  const bySimple = new Map<string, string[]>();
  for (const p of paths) {
    const fq = classOfPath(p);
    const simple = fq.slice(fq.lastIndexOf(".") + 1);
    (bySimple.get(simple) ?? bySimple.set(simple, []).get(simple)!).push(fq);
  }
  const out = new Map<string, Map<string, string>>();
  for (const [simple, classes] of bySimple) {
    if (classes.length < 2) continue;
    const packages = classes.map((c) => c.split(".").slice(0, -1));
    // The fewest trailing package segments that make every class's key unique.
    let k = 1;
    const key = (segs: string[]) => [...segs.slice(-k), simple].join("/");
    while (k < Math.max(...packages.map((s) => s.length)) && new Set(packages.map(key)).size < classes.length) k++;
    out.set(simple, new Map(classes.map((c, i) => [c, key(packages[i])])));
  }
  return out;
}

let cached: Map<string, Map<string, string>> | undefined;
function driverQualifiers(): Map<string, Map<string, string>> {
  if (!cached) {
    const path = bundledCachePath ?? CACHE_PATH;
    cached = qualifiers(JSON5.parse<string[]>(readFileSync(path, "utf8")));
  }
  return cached;
}

/** The driver uses this simple class name in more than one package (so a log line can't say which). */
export function isReusedClassName(simple: string, table: Map<string, Map<string, string>> = driverQualifiers()): boolean {
  return table.has(simple.replace(/\$.*$/, ""));
}

/**
 * The class part of a test id for a fully-qualified JUnit class name. A nested class
 * (Outer$Inner) is qualified by its outer class's name.
 */
export function classKey(classname: string, table: Map<string, Map<string, string>> = driverQualifiers()): string {
  const simple = classname.slice(classname.lastIndexOf(".") + 1);
  const dollar = simple.indexOf("$");
  const outer = dollar < 0 ? simple : simple.slice(0, dollar);
  const outerFq = classname.slice(0, classname.length - simple.length) + outer;
  const q = table.get(outer)?.get(outerFq);
  return q ? q + simple.slice(outer.length) : simple;
}
