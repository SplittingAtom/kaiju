import type { GitAccessLevel, GitCapabilities, GitProvider } from "@kobe/db";
import { GitHostError, type GitHostProbe } from "../git-hosts/adapter.js";

/**
 * What a connection test means for the connection (KOBE-760, spec G4): the probe's capabilities
 * judged against the access level the admin chose, and a failure turned into an API answer. Every
 * message is fixed text (the adapters' own, which never carry a credential, a URL query or a
 * host's answer, or one written here).
 */

export type GitCapabilityName = keyof GitCapabilities;

/** A warning shown with a passing test (G4): accepted, but the admin should know. */
export type GitTestWarning =
  | {
      /** The host names permissions beyond what Kaiju needs (delete, organization admin, ...). */
      readonly code: "excess_permissions";
      readonly permissions: readonly string[];
    }
  | {
      /** The credential may write or create while the connection is set below Read and write. */
      readonly code: "more_than_level";
      readonly capabilities: readonly GitCapabilityName[];
    }
  | {
      /** The host could not say whether the credential may do these (a fine-grained token). */
      readonly code: "unverified";
      readonly capabilities: readonly GitCapabilityName[];
    };

export interface GitProbeAssessment {
  /** What the connection needs and the credential cannot do; empty = acceptable. */
  readonly missing: readonly GitCapabilityName[];
  readonly warnings: readonly GitTestWarning[];
}

/** Judges a probe for `level` (G4): read is always needed, write at Read and write. */
export function assessProbe(probe: GitHostProbe, level: GitAccessLevel): GitProbeAssessment {
  const caps = probe.capabilities;
  const missing: GitCapabilityName[] = [];
  if (caps.read === "no") missing.push("read");
  if (level === "read_write" && caps.write === "no") missing.push("write");
  const warnings: GitTestWarning[] = [];
  if (probe.excess.length > 0) {
    warnings.push({ code: "excess_permissions", permissions: [...probe.excess] });
  }
  if (level !== "read_write") {
    const more = (["write", "create"] as const).filter((k) => caps[k] === "yes");
    if (more.length > 0) warnings.push({ code: "more_than_level", capabilities: more });
  }
  const needed: GitCapabilityName[] =
    level === "read_write" ? ["read", "write", "create"] : ["read"];
  const unknown = needed.filter((k) => caps[k] === "unknown");
  if (unknown.length > 0) warnings.push({ code: "unverified", capabilities: unknown });
  return { missing, warnings };
}

/** The probe as an admin may see it: no credential, nothing the host wrote in prose. */
export interface GitTestReport {
  readonly ok: boolean;
  readonly provider: GitProvider;
  readonly organization: {
    readonly login: string;
    readonly name: string | null;
    readonly kind: "organization" | "user";
  };
  readonly host_version: string | null;
  readonly actor: { readonly kind: "app" | "token"; readonly login: string | null };
  readonly capabilities: GitCapabilities;
  readonly excess_permissions: readonly string[];
  readonly credential_expires_at: string | null;
  readonly missing: readonly GitCapabilityName[];
  readonly warnings: readonly GitTestWarning[];
}

export function testReport(probe: GitHostProbe, assessment: GitProbeAssessment): GitTestReport {
  return {
    ok: assessment.missing.length === 0,
    provider: probe.provider,
    organization: {
      login: probe.organization.login,
      name: probe.organization.name,
      kind: probe.organization.kind,
    },
    host_version: probe.hostVersion,
    actor: { kind: probe.actor.kind, login: probe.actor.login },
    capabilities: { ...probe.capabilities },
    excess_permissions: [...probe.excess],
    credential_expires_at: probe.credentialExpiresAt?.toISOString() ?? null,
    missing: [...assessment.missing],
    warnings: assessment.warnings,
  };
}

/** A failed test as the API answers it. */
export interface GitTestFailure {
  readonly status: 403 | 422 | 502 | 503;
  readonly body: {
    readonly code: string;
    readonly message: string;
    readonly test: {
      readonly code: string;
      readonly reason?: string;
      readonly missing_permission?: string;
      readonly retry_at?: string;
    };
  };
}

