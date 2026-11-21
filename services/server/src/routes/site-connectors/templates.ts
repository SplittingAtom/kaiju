import { Hono } from "hono";
import type { AuthVariables } from "../../auth/session.js";
import { appFrameDocument, mayLoadAppFrame } from "../../connectors/app-frame.js";
import {
  approveConnectorTemplates,
  approveTemplatesSchema,
  connectorTemplateFrame,
  connectorTemplateSource,
  reviewConnectorTemplates,
} from "../../connectors/template-review.js";
import { setPlacementSchema, setTemplatePlacement } from "../../connectors/template-placement.js";
import { invalidRequest, param, parseBody } from "../../http/request.js";
import { idSchema, notFound, TEMPLATE_APPROVAL_MESSAGES, type ConnectorKit } from "./shared.js";

/** A connector's ui:// templates: list, source, preview frame, approval and placement. */
export function connectorTemplateRoutes(kit: ConnectorKit): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const { deps, db } = kit;

  app.get("/:id/templates", async (c) => {
    const id = param(c, "id", idSchema);
    const templates = id.success ? await reviewConnectorTemplates(db, id.data) : undefined;
    return templates ? c.json({ templates }) : notFound(c);
  });

  // A template's bytes for the escaped diff and the stubbed preview: JSON only, never text/html,
  // never cached, never sniffed or run as a page on Kobe's origin (spec MA4).
  app.get("/:id/templates/source", async (c) => {
    const id = param(c, "id", idSchema);
    const uri = c.req.query("uri");
    const source =
      id.success && uri !== undefined ? await connectorTemplateSource(db, id.data, uri) : undefined;
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", "default-src 'none'");
    return source
      ? c.json({ source })
      : c.json({ code: "not_found", message: "That template is not pinned or pending." }, 404);
  });

  // The admin preview of a template's live or approved bytes (KOBE-434 review M2): text/html only
  // with the app frame's header CSP (sandbox allow-scripts: an opaque origin even top-level, no
  // network), only into a frame of Kobe's own page. Members never reach this route (site
  // permission above); MA-5's member route serves only approved templates.
  app.get("/:id/templates/frame", async (c) => {
    // Only into a frame of Kobe's own page (review LOW-1).
    if (!mayLoadAppFrame(c.req.raw.headers, deps.publicUrl)) {
      return c.json(
        { code: "forbidden_origin", message: "Only Kobe's own frames load this." },
        403,
      );
    }
    const id = param(c, "id", idSchema);
    const uri = c.req.query("uri");
    const which = c.req.query("version");
    const html =
      id.success && uri !== undefined && (which === "live" || which === "approved")
        ? await connectorTemplateFrame(db, id.data, uri, which)
        : undefined;
    if (html === undefined) {
      return c.json({ code: "not_found", message: "That template version is not there." }, 404);
    }
    // The preview runs exactly the bytes the admin's source read showed (review LOW-2).
    const document = appFrameDocument(html, c.req.query("sha256"));
    if (document === "stale") {
      return c.json(
        { code: "stale", message: "The template changed. Show the source again." },
        409,
      );
    }
    return document;
  });

  // Approve templates, each with the pinned hash of the live version that was reviewed.
  app.post("/:id/templates/approve", async (c) => {
    const id = param(c, "id", idSchema);
    if (!id.success) return notFound(c);
    const input = await parseBody(c, approveTemplatesSchema);
    if (!input) {
      return invalidRequest(
        c,
        "Send templates: a list of { uri, pinnedHash } of the reviewed templates.",
      );
    }
    const result = await approveConnectorTemplates(db, id.data, input, c.get("user").id);
    if (result.ok) return c.json({ approved: result.approved });
    if (result.error === "not_found") return notFound(c);
    return c.json(
      { code: result.error, uri: result.uri, message: TEMPLATE_APPROVAL_MESSAGES[result.error] },
      409,
    );
  });

  // Where a template's app opens (KOBE-531): `chat`, `artifacts` or `rail`; not part of the pin.
  app.put("/:id/templates/placement", async (c) => {
    const id = param(c, "id", idSchema);
    if (!id.success) return notFound(c);
    const input = await parseBody(c, setPlacementSchema);
    if (!input) {
      return invalidRequest(c, "Send uri and placement: one of chat, artifacts or rail.");
    }
    const result = await setTemplatePlacement(db, id.data, input);
    if (result.ok) return c.json({ uri: result.uri, placement: result.placement });
    if (result.error === "not_found") return notFound(c);
    return c.json({ code: "not_found", message: "That connector has no such template." }, 404);
  });

  return app;
}
