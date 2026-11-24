import { Hono } from "hono";
import { type TeamVariables } from "../../authz/middleware.js";
import {
  forkThreadRequestSchema,
  LABEL_WRITE_RATE,
  LEAF_RATE,
  setLabelBodySchema,
  shareThreadRequestSchema,
} from "@kaiju/protocol";
import { readBranches, setLabel } from "../../threads/branches.js";
import { readThreadBlocked } from "../../egress/thread-blocked.js";
import { FORK_RATE, forkThread } from "../../threads/fork.js";
import { hitRateLimit } from "../../rate-limit.js";
import {
  isLockTimeout,
  setLeaf,
  switchAgentVersion,
  updateThread,
} from "../../threads/repository.js";
import {
  entryIdSchema,
  setLeafBodySchema,
  switchAgentVersionBodySchema,
  chooseThreadAgentBodySchema,
  updateThreadBodySchema,
} from "../../threads/schemas.js";
import { chooseThreadAgent } from "../../threads/choose-agent.js";
import { invalidRequest, param, parseBody } from "../../http/request.js";
import { fail, rateLimited, failLabel, threadIdParam, type ThreadKit } from "./shared.js";

/** Changing a thread: rename and share, fork, branches and labels, agent and version. */
export function threadEditRoutes(kit: ThreadKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { deps, db, asViewer, change } = kit;

  app.patch("/:id", async (c) => {
    const id = threadIdParam(c);
    const body = await parseBody(c, updateThreadBodySchema);
    if (!id || !body) return invalidRequest(c, "Give title, shared_to_project and/or model.");
    return change(c, (tx, viewer) => updateThread(tx, viewer, id, body));
  });

  app.post("/:id/share", async (c) => {
    const id = threadIdParam(c);
    const body = await parseBody(c, shareThreadRequestSchema);
    if (!id || !body) return invalidRequest(c, "Give visibility: private, project or team.");
    return change(c, (tx, viewer) => updateThread(tx, viewer, id, { visibility: body.visibility }));
  });

  app.post("/:id/fork", async (c) => {
    const id = threadIdParam(c);
    const body = await parseBody(c, forkThreadRequestSchema);
    if (!id || !body) return invalidRequest(c, "Give entry_id and/or title (or {}).");
    if (!(await hitRateLimit(db, `thread-fork:${c.get("user").id}`, FORK_RATE))) {
      return fail(c, "rate_limited");
    }
    const result = await forkThread((fn) => asViewer(c, fn), deps.blobs, id, {
      entryId: body.entry_id,
      title: body.title,
      quotaDefaultBytes: deps.appResults.store.defaultQuotaBytes,
    });
    if (!result.ok) return fail(c, result.error);
    // A fork into the project keeps it open for the caller (MT1).
    await deps.projectMounts.reconcileUser(c.get("team").id, c.get("user").id);
    return c.json({ thread_id: result.thread.thread_id }, 201);
  });

  /**
   * Make a branch current (CT3): owner only, refused while any run is running, waiting or queued
   * and in Trash; {@link LEAF_RATE} per member.
   */
  app.post("/:id/leaf", async (c) => {
    const id = threadIdParam(c);
    const body = await parseBody(c, setLeafBodySchema);
    if (!id || !body) return invalidRequest(c, "Give the entry_id to continue from.");
    if (!(await hitRateLimit(db, `thread-leaf:${c.get("user").id}`, LEAF_RATE))) {
      return rateLimited(c, "Too many branch switches. Wait a few minutes and try again.");
    }
    return change(c, (tx, viewer) => setLeaf(tx, viewer, id, body.entry_id));
  });

  /** The tree's labels and remembered-rule runs (CT2): for whoever may read the thread. */
  app.get("/:id/branches", async (c) => {
    const id = threadIdParam(c);
    if (!id) return invalidRequest(c);
    const branches = await asViewer(c, (tx, viewer) => readBranches(tx, viewer, id));
    return branches ? c.json(branches) : fail(c, "thread_not_found");
  });

  /** The thread's blocked-egress cards per run (KOBE-605): for whoever may read the thread. */
  app.get("/:id/egress-blocked", async (c) => {
    const id = threadIdParam(c);
    if (!id) return invalidRequest(c);
    const blocked = await asViewer(c, (tx, viewer) => readThreadBlocked(tx, viewer, id));
    return blocked ? c.json(blocked) : fail(c, "thread_not_found");
  });

  /** Label a node (CT9): owner only; `null` removes; idempotent, never activity, not audited. */
  app.put("/:id/labels/:entryId", async (c) => {
    const id = threadIdParam(c);
    const entryId = param(c, "entryId", entryIdSchema);
    const body = await parseBody(c, setLabelBodySchema);
    if (!id || !entryId.success || !body) {
      return invalidRequest(c, "Give label: 1-60 characters on one line, or null to remove it.");
    }
    if (!(await hitRateLimit(db, `thread-label:${c.get("user").id}`, LABEL_WRITE_RATE))) {
      return rateLimited(c, "Too many label changes. Wait a few minutes and try again.");
    }
    try {
      const result = await asViewer(c, (tx, viewer) =>
        setLabel(tx, viewer, id, entryId.data, body.label),
      );
      return result.ok ? c.json(result.branches) : failLabel(c, result.error);
    } catch (err) {
      if (isLockTimeout(err)) return fail(c, "thread_busy");
      throw err;
    }
  });

  app.post("/:id/agent-version", async (c) => {
    const id = threadIdParam(c);
    const body = await parseBody(c, switchAgentVersionBodySchema);
    if (!id || !body) return invalidRequest(c, "Give the version to switch to, or nothing.");
    return change(c, (tx, viewer) => switchAgentVersion(tx, viewer, id, body.version));
  });

  app.post("/:id/agent", async (c) => {
    const id = threadIdParam(c);
    const body = await parseBody(c, chooseThreadAgentBodySchema);
    if (!id || !body) return invalidRequest(c, "Give the agent_id to chat with.");
    return change(c, (tx, viewer) => chooseThreadAgent(tx, viewer, id, body.agent_id));
  });

  return app;
}