const STATUS: Readonly<Record<string, { status: GitTestFailure["status"]; code: string }>> = {
  auth_failed: { status: 422, code: "credential_rejected" },
  forbidden: { status: 422, code: "credential_forbidden" },
  not_found: { status: 422, code: "organization_not_found" },
  invalid_request: { status: 422, code: "invalid_connection" },
  unsupported_host: { status: 422, code: "unsupported_host" },
  host_refused: { status: 422, code: "host_refused" },
  rate_limited: { status: 503, code: "host_rate_limited" },
  host_unreachable: { status: 502, code: "host_unreachable" },
  conflict: { status: 502, code: "host_error" },
  unexpected: { status: 502, code: "host_error" },
};

/** Reasons that are Site decisions (G3), answered as such. */
const SITE_REFUSALS: Readonly<Record<string, { code: string; message: string }>> = {
  site_git_off: { code: "git_disabled", message: "Git connections are turned off for this Site." },
  site_host_limit: {
    code: "host_not_allowed",
    message: "This Site does not allow Git connections to that host.",
  },
};

const REASON = /^[A-Za-z0-9_]{1,64}$/;

/** Refusals that are about the Site's rules or the host's answers, not the host's address. */
const NOT_ADDRESS = new Set([
  "site_git_off",
  "site_host_limit",
  "redirect",
  "other_host",
  "no_site_decision",
]);

/** The one answer for "cannot be reached or not allowed by address" (review L2). */
export const NOT_REACHABLE_REASON = "not_reachable";

/**
 * With no Site host list (any host may be named), a Workspace admin must not learn which internal
 * names resolve, or resolve to a refused private address (review L2): a name that does not
 * resolve, a host that does not answer and an address the policy refuses all read the same. The
 * detail stays in the server log. With a host list, the Site chose the hosts: no change.
 */
export function shownError(error: GitHostError, anyHost: boolean): GitHostError {
  if (!anyHost) return error;
  const byAddress =
    error.code === "host_unreachable" ||
    (error.code === "host_refused" && error.reason !== undefined && !NOT_ADDRESS.has(error.reason));
  if (!byAddress) return error;
  return new GitHostError(
    "host_refused",
    "The git host cannot be reached from this site, or its address is not allowed here.",
    { reason: NOT_REACHABLE_REASON },
  );
}

/** A Site refusal (G3): Git turned off, or the host not on the Site's list. */
export function isSiteRefusal(error: GitHostError): boolean {
  return (
    error.code === "host_refused" &&
    (error.reason === "site_git_off" || error.reason === "site_host_limit")
  );
}

/** The machine code stored as a connection's `last_error` (at most 64 characters). */
export function healthErrorCode(error: GitHostError): string {
  const reason = error.reason !== undefined && REASON.test(error.reason) ? `:${error.reason}` : "";
  return `${error.code}${reason}`.slice(0, 64);
}

/** The reason as an audit-safe code, when it is one. */
export function safeReason(error: GitHostError): string | undefined {
  return error.reason !== undefined && REASON.test(error.reason) ? error.reason : undefined;
}

/**
 * The API answer for a failed test. Anything but a {@link GitHostError} is rethrown (a bug, not
 * a host's answer; the global handler logs it without request data).
 */
export function testFailure(error: unknown): GitTestFailure {
  if (!(error instanceof GitHostError)) throw error;
  const reason = safeReason(error);
  const test = {
    code: error.code,
    ...(reason === undefined ? {} : { reason }),
    ...(error.missingPermission === undefined
      ? {}
      : { missing_permission: error.missingPermission }),
    ...(error.resetAt === undefined ? {} : { retry_at: error.resetAt.toISOString() }),
  };
  const site = error.code === "host_refused" && reason ? SITE_REFUSALS[reason] : undefined;
  if (site) return { status: 403, body: { ...site, test } };
  const mapped = STATUS[error.code] ?? { status: 502 as const, code: "host_error" };
  return { status: mapped.status, body: { code: mapped.code, message: error.message, test } };
}
