/**
 * A member's own connector credentials (`/v1/connector-grants`): API keys (KOBE-108), which go in
 * on PUT and never come back, and OAuth sign-ins (KOBE-109, connected from the web by KOBE-835),
 * whose tokens never reach the browser. Responses carry a masked hint and timestamps only.
 */
import { apiRequest, type ApiResult } from "../../../api/client";

const BASE = "/v1/connector-grants";

export interface ConnectorGrant {
  readonly connectorId: string;
  /** Masked: at most the last four characters of a long key. */
  readonly hint: string;
  /** `oauth` for a connected account; older servers omit it (API keys only then). */
  readonly kind?: "api_key" | "oauth";
  /** OAuth: when the access token runs out (Kaiju renews it when it can); null for API keys. */
  readonly expiresAt?: string | null;
  /**
   * OAuth: Kaiju renews the sign-in by itself (it holds a refresh token), so a past `expiresAt` is
   * not an expired sign-in (KOBE-835). Always false for API keys; older servers omit it.
   */
  readonly refreshable?: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Same bounds as the server: 8 to 2048 visible ASCII characters. */
export const KEY_PATTERN = /^[\x21-\x7e]{8,2048}$/;
export const KEY_HINT =
  "Paste the key exactly as the service gave it (8 to 2048 characters, no spaces).";

export async function listGrants(teamId: string): Promise<ApiResult<readonly ConnectorGrant[]>> {
  const res = await apiRequest<{ grants: readonly ConnectorGrant[] }>(BASE, { teamId });
  return res.ok ? { ...res, data: res.data.grants } : res;
}

/** Adds or replaces the caller's key; the result carries the hint only. */
export async function saveGrant(
  teamId: string,
  connectorId: string,
  apiKey: string,
): Promise<ApiResult<ConnectorGrant>> {
  const res = await apiRequest<{ grant: ConnectorGrant }>(
    `${BASE}/${encodeURIComponent(connectorId)}`,
    { method: "PUT", json: { api_key: apiKey }, teamId },
  );
  return res.ok ? { ...res, data: res.data.grant } : res;
}

export const removeGrant = (teamId: string, connectorId: string): Promise<ApiResult<unknown>> =>
  apiRequest(`${BASE}/${encodeURIComponent(connectorId)}`, { method: "DELETE", teamId });

/**
 * Where the browser comes back after the sign-in: My connectors, or (site admins) the Site
 * console's connector registry. A name, never a URL: the server maps it to a fixed page.
 */
export type OauthReturnTo = "me" | "site";

/**
 * Starts connecting the caller's own account (`POST /{id}/oauth/start`); the result is the
 * authorization server's URL to send the browser to. The state, PKCE verifier and tokens stay on
 * the server.
 */
export async function startOauthConnect(
  teamId: string,
  connectorId: string,
  returnTo: OauthReturnTo = "me",
): Promise<ApiResult<string>> {
  const res = await apiRequest<{ authorizationUrl: string }>(
    `${BASE}/${encodeURIComponent(connectorId)}/oauth/start`,
    { method: "POST", json: returnTo === "me" ? {} : { return_to: returnTo }, teamId },
  );
  return res.ok ? { ...res, data: res.data.authorizationUrl } : res;
}

/** Only an http(s) URL is followed; anything else is treated as a failed start. */
export function isAuthorizationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/** Sends the browser to the authorization server (a seam for tests). */
export const browserNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};
