/** Site console: users (`/v1/site`, site.users.manage). Responses arrive camelized. */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { SiteRole } from "../../nav/types";

const enc = encodeURIComponent;

export interface SiteUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly siteRole: SiteRole;
  readonly twoFactorEnabled: boolean;
  readonly deactivatedAt: string | null;
  readonly createdAt: string;
}

export interface DeactivationResult {
  readonly userId: string;
  readonly deactivated: boolean;
  /** Teams whose only active team admin this was (deactivation only). */
  readonly teamsWithoutActiveAdmin?: readonly {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
  }[];
  /** Downstream steps (sandboxes, grants, schedules…) that failed; deactivation still holds. */
  readonly incompleteSteps: readonly string[];
}

export async function listUsers(): Promise<ApiResult<readonly SiteUser[]>> {
  const res = await apiRequest<{ users: SiteUser[] }>("/v1/site/users");
  return res.ok ? { ...res, data: res.data.users } : res;
}

/** Sign-in protection (KOBE-812): throttled accounts and unknown client address sightings. */
export interface SignInProtection {
  /** Accounts past 10 failed attempts in 15 minutes: one attempt a minute until `until`. */
  readonly throttled: readonly { readonly userId: string; readonly until: string }[];
  /** Since when (last day) requests arrived without a trusted client address; null: none. */
  readonly unknownClientIp: { readonly since: string } | null;
}

export function getSignInProtection(): Promise<ApiResult<SignInProtection>> {
  return apiRequest("/v1/site/users/sign-in-protection");
}

export function setUserActive(
  userId: string,
  active: boolean,
): Promise<ApiResult<DeactivationResult>> {
  return apiRequest(`/v1/site/users/${enc(userId)}/${active ? "reactivate" : "deactivate"}`, {
    method: "POST",
  });
}

export interface PortablePurgeResult {
  readonly userId: string;
  /** Portable memories removed. */
  readonly purged: number;
  /** Kept because a run in a workspace under legal hold used them. */
  readonly kept: number;
  /** Left for another purge (one call works in bounded batches); 0 when done. */
  readonly remaining: number;
}

/**
 * Purges a deactivated person's portable memories (KOBE-386; kept until then). `confirmEmail`: the
 * person's email address as the admin typed it (the server checks it too).
 */
export function purgePortableMemory(
  userId: string,
  confirmEmail: string,
): Promise<ApiResult<PortablePurgeResult>> {
  return apiRequest(`/v1/site/users/${enc(userId)}/portable-memory/purge`, {
    method: "POST",
    json: { confirmEmail },
  });
}
