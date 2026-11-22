import { Hono } from "hono";
import type { AuthVariables } from "../../auth/session.js";
import {
  createConnector,
  createSchema,
  getConnector,
  listConnectors,
  updateConnector,
  updateSchema,
} from "../../connectors/registry.js";
import { connectorRefreshLocks } from "../../connectors/refresh.js";
import { reprobeConnector } from "../../connectors/reprobe.js";
import { reprobeReply } from "../reprobe-reply.js";
import { checkConnectorUrl } from "../../connectors/url-policy.js";
import { invalidRequest, param, parseBody } from "../../http/request.js";
import {
  idSchema,
  notFound,
  nameConflict,
  pinBody,
  invalidFields,
  type ConnectorKit,
} from "./shared.js";

/** The registry: list, read, register, change, pin and re-probe a connector. */
export function connectorCoreRoutes(kit: ConnectorKit): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const { deps, db, pinAs, badUrl } = kit;

  app.get("/", async (c) => c.json({ connectors: await listConnectors(db) }));

  app.get("/:id", async (c) => {
    const id = param(c, "id", idSchema);
    const found = id.success ? await getConnector(db, id.data) : undefined;
    return found ? c.json({ connector: found }) : notFound(c);
  });

  app.post("/", async (c) => {
    const input = await parseBody(c, createSchema);
    if (!input) return invalidRequest(c, invalidFields);
    const checked = await checkConnectorUrl(input.url, deps.connectorUrlPolicy);
    if (!checked.ok) return badUrl(c, checked);
    const result = await createConnector(db, { ...input, url: checked.url }, c.get("user").id);
    if (!result.ok) return nameConflict(c, result.error);
    // Registering snapshots and pins every tool; a failed probe leaves it registered, unpinned.
    const pin = await pinAs(c, result.connector.id);
    const connector = (await getConnector(db, result.connector.id)) ?? result.connector;
    return c.json({ connector, ...(pin ? { pin: pinBody(pin, connector) } : {}) }, 201);
  });

  app.patch("/:id", async (c) => {
    const id = param(c, "id", idSchema);
    if (!id.success) return notFound(c);
    const input = await parseBody(c, updateSchema);
    if (!input) return invalidRequest(c, invalidFields);
    let patch = input;
    if (input.url !== undefined) {
      const checked = await checkConnectorUrl(input.url, deps.connectorUrlPolicy);
      if (!checked.ok) return badUrl(c, checked);
      patch = { ...input, url: checked.url };
    }
    const result = await updateConnector(db, id.data, patch);
    if (!result.ok) {
      if (result.error === "not_found") return notFound(c);
      if (result.error === "changed_since_approval") {
        return c.json(
          {
            code: "changed_since_approval",
            message: "The connector's status changed meanwhile; nothing was changed.",
          },
          409,
        );
      }
      if (result.error === "site_needs_api_key") {
        return invalidRequest(
          c,
          "A site-wide key is for API-key connectors only: set authKind to api_key as well.",
        );
      }
      return nameConflict(c, result.error);
    }
    // A new URL cleared the old pins; pin the new server's tools (no-op when pins still exist).
    const pin = patch.url === undefined ? undefined : await pinAs(c, id.data);
    const connector = (await getConnector(db, id.data)) ?? result.connector;
    const shown =
      pin && !(!pin.ok && pin.failure === "already_pinned") ? { pin: pinBody(pin, connector) } : {};
    return c.json({ connector, ...shown });
  });

  // Probe and pin again, for a connector that has none (the registration probe failed).
  app.post("/:id/pin", async (c) => {
    const id = param(c, "id", idSchema);
    const pin = id.success ? await pinAs(c, id.data) : undefined;
    if (!id.success || !pin) return notFound(c);
    const connector = await getConnector(db, id.data);
    return c.json(
      { connector, pin: pinBody(pin, connector) },
      pin.ok || pin.failure === "already_pinned" ? 200 : 502,
    );
  });

  // Re-probe now (KOBE-430): the refresh's probe and drift for this connector, under its lock.
  // Read per request: building the app must not touch the probe (threads.db.test ac-2).
  const reprobeDeps = () => ({
    db,
    prober: deps.connectorProbe,
    envelope: deps.envelope,
    lockFor: connectorRefreshLocks(deps.database.pool),
  });
  app.post("/:id/refresh", async (c) => {
    const id = param(c, "id", idSchema);
    if (!id.success) return notFound(c);
    const result = await reprobeConnector(reprobeDeps(), id.data, c.get("user").id);
    if (result.kind === "not_found") return notFound(c);
    const connector = await getConnector(db, id.data);
    const reply = reprobeReply(result, connector?.credentialSource);
    return c.json({ ...reply.body, ...(reply.status === 200 ? { connector } : {}) }, reply.status);
  });

  return app;
}
