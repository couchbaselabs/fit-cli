/**
 * SDKs that FIT can test.
 *
 * `performer` is the SDK's performer directory name. For non-JVM SDKs that is
 * the directory under transactions-fit-performer/performers. For JVM SDKs
 * (Java, Kotlin, Scala) the performer lives in couchbase-jvm-clients as
 * <performer>-fit-performer; the matching performers/ entry under
 * transactions-fit-performer is the old one and is no longer used.
 */
export const SDKS = [
  { name: "Java", value: "java", jvm: true, performer: "java", family: "operational" },
  { name: "Scala", value: "scala", jvm: true, performer: "scala", family: "operational" },
  { name: "Kotlin", value: "kotlin", jvm: true, performer: "kotlin", family: "operational" },
  { name: "C++", value: "cpp", jvm: false, performer: "cpp", family: "operational" },
  { name: ".NET", value: "dotnet", jvm: false, performer: "dotnet", family: "operational" },
  { name: "Go", value: "go", jvm: false, performer: "go", family: "operational" },
  { name: "Node.js", value: "node", jvm: false, performer: "node", family: "operational" },
  { name: "Python", value: "python", jvm: false, performer: "python", family: "operational" },
  { name: "Ruby", value: "ruby", jvm: false, performer: "ruby", family: "operational" },
  { name: "Rust", value: "rust", jvm: false, performer: "rust", family: "operational" },
  // Analytics SDKs — tested via the columnar-test-driver (`analytics-functional`
  // runs). Two families exist: "Columnar SDK" (recommended for Capella Analytics) and
  // "Enterprise Analytics SDK" (recommended for Enterprise Analytics + a load balancer).
  // Prebuilt performer images published so far:
  //   - columnar-java (family "columnar"), JVM, from couchbase/couchbase-jvm-clients:
  //     https://github.com/couchbase/couchbase-jvm-clients/pkgs/container/columnar-java-fit-performer
  //   - analytics-java (family "enterprise-analytics"), JVM, from couchbase/couchbase-jvm-clients:
  //     https://github.com/couchbase/couchbase-jvm-clients/pkgs/container/analytics-java-fit-performer
  //   - analytics-dotnet (family "enterprise-analytics"), from couchbase/analytics-dotnet-client:
  //     https://github.com/orgs/couchbase/packages/container/package/analytics-dotnet-fit-performer
  // The Go/Node/Python columnar+analytics performers in transactions-fit-performer are
  // not published. Add entries here as more images ship.
  // Enterprise Analytics SDK first — it's the standard/recommended choice for the
  // (self-managed Enterprise Analytics) clusters fit-cli allocates; the Columnar SDK
  // is mainly for Capella Analytics or the odd cross-combination.
  { name: "Java Enterprise Analytics", value: "analytics-java", jvm: true, performer: "analytics/java", family: "enterprise-analytics" },
  { name: ".NET Enterprise Analytics", value: "analytics-dotnet", jvm: false, performer: "analytics/dotnet", family: "enterprise-analytics" },
  { name: "Java Columnar", value: "columnar-java", jvm: true, performer: "columnar/java", family: "columnar" },
] as const;

export type Sdk = (typeof SDKS)[number];
export type SdkValue = Sdk["value"];
export type SdkFamily = Sdk["family"];

/** Look up an SDK by its `value`, or undefined if there is no such SDK. */
export function sdkByValue(value: string): Sdk | undefined {
  return SDKS.find((sdk) => sdk.value === value);
}

/**
 * True for any Analytics SDK (Columnar SDK or, once published, Enterprise Analytics
 * SDK) — i.e. anything that isn't an operational SDK. These run via the Analytics
 * test-driver.
 */
export function isAnalyticsSdk(sdk: Sdk): boolean {
  return sdk.family !== "operational";
}

/**
 * True if this SDK currently publishes a prebuilt performer Docker image to
 * GHCR. The operational JVM SDKs (Java, Scala, Kotlin), C++, .NET, Go, Ruby
 * and Rust do, as do the Analytics SDKs (Columnar + Enterprise Analytics);
 * fit-cli only runs performers from prebuilt images, so these are the only
 * SDKs it can test. Node.js and Python don't yet publish prebuilt images.
 */
const PERFORMER_IMAGE_SDK_VALUES: SdkValue[] = ["cpp", "dotnet", "go", "ruby", "rust"];

export function sdkPublishesPerformerImage(sdk: Sdk): boolean {
  return isAnalyticsSdk(sdk) || sdk.jvm || PERFORMER_IMAGE_SDK_VALUES.includes(sdk.value);
}

/** All SDKs fit-cli can test — those with prebuilt performer images. */
export const PREBUILT_PERFORMER_SDKS = SDKS.filter(sdkPublishesPerformerImage);

/** Operational (non-Analytics) prebuilt SDKs — the choices for a functional/situational run. */
export const OPERATIONAL_PREBUILT_SDKS = PREBUILT_PERFORMER_SDKS.filter((sdk) => sdk.family === "operational");

/**
 * The SDKs an `analytics-functional` run can use — both the Columnar SDKs and the
 * Enterprise Analytics SDKs. (Which is recommended depends on the cluster:
 * Enterprise Analytics + load balancer → Enterprise Analytics SDK; Capella
 * Analytics → Columnar SDK.)
 */
export const ANALYTICS_FUNCTIONAL_SDKS = SDKS.filter(isAnalyticsSdk);

/**
 * The GHCR package basename for an SDK's performer image is usually its `value`
 * (e.g. `java` → `java-fit-performer`), but a few differ from the SDK's value.
 * C++ uses `value` "cpp" everywhere user-facing but publishes `cxx-fit-performer`.
 */
const PERFORMER_IMAGE_BASENAMES: Partial<Record<SdkValue, string>> = { cpp: "cxx" };

/** The basename of this SDK's GHCR performer image (before `-fit-performer`). */
export function sdkPerformerImageBasename(sdk: Sdk): string {
  return PERFORMER_IMAGE_BASENAMES[sdk.value] ?? sdk.value;
}

/** Look up an SDK by its performer image basename (e.g. `cxx` → C++), or undefined. */
export function sdkByPerformerImageBasename(basename: string): Sdk | undefined {
  return SDKS.find((sdk) => sdkPerformerImageBasename(sdk) === basename);
}
