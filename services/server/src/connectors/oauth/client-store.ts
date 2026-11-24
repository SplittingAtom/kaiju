import { and, connectors, eq, isNull, type Envelope, type KaijuDb } from "@kaiju/db";
import { z } from "zod";
import { logger } from "../../logger.js";
import { urlSha256 } from "../site-key.js";
import type { ClientRegistration } from "./client.js";

/**
 * The OAuth client Kaiju registered for a connector (KOBE-784, review P2-31). Dynamic client
 * registration (RFC 7591) used to run on every "Connect" click, leaving a new client at the
 * authorization server each time; now the first registration is kept in `connectors.oauth_client`
 * and reused by every member's flow while it was made for the same issuer and Kaiju's current
 * redirect URI (a new public URL registers again and replaces it). Sealed with the site envelope,
 * bound to the connector and its URL, so a URL changed by any path leaves nothing usable; the
 * registry also clears it on a URL or auth-kind change. Never returned by any API or logged.
 */

/** A site-wide record has no team: the envelope binds to the nil team id. */
const SITE_TEAM = "00000000-0000-0000-0000-000000000000";

function clientContext(connectorId: string, url: string) {
  return {
    teamId: SITE_TEAM,
    kind: "connector_oauth_client",
    recordId: `${connectorId}:${urlSha256(url)}`,
  } as const;
}

const storedSchema = z.object({
  issuer: z.string(),
  redirect_uri: z.string(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1).optional(),
});

export interface ClientKey {
  readonly connectorId: string;
  /** The connector URL the flow discovered from. */
  readonly url: string;
  readonly issuer: string;
  readonly redirectUri: string;
}

/** The kept registration for this issuer and redirect URI, if there is one that still opens. */
export async function storedClient(
  db: KaijuDb,
  envelope: Envelope,
  key: ClientKey,
): Promise<ClientRegistration | undefined> {
  const [row] = await db
    .select({ sealed: connectors.oauthClient })
    .from(connectors)
    .where(
      and(
        eq(connectors.id, key.connectorId),
        eq(connectors.url, key.url),
        isNull(connectors.deletedAt),
      ),
    );
  if (!row?.sealed) return undefined;
  try {
    const parsed = storedSchema.parse(
      JSON.parse(envelope.openString(row.sealed, clientContext(key.connectorId, key.url))),
    );
    if (parsed.issuer !== key.issuer || parsed.redirect_uri !== key.redirectUri) return undefined;
    return { clientId: parsed.client_id, clientSecret: parsed.client_secret };
  } catch {
    // Sealed for another URL or key, or malformed: register again (and replace it).
    return undefined;
  }
}

/** Keeps a new registration, unless the connector's URL changed meanwhile. */
export async function saveClient(
  db: KaijuDb,
  envelope: Envelope,
  key: ClientKey,
  client: ClientRegistration,
): Promise<void> {
  const sealed = envelope.seal(
    JSON.stringify({
      issuer: key.issuer,
      redirect_uri: key.redirectUri,
      client_id: client.clientId,
      ...(client.clientSecret === undefined ? {} : { client_secret: client.clientSecret }),
    }),
    clientContext(key.connectorId, key.url),
  );
  try {
    await db
      .update(connectors)
      .set({ oauthClient: sealed })
      .where(
        and(
          eq(connectors.id, key.connectorId),
          eq(connectors.url, key.url),
          eq(connectors.authKind, "oauth"),
          isNull(connectors.deletedAt),
        ),
      );
  } catch (err) {
    // The flow goes on with the client it has; the next one registers again.
    logger.warn({ err, connectorId: key.connectorId }, "oauth client registration not kept");
  }
}
