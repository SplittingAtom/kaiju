/**
 * The result of an OAuth connect (KOBE-835), as the server's callback hands it back in the query
 * (`?connector_oauth=connected|failed&connector=<id>&reason=<code>`). Only fixed values are read:
 * the result is one of two words, the connector an id the page looks up in its own list, and the
 * reason a code mapped to Kobe's own sentence. Nothing from the query is shown as given.
 */
export interface OauthReturn {
  readonly ok: boolean;
  /** The connector's id, when it is a UUID; the page names it from its own list. */
  readonly connectorId: string | null;
  /** The failure code, when it is one Kobe knows; otherwise null (a generic sentence). */
  readonly reason: OauthFailureReason | null;
}

const PARAMS = ["connector_oauth", "connector", "reason"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Member-safe sentences per failure code the callback sends. */
const REASONS = {
  access_denied: "The sign-in was cancelled or refused at the service.",
  not_available:
    "The connector is no longer enabled for your workspace, or its address changed meanwhile. Connect again, or ask an admin.",
  token_exchange_failed: "The service did not finish the sign-in. Try connecting again.",
  iss_mismatch:
    "The answer did not come from the connector's own authorization server, so it was refused.",
  oauth_unreachable: "Could not reach the connector's authorization server. Try again later.",
  oauth_unsupported: "This connector's authorization server cannot be used safely with Kobe.",
  registration_failed: "The authorization server did not accept Kobe as a client.",
  invalid_state: "The sign-in took too long or was started elsewhere. Connect again.",
} as const;
export type OauthFailureReason = keyof typeof REASONS;

const isReason = (v: string): v is OauthFailureReason => Object.hasOwn(REASONS, v);

/** Reads the result from a query string; null when there is none. */
export function readOauthReturn(search: string): OauthReturn | null {
  const q = new URLSearchParams(search);
  const result = q.get("connector_oauth");
  if (result !== "connected" && result !== "failed") return null;
  const connector = q.get("connector");
  const reason = q.get("reason");
  return {
    ok: result === "connected",
    connectorId: connector !== null && UUID.test(connector) ? connector.toLowerCase() : null,
    reason: result === "failed" && reason !== null && isReason(reason) ? reason : null,
  };
}

/** Takes the result's parameters out of the address bar (a reload must not show it again). */
export function clearOauthReturn(): void {
  const url = new URL(window.location.href);
  if (!PARAMS.some((p) => url.searchParams.has(p))) return;
  for (const p of PARAMS) url.searchParams.delete(p);
  window.history.replaceState(window.history.state, "", url);
}

/** The notice's sentence; `name` is the connector's name from the page's own list. */
export function oauthReturnText(result: OauthReturn, name: string | undefined): string {
  const which = name === undefined ? "the connector" : name;
  if (result.ok) return `Connected your account to ${which}.`;
  const why = result.reason === null ? "Try connecting again." : REASONS[result.reason];
  return `Could not connect your account to ${which}. ${why}`;
}
