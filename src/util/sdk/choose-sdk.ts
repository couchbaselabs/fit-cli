/**
 * Step: ask which SDK to test and return it.
 *
 * Run on its own:
 *   bun src/util/sdk/choose-sdk.ts
 *
 * Prints the chosen SDK as JSON.
 */
import { qualifyPromptId, select } from "../non-fit/prompts.js";
import { isMain, runCli } from "../non-fit/cli.js";
import { ANALYTICS_FUNCTIONAL_SDKS, OPERATIONAL_SDKS, sdkByValue, type Sdk, type SdkValue } from "./sdks.js";

export async function chooseSdk(
  message: string = "Which SDK do you want to test?",
  promptIdPrefix?: string,
): Promise<Sdk> {
  // Only the operational SDKs are offered here; the Analytics SDKs are chosen via
  // their own analytics-functional flow.
  const value = await select<SdkValue>({
    promptId: qualifyPromptId("sdk.choose", promptIdPrefix),
    message,
    choices: OPERATIONAL_SDKS.map((sdk) => ({ name: sdk.name, value: sdk.value })),
  });
  // The selected value always comes from OPERATIONAL_SDKS, so this is never undefined.
  return sdkByValue(value)!;
}

/**
 * Choose an SDK for an `analytics-functional` run: either a Columnar SDK or an
 * Enterprise Analytics SDK. Both are offered because either can be pointed at
 * either Analytics cluster product (Enterprise Analytics + load balancer
 * recommends an Enterprise Analytics SDK; Capella Analytics recommends a Columnar
 * SDK).
 */
export async function chooseAnalyticsFunctionalSdk(
  message: string = "Which Analytics SDK do you want to test (Columnar SDK or Enterprise Analytics SDK)?",
  promptIdPrefix?: string,
  defaultSdkValue?: SdkValue,
): Promise<Sdk> {
  const value = await select<SdkValue>({
    promptId: qualifyPromptId("sdk.choose.analytics", promptIdPrefix),
    message,
    choices: ANALYTICS_FUNCTIONAL_SDKS.map((sdk) => ({ name: sdk.name, value: sdk.value })),
    ...(defaultSdkValue !== undefined ? { default: defaultSdkValue } : {}),
  });
  return sdkByValue(value)!;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const sdk = await chooseSdk();
    console.log(JSON.stringify(sdk, null, 2));
  });
}
