import { Hono } from "hono";
import {
  commitFromProposalRequestSchema,
  commitProjectRequestSchema,
  projectHistoryQuerySchema,
} from "@kobe/protocol";
import { type TeamVariables } from "../../authz/middleware.js";
import { commitProject } from "../../git/repo-commit/dispatch.js";
import { commitProposal } from "../../projects/from-proposal.js";
import { commitDetail, historyPage } from "../../projects/history.js";
import { invalidRequest, param, parseBody } from "../../http/request.js";
import {
  idParam,
  seqParam,
  notFound,
  commitAnswer,
  proposalAnswer,
  type CommitKit,
} from "./shared.js";

/** Committing (also from an accepted proposal) and reading the history. */
export function projectCommitWriteRoutes(kit: CommitKit): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const { owner, commitDeps, repoCommit, withProject } = kit;

  app.post("/:id/commit", async (c) => {
    const id = param(c, "id", idParam);
    if (!id.success) return notFound(c);
    const body = await parseBody(c, commitProjectRequestSchema);
    if (!body) return invalidRequest(c, "Give a message (1 to 500 characters).");
    const viewer = owner(c);
    // KOBE-767: a Repo's commit goes to its git host (pull request, or the default branch).
    const result = await commitProject(commitDeps(), repoCommit(), {
      owner: viewer,
      projectId: id.data,
      message: body.message,
      author: { userId: viewer.userId, kind: "user" },
    });
    return commitAnswer(c, result);
  });

  /**
   * PE4-PE6 (KOBE-591): the thread's owner accepts an agent's proposal for a file of the
   * conversation's project; the recorded content is committed (never content from the request).
   */
  app.post("/:id/commits/from-proposal", async (c) => {
    const id = param(c, "id", idParam);
    if (!id.success) return notFound(c);
    const body = await parseBody(c, commitFromProposalRequestSchema);
    if (!body) {
      return invalidRequest(
        c,
        "Give thread_id and proposal_id, and optionally a message (1 to 500 characters).",
      );
    }
    const result = await commitProposal(commitDeps(), {
      owner: owner(c),
      projectId: id.data,
      threadId: body.thread_id,
      proposalId: body.proposal_id,
      message: body.message,
    });
    return proposalAnswer(c, result);
  });

  app.get("/:id/commits", async (c) => {
    const query = projectHistoryQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidRequest(c, "before and limit must be positive integers.");
    return withProject(c, "view", async (tx, access) =>
      c.json(
        await historyPage(
          tx,
          access.project.teamId,
          access.project.id,
          query.data.before,
          query.data.limit,
        ),
      ),
    );
  });

  app.get("/:id/commits/:seq", (c) => {
    const seq = param(c, "seq", seqParam);
    if (!seq.success) return Promise.resolve(commitAnswer(c, { status: "commit_not_found" }));
    return withProject(c, "view", async (tx, access) => {
      const detail = await commitDetail(tx, access.project.teamId, access.project.id, seq.data);
      return detail ? c.json(detail) : commitAnswer(c, { status: "commit_not_found" });
    });
  });

  return app;
}
