/**
 * Capella control plane calls for organization API keys. They cover the v2 login,
 * v2 key creation, and the v4 calls that check or delete a key. Used by
 * capella-key-rotate.ts, which shows how to run them.
 *
 * Capella returns a key's secret (its "token") once, in the create response. v4
 * clients send it as a bearer token. Nothing here prints it or puts it in an error.
 */

/** The non-secret settings of one Capella environment from environments.json5. */
export interface CapellaOrg {
  /** v2 base URL. */
  endpoint: string;
  /** v4 base URL. */
  v4Endpoint: string;
  organizationId: string;
}

export interface CreateApiKeyRequest {
  name: string;
  description: string;
  organizationRoles: string[];
  /** In days. -1 means the key never expires. */
  expiry: number;
  allowedCIDRs: string[];
}

export interface CreatedApiKey {
  id: string;
  name: string;
  /** The bearer secret. Never print it. */
  token: string;
}

/** A non-2xx answer from Capella. */
export class CapellaHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CapellaHttpError";
  }
}

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 256;
const REQUEST_TIMEOUT_MS = 30_000;
const ERROR_BODY_MAX_CHARS = 500;

/** An organization owner key that never expires and works from any address. */
export function createApiKeyRequest(name: string, description: string): CreateApiKeyRequest {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new Error(`A Capella API key name needs 1 to ${MAX_NAME_LENGTH} characters, got ${name.length}.`);
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(
      `A Capella API key description takes at most ${MAX_DESCRIPTION_LENGTH} characters, got ${description.length}.`,
    );
  }
  return {
    name,
    description,
    organizationRoles: ["organizationOwner"],
    expiry: -1,
    allowedCIDRs: ["0.0.0.0/0"],
  };
}

/**
 * Read the key from a create response. Errors name the missing fields only,
 * because the body holds the token.
 */
export function parseCreatedApiKey(body: unknown, requestedName: string): CreatedApiKey {
  const fields = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const text = (key: string): string | undefined => {
    const value = fields[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };
  const id = text("id");
  const token = text("token");
  if (!id || !token) {
    const missing = [!id && "id", !token && "token"].filter(Boolean).join(" and ");
    throw new Error(`The Capella create key response has no ${missing}.`);
  }
  return { id, name: text("name") ?? requestedName, token };
}

async function capellaRequest(
  method: string,
  url: string,
  authorization: string,
  body?: unknown,
): Promise<Response> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: authorization,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    // An error body never holds the token. Only a successful create returns it.
    const detail = (await response.text().catch(() => "")).trim().slice(0, ERROR_BODY_MAX_CHARS);
    throw new CapellaHttpError(
      response.status,
      `${method} ${url} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return response;
}

/** Parse a JSON body. The error leaves the body out, as a parser message can quote it. */
async function readJson(response: Response, what: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`The ${what} response is not JSON.`);
  }
}

const bearer = (token: string): string => `Bearer ${token}`;

export const loginUrl = (org: CapellaOrg): string => `${org.endpoint}/sessions`;

export const createApiKeyUrl = (org: CapellaOrg): string =>
  `${org.endpoint}/v2/organizations/${encodeURIComponent(org.organizationId)}/apikeys`;

export const organizationUrl = (org: CapellaOrg): string =>
  `${org.v4Endpoint}/v4/organizations/${encodeURIComponent(org.organizationId)}`;

export const apiKeyUrl = (org: CapellaOrg, keyId: string): string =>
  `${organizationUrl(org)}/apikeys/${encodeURIComponent(keyId)}`;

/** Log in to v2 with basic auth and return the session JWT. */
export async function loginV2(org: CapellaOrg, username: string, password: string): Promise<string> {
  const basic = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const response = await capellaRequest("POST", loginUrl(org), basic);
  const { jwt } = ((await readJson(response, "Capella v2 login")) ?? {}) as { jwt?: unknown };
  if (typeof jwt !== "string" || jwt === "") throw new Error("The Capella v2 login response has no jwt.");
  return jwt;
}

/** Create an organization API key through v2, authenticated with a v2 session JWT. */
export async function createApiKey(org: CapellaOrg, jwt: string, request: CreateApiKeyRequest): Promise<CreatedApiKey> {
  const response = await capellaRequest("POST", createApiKeyUrl(org), bearer(jwt), request);
  return parseCreatedApiKey(await readJson(response, "Capella create key"), request.name);
}

/** Resolve when v4 accepts the token. Throws {@link CapellaHttpError} when it does not. */
export async function checkApiKey(org: CapellaOrg, token: string): Promise<void> {
  await capellaRequest("GET", organizationUrl(org), bearer(token));
}

/** Delete a key through v4. Returns "already-gone" on a 404. */
export async function deleteApiKey(org: CapellaOrg, keyId: string, token: string): Promise<"deleted" | "already-gone"> {
  try {
    await capellaRequest("DELETE", apiKeyUrl(org, keyId), bearer(token));
    return "deleted";
  } catch (err) {
    if (err instanceof CapellaHttpError && err.status === 404) return "already-gone";
    throw err;
  }
}
