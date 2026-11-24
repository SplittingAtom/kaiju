import { Hono } from "hono";
import { type TeamVariables } from "../../authz/middleware.js";
import { pinnedVersionIsDangerous } from "../../policy/dangerous-mode.js";
import { agentStatusOf, findPinnableAgent, latestPinnedVersion } from "../../agents/versions.js";
import { KOBE_ADMIN_RESULT_HIDDEN } from "@kobe/protocol";
import { readLineage } from "../../threads/lineage.js";
import { findToolOutput, readOffloadedOutput } from "../../threads/entry-output.js";
import { loadAdminResultGate } from "../../threads/admin-redaction.js";
import { findThread, summarizeOne } from "../../threads/repository.js";
import { entriesQuerySchema, entryIdSchema } from "../../threads/schemas.js";
import { threadCard } from "../../threads/card.js";
import { invalidRequest, param } from "../../http/request.js";
import { fail, parseQuery, readableEntries, threadIdParam, type ThreadKit } from "./shared.js";

/** Reading one thread: detail with entries, hover card, lineage, entry pages and a tool output. */
export function threadReadRoutes(kit: ThreadKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { deps, asViewer } = kit;

  app.get("/:id", async (c) => {
    const id = threadIdParam(c);
    const query = parseQuery(c, entriesQuerySchema);
    if (!id || !query) return invalidRequest(c);
    const detail = await asViewer(c, async (tx, viewer) => {
      const found = await findThread(tx, viewer, id);
      if (!found) return null;
      const page = await readableEntries(tx, viewer, found.thread.ownerUserId, id, query);
      const latest = await latestPinnedVersion(tx, { teamId: viewer.teamId, ...found.thread });
      // KOBE-44: the agent's model pin (KOBE-47 seam), which wins over the thread's `model`.
      const agentModel = await deps.runAgents.pinnedModel?.(tx, {
        teamId: viewer.teamId,
        ownerUserId: found.thread.ownerUserId,
        threadId: found.thread.id,
        agentScope: found.thread.agentScope,
        agentId: found.thread.agentId,
        agentVersion: found.thread.agentVersion,
      });
      const pinned = found.thread.agentId
        ? await findPinnableAgent(
            tx,
            {
              teamId: viewer.teamId,
              userId: found.thread.ownerUserId,
            },
            found.thread.agentId,
          )
        : null;
      return {
        ...(await summarizeOne(tx, viewer, found.thread)),
        read_only: found.access !== "owner",
        agent_name: pinned?.frontmatter.name ?? null,
        agent_status: pinned === null ? null : agentStatusOf(pinned),
        agent_dangerous: await pinnedVersionIsDangerous(tx, {
          teamId: viewer.teamId,
          scope: found.thread.agentScope,
          agentId: found.thread.agentId,
          version: found.thread.agentVersion,
        }),
        agent_current_version: latest,
        agent_model: agentModel ?? null,
        entries: page.entries,
        next_entries_after: page.nextAfter,
      };
    });
    return detail ? c.json(detail) : fail(c, "thread_not_found");
  });

  /** The rail's hover card (CE18, KOBE-219): read when the card opens. */
  app.get("/:id/card", async (c) => {
    const id = threadIdParam(c);
    if (!id) return invalidRequest(c);
    const card = await asViewer(c, (tx, viewer) => threadCard(tx, viewer, id));
    return card ? c.json(card) : fail(c, "thread_not_found");
  });

  /** The thread's family for the lineage strip (TL1, KOBE-533): read with the summary. */
  app.get("/:id/lineage", async (c) => {
    const id = threadIdParam(c);
    if (!id) return invalidRequest(c);
    const lineage = await asViewer(c, (tx, viewer) => readLineage(tx, viewer, id));
    return lineage ? c.json(lineage) : fail(c, "thread_not_found");
  });

  app.get("/:id/entries", async (c) => {
    const id = threadIdParam(c);
    const query = parseQuery(c, entriesQuerySchema);
    if (!id || !query) return invalidRequest(c);
    const page = await asViewer(c, async (tx, viewer) => {
      const found = await findThread(tx, viewer, id);
      if (!found) return null;
      return readableEntries(tx, viewer, found.thread.ownerUserId, id, query);
    });
    return page
      ? c.json({ entries: page.entries, next_entries_after: page.nextAfter })
      : fail(c, "thread_not_found");
  });

  /**
   * A tool result's full output (KOBE-208): the entry list trims outputs over 64 KB, so the chat
   * reads one here when its card opens; an offloaded body (D15) is read from the thread's own
   * object tree only. Whoever may read the thread (its owner, project readers once shared) may.
   */
  app.get("/:id/entries/:entryId/output", async (c) => {
    const id = threadIdParam(c);
    const entryId = param(c, "entryId", entryIdSchema);
    if (!id || !entryId.success) return invalidRequest(c);
    c.header("X-Content-Type-Options", "nosniff");
    const looked = await asViewer(c, async (tx, viewer) => {
      const thread = await findThread(tx, viewer, id);
      if (!thread) return { found: { kind: "thread_not_found" as const }, gate: undefined };
      return {
        found: await findToolOutput(tx, viewer.teamId, id, entryId.data),
        // KOBE-623 (KA6): a reader without the tool's permission gets no Kaiju admin output.
        gate: await loadAdminResultGate(tx, viewer, thread.thread.ownerUserId),
      };
    });
    const { found, gate } = looked;
    if (found.kind === "thread_not_found") return fail(c, "thread_not_found");
    if (found.kind === "missing") return fail(c, "entry_not_found");
    if (found.kind === "not_a_tool_output") return fail(c, "not_a_tool_output");
    const ids = { teamId: c.get("team").id, threadId: id, entryId: entryId.data };
    const output =
      found.kind === "inline"
        ? found.output
        : await readOffloadedOutput(deps.blobs, ids, found.blobRef, c.req.raw.signal);
    if (output === "not_a_tool_output") return fail(c, "not_a_tool_output");
    if (output === "busy" || output === "timed_out") return fail(c, "output_busy");
    if (typeof output === "string") return fail(c, "entry_unavailable");
    if (gate?.hides(output.tool_name)) {
      return c.json({
        entry_id: entryId.data,
        ...output,
        text: KOBE_ADMIN_RESULT_HIDDEN,
        truncated: false,
        admin_result_hidden: true,
      });
    }
    return c.json({ entry_id: entryId.data, ...output });
  });

  return app;
}
