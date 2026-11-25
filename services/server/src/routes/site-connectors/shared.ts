import { type Context } from "hono";
import { z } from "zod";
import { type NameConflict } from "../../connectors/registry.js";
import { pinConnector, type PinOutcome } from "../../connectors/pinning.js";
import { adminPinCredential, nextPinnedBy } from "../../connectors/probe-credential.js";
import type { ServerDeps } from "../../deps.js";
import { PIN_MESSAGES } from "../connector-messages.js";

export const idSchema = z.uuid();

export const notFound = (c: Context) =>
  c.json({ code: "not_found", message: "That connector is not registered." }, 404);

export const CONFLICTS: Record<NameConflict, string> = {
  name_taken:
    "A connector with that name is already registered (names that differ only in - and _ count as the same).",
  name_removed:
    "A removed connector that teams still referenced keeps that name (names that differ only in - and _ count as the same). Pick another name.",
  name_reserved:
    "That name belongs to Kaiju's built-in connectors (kaiju, kaiju-git and their earlier names). Pick another name.",
};
export const nameConflict = (c: Context, error: NameConflict) =>
  c.json({ code: error, message: CONFLICTS[error] }, 409);

/** The `pin` part of a response: what happened to the tool surface (never the server's own text). */
/** A site-key connector is fixed by its key, not by anyone's own key (review L2). */
export const SITE_AUTH_REQUIRED =
  "The server asked for credentials: set (or re-enter) this connector's site-wide key. Tools stay unpinned (none are offered).";

/** An OAuth connector is probed with the acting admin's own connected account (KOBE-784). */
export const OAUTH_AUTH_REQUIRED =
  "The server asked for credentials. Kaiju probes an OAuth connector with your own connected account: connect your own account first (Connect your account in the connector's details, or My connectors, in a workspace that enabled it), then Re-probe; never a member's. Tools stay unpinned (none are offered).";

export const pinBody = (
  pin: PinOutcome,
  connector?: { readonly credentialSource: string; readonly authKind?: string },
) =>
  pin.ok
    ? {
        ok: true as const,
        tools: pin.tools,
        // MCP Apps templates pinned with the tools (KOBE-433), named only when there are any.
        ...(pin.templates > 0 ? { templates: pin.templates } : {}),
      }
    : {
        ok: false as const,
        failure: pin.failure,
        message:
          pin.failure === "auth_required" && connector?.authKind === "oauth"
            ? OAUTH_AUTH_REQUIRED
            : pin.failure === "auth_required" && connector?.credentialSource === "site"
              ? SITE_AUTH_REQUIRED
              : PIN_MESSAGES[pin.failure],
      };

export const TEMPLATE_APPROVAL_MESSAGES = {
  stale: "That template changed again since you reviewed it. Review it again.",
  not_pending: "That template is not waiting for approval.",
  invalid: "That template cannot be pinned (size, type, encoding or hash). It cannot be approved.",
} as const;

export const invalidFields =
  "Check the fields: name is lowercase letters and digits joined by - or _ (up to 64), url and iconUrl are https URLs, authKind is none, api_key or oauth, credentialSource is member or site (site needs api_key).";

export type ConnectorKit = ReturnType<typeof connectorKit>;

/** What the connector registry's route groups share: pinning as the acting admin, URL refusals. */
export function connectorKit(deps: ServerDeps) {
  const db = deps.database.db;

  // Pins as the acting admin: the site key, else their own grant, never a member's (KOBE-431).
  const pinAs = async (c: Context, connectorId: string) => {
    const adminId = c.get("user").id;
    return pinConnector(db, deps.connectorProbe, connectorId, {
      credential: adminPinCredential(db, deps.envelope, adminId, deps.mcp.oauthRefresh),
      pinnedBy: await nextPinnedBy(db, deps.envelope, connectorId, adminId, deps.mcp.oauthRefresh),
    });
  };

  const badUrl = (c: Context, check: { code: string; message: string }) =>
    c.json({ code: check.code, message: check.message }, 422);

  return { deps, db, pinAs, badUrl };
}
