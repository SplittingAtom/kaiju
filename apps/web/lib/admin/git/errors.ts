/**
 * Kobe's own sentences for the git connection routes' typed errors (KOBE-760 failure mapping;
 * KOBE-758/759 adapter codes and reasons). Never the host's words: the server sends fixed text and
 * codes, and these say what to do about each. Unknown codes fall back to the server's message.
 */
import type { ApiError } from "../../api/client";
import type { GitFailureDetail, GitReport } from "../api/team/git";

export interface GitErrorContext {
  /** The organization the admin typed, to name it back. */
  readonly organization?: string;
  /** The provider's label ("GitHub", "Forgejo"). */
  readonly providerLabel?: string;
}

const NOT_ACCEPTED =
  "The host did not accept the credential. Check that you copied all of it and that it has not expired or been revoked.";

const REJECTED: Readonly<Record<string, string>> = {
  installation_removed:
    "The GitHub App is not installed on this organization (or the installation ID is wrong). Install the App on the organization and use that installation's ID.",
  installation_suspended:
    "The GitHub App's installation on this organization is suspended. An organization owner can unsuspend it in the organization's settings.",
  installation_account_mismatch:
    "That installation belongs to another account. Use the ID of the App's installation on this organization.",
  invalid_private_key:
    "The private key is not this App's, or is not a usable key. Generate a new private key in the App's settings and add it again.",
};

const FORBIDDEN: Readonly<Record<string, string>> = {
  token_owner_mismatch:
    "This token belongs to another account. On a personal account, use that account's own token.",
  user_namespace:
    "A GitHub App cannot act in a personal account. Connect an organization, or use a token.",
};

/** The failed test's codes, from an error answer's details (or a check's `error.test`). */
export function failureDetail(error: ApiError): GitFailureDetail | undefined {
  const test = error.details?.["test"];
  if (test === null || typeof test !== "object") return undefined;
  const t = test as Record<string, unknown>;
  if (typeof t["code"] !== "string") return undefined;
  return {
    code: t["code"],
    ...(typeof t["reason"] === "string" ? { reason: t["reason"] } : {}),
    ...(typeof t["missingPermission"] === "string"
      ? { missingPermission: t["missingPermission"] }
      : {}),
    ...(typeof t["retryAt"] === "string" ? { retryAt: t["retryAt"] } : {}),
  };
}

/** A 422 `credential_insufficient`'s report (what the credential may do), if the answer had one. */
export function insufficientReport(error: ApiError): GitReport | undefined {
  if (error.code !== "credential_insufficient") return undefined;
  const test = error.details?.["test"];
  if (test === null || typeof test !== "object" || !("capabilities" in test)) return undefined;
  return test as GitReport;
}

function retryText(retryAt: string | undefined): string {
  if (!retryAt) return "Try again in a few minutes.";
  const at = new Date(retryAt);
  if (Number.isNaN(at.getTime())) return "Try again in a few minutes.";
  return `Try again after ${at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}.`;
}

/** The sentence for a git route's error, by code and reason. */
export function gitErrorMessage(
  error: ApiError,
  detail: GitFailureDetail | undefined = failureDetail(error),
  ctx: GitErrorContext = {},
): string {
  const reason = detail?.reason;
  const org = ctx.organization ? ` named ${ctx.organization}` : "";
  switch (error.code) {
    case "git_disabled":
      return "Git connections are turned off for this Site. A Site admin can turn them on in the Site console's Settings.";
    case "host_not_allowed":
      return `${error.message} A Site admin can add the host to the Site's allowed git hosts.`;
    case "invalid_base_url":
      return `That address cannot be used: ${error.message.replace(/\.?$/, ".")}`;
    case "git_unavailable":
      return "Kobe cannot store git credentials on this Site yet: it has no encryption key. Ask whoever runs Kobe to configure one.";
    case "credential_rejected":
      return REJECTED[reason ?? ""] ?? NOT_ACCEPTED;
    case "credential_forbidden":
      if (reason && FORBIDDEN[reason]) return FORBIDDEN[reason];
      if (detail?.missingPermission) {
        return `The credential lacks a permission the host asked for: ${detail.missingPermission}. Add it on the host, then test again.`;
      }
      return "The host refused the credential in this organization. Check the permissions listed in step 2, then test again.";
    case "organization_not_found":
      return `The host has no organization or user${org} that this credential can see. Check the spelling; a GitHub token must have the organization as its resource owner.`;
    case "unsupported_host":
      if (reason === "version_too_old") return error.message;
      if (reason === "version_unreadable") {
        return "The host did not say which version it runs, so Kobe cannot tell whether it supports it. Check that the address is the server's web address.";
      }
      return `That address does not answer like a ${ctx.providerLabel ?? "git"} server. Check the address and the provider you chose.`;
    case "host_refused":
      if (reason === "not_reachable") {
        return "Kobe cannot reach that host from this Site, or its address is not allowed here. Check the address; a server on a private network needs the Site's internal targets entry (ask a Site admin).";
      }
      if (reason === "redirect") {
        return "The host answered with a redirect Kobe does not follow. Use the address the server finally shows in your browser.";
      }
      return "Kobe would not send the request to that address. A server on a private network needs the Site's internal targets entry (ask a Site admin).";
    case "invalid_connection":
      return "The host refused the request as invalid. Check the organization name.";
    case "host_unreachable":
      return "Kobe could not reach the host. Check the address; a server on a private network needs the Site's internal targets entry (ask a Site admin).";
    case "host_error":
      return "The host answered with an error. Try again in a few minutes.";
    case "host_rate_limited":
      return `The host's rate limit for this credential is used up. ${retryText(detail?.retryAt)}`;
    case "credential_insufficient":
      return error.message;
    case "credential_unreadable":
      return "Kobe could not open the stored credential (the Site's encryption key may have changed). Replace the credential.";
    case "internal_not_offered":
      return "Gitea and Forgejo have no internal repositories: choose Private.";
    case "unknown_agent":
      return "One of the chosen agents is no longer one of this Workspace's. Choose the agents again.";
    default:
      return error.message;
  }
}

const HEALTH_CODE: Readonly<Record<string, string>> = {
  auth_failed: "The host no longer accepts the credential.",
  "auth_failed:installation_removed": "The GitHub App is no longer installed on the organization.",
  "auth_failed:installation_suspended": "The GitHub App's installation is suspended.",
  "auth_failed:invalid_private_key": "The App's private key no longer works.",
  forbidden: "The credential lost a permission it needs.",
  not_found: "The organization is gone, or the credential can no longer see it.",
  rate_limited: "The host's rate limit was used up at the last check.",
  host_unreachable: "Kobe could not reach the host at the last check.",
  unsupported_host: "The host's version is no longer supported.",
  host_refused: "Kobe would not send requests to the host's address.",
  "host_refused:not_reachable":
    "Kobe could not reach the host at the last check, or its address is not allowed here.",
  "host_refused:site_git_off": "Git connections are turned off for this Site.",
  "host_refused:site_host_limit": "The Site no longer allows this host.",
  credential_unreadable: "Kobe could not open the stored credential.",
};

/** A stored health code (`auth_failed:credential_rejected`) as a sentence. */
export function healthMessage(code: string | null): string {
  if (!code) return "The last check failed.";
  const base = code.split(":")[0] ?? code;
  return HEALTH_CODE[code] ?? HEALTH_CODE[base] ?? "The last check failed.";
}
