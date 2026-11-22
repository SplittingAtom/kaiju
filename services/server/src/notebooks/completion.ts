import {
  NOTEBOOK_COMPLETE_TIMEOUT_MS,
  notebookCompletionResultSchema,
  type ActorContext,
  type NotebookCompletionBody,
  type NotebookCompletionResult,
} from "@kobe/protocol";
import { hitRateLimit, type RateLimitRule } from "../rate-limit.js";
import { RunError } from "../runs/errors.js";
import { COMMAND_FAILURES } from "../sandbox-wire/types.js";
import { findThread } from "../threads/queries.js";
import { NotebookRunError, type NotebookRunHost } from "./user-run.js";

/**
 * The code editor's kernel completion (KOBE-808): completions at the cursor, or a dotted name's
 * signature and docstring, from the thread's running kernel in the member's own sandbox. Decided
 * like the variables snapshot (KOBE-803): the owner only (account active, still a member),
 * sandboxes allowed (isolation present), eval threads refused by the route, rate limited per
 * member; the delivering replica sends it only to the member's own sandbox, never an eval sandbox,
 * and only to an agent with `notebooks` and `notebook_complete`. It never wakes the sandbox and
 * never starts a kernel: the states without an answer (`asleep`, `no_kernel`, `busy`,
 * `unsupported`, `unavailable`) are 200 answers, so the editor falls back to its own completion
 * quietly. Nothing is stored or logged with the code: no event, no audit; the command row holding
 * it is deleted when the answer is read (or swept within a minute).
 */
/**
 * Requests per member per minute (the coordinator's number, KOBE-808): sized for typing with the
 * editor's debounce; past it the editor quietly falls back to its own completion.
 */
export const COMPLETION_RATE_LIMIT: RateLimitRule = { windowMs: 60_000, max: 600 };
/** The trip there and back on top of the agent's own wait. */
const COMPLETION_COMMAND_MARGIN_MS = 500;

type Host = Pick<
  NotebookRunHost,
  "db" | "router" | "log" | "isolationMissing" | "threadTx" | "assertMayRun"
>;

export async function notebookComplete(
  host: Host,
  actor: ActorContext,
  threadId: string,
  body: NotebookCompletionBody,
): Promise<NotebookCompletionResult> {
  if (host.isolationMissing()) {
    throw new NotebookRunError("isolation_unavailable", "Sandboxes are unavailable right now.");
  }
  // Ownership without the thread lock: a completion changes nothing and must not queue behind runs.
  await host.threadTx(actor, async (tx, viewer) => {
    const found = await findThread(tx, viewer, threadId);
    if (!found) throw new RunError("thread_not_found");
    if (found.access !== "owner") throw new RunError("read_only");
    if (found.thread.deletedAt !== null) throw new RunError("thread_in_trash");
    await host.assertMayRun(tx, actor);
  });
  if (!(await hitRateLimit(host.db, `notebook-complete:${actor.user_id}`, COMPLETION_RATE_LIMIT))) {
    throw new NotebookRunError("rate_limited", "Too many completion requests; wait a minute.");
  }
  const target = { teamId: actor.team_id, userId: actor.user_id };
  if (!(await host.router.isConnected(target, threadId))) return { status: "asleep" };
  const outcome = await host.router.notebookComplete(
    target,
    { threadId, timeoutMs: NOTEBOOK_COMPLETE_TIMEOUT_MS, ...body },
    { timeoutMs: NOTEBOOK_COMPLETE_TIMEOUT_MS + COMPLETION_COMMAND_MARGIN_MS },
  );
  if (!outcome.ok) return failed(host, threadId, outcome.error.code);
  const parsed = notebookCompletionResultSchema.safeParse(outcome.data);
  if (!parsed.success || (parsed.data.status === "ok" && parsed.data.op !== body.op)) {
    host.log.warn({ thread_id: threadId, op: body.op }, "the sandbox sent a malformed completion");
    return { status: "unavailable" };
  }
  return parsed.data;
}

/** A failed command as an answer: the editor shows why and keeps its own completion. */
function failed(host: Host, threadId: string, code: string): NotebookCompletionResult {
  if (code === COMMAND_FAILURES.notConnected) return { status: "asleep" };
  // An older agent (or, in a rolling deploy, an older replica holding the connection that can't
  // read the frame: `invalid_command`), or one that runs no kernels.
  if (
    code === COMMAND_FAILURES.completeUnsupported ||
    code === COMMAND_FAILURES.inspectUnsupported ||
    code === "notebooks_unsupported" ||
    code === "invalid_command"
  ) {
    return { status: "unsupported" };
  }
  if (code !== COMMAND_FAILURES.timeout) {
    host.log.warn({ code, thread_id: threadId }, "notebook completion failed");
  }
  return { status: "unavailable" };
}
