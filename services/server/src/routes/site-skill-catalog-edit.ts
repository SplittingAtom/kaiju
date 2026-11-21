import { catalogSkillDraftRoutes } from "./site-skill-catalog-edit/drafts.js";
import { catalogDraftFileRoutes } from "./site-skill-catalog-edit/files.js";
import { catalogPublishRoutes } from "./site-skill-catalog-edit/publish.js";
import { catalogEditKit } from "./site-skill-catalog-edit/shared.js";
import { Hono } from "hono";
import type { AuthVariables } from "../auth/session.js";
import { requireSitePermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";

/**
 * The Site Console's catalog skill view and editor (KOBE-495), at
 * `/v1/site/skills/catalog-skills/:skillId`: `GET /` the skill (versions, Kobe state, draft),
 * `GET /versions/:id` and `/versions/:id/files/<path>` one version; the site draft at `/draft`
 * (`POST` starts it from a version, `GET`, `DELETE`, `/files/<path>` read, `PUT`, `DELETE` under
 * `If-Match: <rev>`, `/scan`, `/bump`, `POST /publish`); a Kobe skill's `/kobe/compare` and
 * `POST /kobe/reset`. Site Owner and Admins only: the session's role per request, and the
 * services re-check it in the transaction that writes.
 */
export function siteSkillCatalogEditRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireSitePermission("site.skills.catalog.manage"));
  // The groups mount in their original order, after the Site permission check.
  const kit = catalogEditKit(deps);
  app.route("/", catalogSkillDraftRoutes(kit));
  app.route("/", catalogDraftFileRoutes(kit));
  app.route("/", catalogPublishRoutes(kit));
  return app;
}
