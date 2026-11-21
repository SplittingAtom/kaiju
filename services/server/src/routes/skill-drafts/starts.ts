import { Hono } from "hono";
import type { TeamVariables } from "../../authz/middleware.js";
import { hitRateLimit } from "../../rate-limit.js";
import { SKILL_UPLOAD_RATE } from "../../skills/limits.js";
import { createBlankDraft } from "../../skills/drafts/service.js";
import { startFromTemplate, type StartResult } from "../../skills/drafts/starts.js";
import { saveWorkspaceSkill } from "../../skills/drafts/from-workspace.js";
import { startFork } from "../../skills/drafts/fork.js";
import type { WorkspaceSync } from "../../workspace-sync/index.js";
import {
  NO_DRAFTS,
  createSchema,
  draftJson,
  error,
  forkSchema,
  fromWorkspaceSchema,
  type DraftKit,
} from "./shared.js";

/** Starting a draft (KOBE-322): blank or from a template, a fork, or Save to Workbench. */
export function draftStartRoutes(
  kit: DraftKit,
  workspace: WorkspaceSync | undefined,
): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { deps, db, skillStore, ctxOf, json, mayStart, started } = kit;

  // A blank draft, or one from a template (KOBE-322, SK10).
  app.post("/", async (c) => {
    if (!mayStart(c)) return error(c, 403, "forbidden", NO_DRAFTS);
    const body = createSchema.safeParse(await json(c));
    if (!body.success)
      return error(
        c,
        400,
        "invalid_request",
        "Give a name (lowercase letters, digits, hyphens) and, optionally, a template.",
      );
    const { name, template } = body.data;
    return started(
      c,
      template
        ? await startFromTemplate(ctxOf(c), template, name)
        : await createBlankDraft(ctxOf(c), name),
    );
  });

  // Fork (KOBE-322): a copy of a team, own personal or installed catalog version; the parent is
  // recorded from the version copied. Forking a skill under its own name is how it is edited.
  app.post("/fork", async (c) => {
    if (!mayStart(c)) return error(c, 403, "forbidden", NO_DRAFTS);
    const body = forkSchema.safeParse(await json(c));
    if (!body.success)
      return error(
        c,
        400,
        "invalid_request",
        "Give source {kind, skillId, version or semver} and, optionally, a name.",
      );
    const store = skillStore();
    if (!store || !deps.blobs)
      return error(c, 503, "skills_unavailable", "Skill storage is not configured.");
    // A fork reads, verifies and unzips a package: the same rate as the other heavy starts.
    if (!(await hitRateLimit(db, `skill-upload:${c.get("user").id}`, SKILL_UPLOAD_RATE)))
      return error(c, 429, "rate_limited", "Too many copies. Wait a few minutes and try again.");
    const result = await startFork(
      ctxOf(c),
      { store, blobs: deps.blobs },
      body.data.source,
      body.data.name,
    );
    if (!result.ok && result.error === "source_not_found")
      return error(c, 404, "not_found", "No such skill version to copy.");
    if (!result.ok && result.error === "source_unavailable")
      return error(c, 409, "source_unavailable", "That version's files can't be copied yet.");
    if (!result.ok && result.error === "blocklisted")
      return error(c, 422, "skill_blocklisted", "That version is on the site's blocklist.");
    return started(c, result as StartResult);
  });

  // Save to Workbench (KOBE-322): `/workspace/skills/<folder>/` from a conversation of this team.
  app.post("/from-workspace", async (c) => {
    if (!mayStart(c)) return error(c, 403, "forbidden", NO_DRAFTS);
    if (!workspace)
      return error(c, 503, "workspace_unavailable", "Workspace files are not available here.");
    const body = fromWorkspaceSchema.safeParse(await json(c));
    if (!body.success)
      return error(c, 400, "invalid_request", "Give threadId and folder (a skill name).");
    if (!(await hitRateLimit(db, `skill-upload:${c.get("user").id}`, SKILL_UPLOAD_RATE)))
      return error(c, 429, "rate_limited", "Too many saves. Wait a few minutes and try again.");
    const result = await saveWorkspaceSkill(ctxOf(c), workspace, body.data);
    if (!result.ok && result.error === "thread_not_found")
      return error(c, 404, "not_found", "No such conversation.");
    if (!result.ok && result.error === "folder_empty")
      return error(
        c,
        404,
        "folder_empty",
        `/workspace/skills/${body.data.folder}/ has no saved files yet.`,
      );
    if (!result.ok && result.error === "folder_changed")
      return error(c, 409, "folder_changed", "The folder changed while saving. Save again.");
    if (result.ok && result.created === false)
      return c.json({ draft: draftJson(result.draft, c.get("user").id), created: false });
    return started(c, result as StartResult);
  });

  return app;
}
