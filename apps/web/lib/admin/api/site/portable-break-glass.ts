/**
 * Site console: break-glass for portable memories (KOBE-648, SM28; `/v1/site/portable-break-glass`,
 * site admins). Grants arrive camelized; item reads mirror the server's snake_case, camelized too.
 */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { GrantPerson, GrantStatus } from "./break-glass";

const enc = encodeURIComponent;

export interface PortableGrant {
  readonly id: string;
  readonly subject: GrantPerson;
  readonly requestedBy: GrantPerson;
  readonly approvedBy: GrantPerson | null;
  readonly decidedBy: GrantPerson | null;
  readonly reason: string;
  readonly legalHold: boolean;
  readonly durationMinutes: number;
  readonly status: GrantStatus;
  readonly selfApproved: boolean;
  readonly requestedAt: string;
  readonly requestExpiresAt: string;
  readonly decidedAt: string | null;
  readonly startsAt: string | null;
  readonly expiresAt: string | null;
  readonly endedAt: string | null;
  /** What the server would allow the viewer now (courtesy: it decides again on each call). */
  readonly actions: {
    readonly approve: boolean;
    readonly deny: boolean;
    readonly revoke: boolean;
    readonly read: boolean;
  };
}

export interface PortableGrantList {
  readonly grants: readonly PortableGrant[];
  readonly selfApprovalAllowed: boolean;
}

export interface PortableGrantRequest {
  readonly subjectUserId: string;
  readonly reason: string;
  readonly durationMinutes: number;
  readonly legalHold: boolean;
}

export interface PortableGrantChange {
  readonly grant: PortableGrant;
  readonly notified: { readonly recipients: number };
}

export type PortableGrantDecision = "approve" | "deny" | "revoke";

const BASE = "/v1/site/portable-break-glass";

export function listPortableGrants(): Promise<ApiResult<PortableGrantList>> {
  return apiRequest<PortableGrantList>(BASE);
}

export function requestPortableGrant(
  input: PortableGrantRequest,
): Promise<ApiResult<PortableGrantChange>> {
  return apiRequest<PortableGrantChange>(BASE, { method: "POST", json: { ...input } });
}

export function decidePortableGrant(
  grantId: string,
  decision: PortableGrantDecision,
): Promise<ApiResult<PortableGrantChange>> {
  return apiRequest<PortableGrantChange>(`${BASE}/${enc(grantId)}/${decision}`, {
    method: "POST",
  });
}

// ── Reads under an active grant: every call is audited in the Site log and the person's Workspaces ──

export interface PortableReadGrant {
  readonly id: string;
  readonly subjectUserId: string;
  readonly expiresAt: string;
  /** Workspaces the read was recorded in. */
  readonly workspaces: number;
}

export interface PortableItem {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly pinned: boolean;
  readonly tags: readonly string[];
  readonly currentVersion: number;
  readonly statement: string;
  readonly updatedAt: string;
}

export interface PortableItemPage {
  readonly grant: PortableReadGrant;
  readonly items: readonly PortableItem[];
  readonly nextAfter: string | null;
}

export function readPortableItems(
  grantId: string,
  after?: string | null,
): Promise<ApiResult<PortableItemPage>> {
  const query = after ? `?after=${enc(after)}` : "";
  return apiRequest<PortableItemPage>(`${BASE}/${enc(grantId)}/items${query}`);
}
