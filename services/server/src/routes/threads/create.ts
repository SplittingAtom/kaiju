import { checkConnectorsOff, turnOffAtCreation } from "../../connectors/thread-connectors.js";
import { Hono } from "hono";
import { type TeamVariables } from "../../authz/middleware.js";
import { resolveAgentPin, resolveDraftPin } from "../../agents/versions.js";
import { projectDefaultAgent } from "../../projects/run-context.js";
import { canCreateInProject } from "../../threads/references.js";
import { mountCapRefusal } from "../../projects/mounts.js";
import { createThread } from "../../threads/repository.js";
import { createThreadBodySchema } from "../../threads/schemas.js";
import { isModelEnabled } from "../../models/team-store.js";
import { testChatStart } from "../../skills/drafts/test-chat.js";
import { invalidRequest, parseBody } from "../../http/request.js";
import { fail, tooManyMounts, type ThreadKit } from "./shared.js";

/** Starting a thread (`POST /`): its agent pin, project, model and connectors. */
export function threadCreateRoutes(kit: ThreadKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { deps, asViewer } = kit;

  app.post("/", async (c) => {
    const body = await parseBody(c, createThreadBodySchema);
    if (!body) {
      return invalidRequest(c, "Give agent_id, project_id, title, model and test only.");
    }
    const test = body.test === true;
    if (test && (!body.agent_id || body.project_id)) {
      return invalidRequest(c, "A test thread needs an agent_id and has no project.");
    }
    const draftId = body.skill_draft_id;
    if (draftId !== undefined && (test || body.project_id)) {
      return invalidRequest(c, "A Workbench test chat is not a builder test and has no project.");
    }
    const off = body.connectors_off ?? [];
    if (off.length > 0 && (test || draftId !== undefined)) {
      return invalidRequest(c, "A test conversation starts with every connector on.");
    }
    const actor = { userId: c.get("user").id, role: c.get("team").role };
    const result = await asViewer(c, async (tx, viewer) => {
      const projectId = body.project_id ?? null;
      if (projectId !== null && !(await canCreateInProject(tx, viewer, projectId))) {
        return "project_not_found" as const;
      }
      // MT3: a conversation in a project that is not open yet opens it, within the cap.
      const limit = projectId === null ? undefined : await mountCapRefusal(tx, viewer, projectId);
      if (limit !== undefined) return { tooManyMounts: limit } as const;
      // KOBE-323: a Workbench test chat talks to the Kobe agent about a draft the caller can see.
      const chat =
        draftId === undefined
          ? null
          : await testChatStart(tx, { ...viewer, role: actor.role }, draftId, body.agent_id);
      if (chat && !chat.ok) return chat.error;
      // D19: the thread pins the agent's current published version.
      // A test thread (KOBE-85) pins the agent's draft instead: only for those who can edit it.
      const pin = chat
        ? await resolveAgentPin(tx, viewer, chat.agentId)
        : test && body.agent_id
          ? await resolveDraftPin(tx, viewer, actor, body.agent_id)
          : await resolveAgentPin(
              tx,
              viewer,
              body.agent_id ?? (await projectDefaultAgent(tx, viewer, projectId)),
            );
      if (!pin.ok) return pin.error;
      const model = body.model ?? null;
      if (model !== null && !(await isModelEnabled(tx, viewer.teamId, model))) {
        return "model_not_enabled" as const;
      }
      // KOBE-451 review MEDIUM-3: connectors turned off before the first message, checked like
      // the toggle and written with the thread, so its first run already goes without them.
      const offRefused = await checkConnectorsOff(tx, viewer, off);
      if (offRefused !== null) return offRefused;
      const created = await createThread(tx, {
        teamId: viewer.teamId,
        ownerUserId: viewer.userId,
        projectId,
        agent: pin.value,
        isTest: test,
        ...(draftId === undefined ? {} : { skillDraftId: draftId }),
        title: body.title ?? null,
        modelAlias: model,
        thinkingLevel: body.thinking_level ?? null,
      });
      await turnOffAtCreation(tx, viewer, created.thread_id, off);
      return created;
    });
    if (typeof result === "string") return fail(c, result);
    if ("tooManyMounts" in result) return tooManyMounts(c, result.tooManyMounts);
    // MT1: the first conversation in a project mounts it (run start reconciles again).
    if (body.project_id) await deps.projectMounts.reconcileUser(c.get("team").id, c.get("user").id);
    return c.json(result, 201);
  });

  return app;
}
