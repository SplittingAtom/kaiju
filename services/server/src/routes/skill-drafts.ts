import { Hono } from "hono";
import { requireTeam, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import type { ImportDeps } from "../skills/import/service.js";
import type { WorkspaceSync } from "../workspace-sync/index.js";
import { draftEditRoutes } from "./skill-drafts/edits.js";
import { draftManifestRoutes } from "./skill-drafts/manifest.js";
import { draftSaveRoutes } from "./skill-drafts/saves.js";
import { draftKit } from "./skill-drafts/shared.js";
import { draftStartRoutes } from "./skill-drafts/starts.js";
import { draftImportRoutes } from "./skill-drafts/uploads.js";

export { draftJson, readBounded } from "./skill-drafts/shared.js";

/**
 * Workbench drafts (KOBE-320, spec SK11) in the active team. `POST /` starts a blank draft;
 * `GET /` lists the caller's drafts and, for Builders and Team admins, the team's shared ones;
 * `GET /:id` and `GET /:id/files/<path>` read; `PUT` and `DELETE /:id/files/<path>` and
 * `PATCH /:id` (`shared`) change it under `If-Match: <rev>` (missing: 428; stale: 409 with who
 * changed it); `DELETE /:id` removes it (author only); `POST /:id/versions` saves it as a version
 * (destination team or personal, semver, changelog). `GET /:id/scan` is the live scan preview
 * and `GET /:id/bump?destination=` the suggested semver bump (KOBE-321). A draft the caller may
 * not see is a 404.
 */
export function skillDraftRoutes(
  deps: ServerDeps,
  /** The workspace store (Save to Workbench reads the caller's `/workspace/skills/<name>/`). */
  workspace?: WorkspaceSync,
  /** Governed import's fetcher (KOBE-344): through the egress proxy; absent: 503. */
  imports?: ImportDeps,
): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  // One kit (and skill store) per router; the groups mount in their original order.
  const kit = draftKit(deps);
  app.route("/", draftStartRoutes(kit, workspace));
  app.route("/", draftImportRoutes(kit, imports));
  app.route("/", draftEditRoutes(kit));
  app.route("/", draftManifestRoutes(kit));
  app.route("/", draftSaveRoutes(kit));
  return app;
}
