import {
  NOTEBOOK_INSPECT_TIMEOUT_MS,
  notebookInspectResultSchema,
  type ActorContext,
  type NotebookVariablesResult,
} from "@kobe/protocol";
import { hitRateLimit } from "../rate-limit.js";
import { lockOwnedThread } from "../runs/access.js";
import { COMMAND_FAILURES } from "../sandbox-wire/types.js";
import { NotebookRunError, type NotebookRunHost } from "./user-run.js";

/**
 * The editor's Variables tab (KOBE-803): a fresh snapshot of the thread kernel's user variables.
 * Decided like a Run (the owner only, account active and still a member, sandboxes allowed:
 * isolation present; eval threads are refused by the route; the delivering replica sends
 * `notebook.inspect` only to the member's own sandbox, never an eval sandbox, and only to an
 * agent with `notebooks` and `notebook_inspect`). It runs introspection code in the member's own
 * kernel, silently (no execution count, not a run, no event), so it never wakes a sandbox and
 * never starts a kernel: without a live connection the answer is `no_kernel`. Nothing is stored
 * (no event, no audit of values) and the snapshot goes to the owner only: a repr can hold a secret.
 * The agent keeps the snapshot it took after the member's last run and answers from it while code
 * runs (`stale`) or when nothing ran since; `refresh` asks for a fresh one when the kernel is idle.
 * KOBE-816: the sandbox withholds values of credential-like names (`hidden`); `show` (the owner's
 * Show) asks for that one variable, not withheld, through the same owner-only path.
 */
/** Snapshots per member per minute: each runs code in their kernel. */
export const VARIABLES_RATE_LIMIT = { windowMs: 60_000, max: 60 };
/** The agent's own wait plus the trip there and back. */
const VARIABLES_COMMAND_MARGIN_MS = 5_000;

type Host = Pick<
  NotebookRunHost,
  "db" | "router" | "log" | "isolationMissing" | "threadTx" | "assertMayRun"
>;

export async function notebookVariables(
  host: Host,
  actor: ActorContext,
  threadId: string,
  refresh = false,
  show?: string,
): Promise<NotebookVariablesResult> {
  if (host.isolationMissing()) {
    throw new NotebookRunError("isolation_unavailable", "Sandboxes are unavailable right now.");
  }
  await host.threadTx(actor, async (tx, viewer) => {
    await lockOwnedThread(tx, viewer, threadId, "thread_not_found");
    await host.assertMayRun(tx, actor);
  });
  if (!(await hitRateLimit(host.db, `notebook-variables:${actor.user_id}`, VARIABLES_RATE_LIMIT))) {
    throw new NotebookRunError("rate_limited", "Too many variable refreshes; wait a minute.");
  }
  const target = { teamId: actor.team_id, userId: actor.user_id };
  // That a snapshot was asked for is logged; its content never is, nor stored anywhere.
  // KOBE-816: whether a Show was asked is logged, never which variable or its value.
  host.log.info(
    { thread_id: threadId, refresh, show: show !== undefined },
    "notebook variables requested",
  );
  if (!(await host.router.isConnected(target, threadId))) return { status: "no_kernel" };
  const outcome = await host.router.notebookInspect(
    target,
    { threadId, timeoutMs: NOTEBOOK_INSPECT_TIMEOUT_MS, refresh, ...(show ? { show } : {}) },
    { timeoutMs: NOTEBOOK_INSPECT_TIMEOUT_MS + VARIABLES_COMMAND_MARGIN_MS },
  );
  if (!outcome.ok) {
    const code = outcome.error.code;
    if (code === COMMAND_FAILURES.notConnected) return { status: "no_kernel" };
    // `invalid_command`: an older replica holds the connection (rolling deploy) and can't read
    // the command; as for an older agent, not available yet.
    if (code === COMMAND_FAILURES.inspectUnsupported || code === "invalid_command") {
      throw new NotebookRunError(
        "variables_unsupported",
        "Variables are not available on this sandbox yet.",
      );
    }
    if (code === "notebooks_unsupported") {
      throw new NotebookRunError("notebooks_unsupported", "This workspace runs no notebooks yet.");
    }
    host.log.warn({ code, thread_id: threadId }, "notebook variables snapshot failed");
    if (code === COMMAND_FAILURES.timeout) return { status: "unavailable" };
    throw new NotebookRunError("sandbox_unavailable", "Your workspace did not answer; try again.");
  }
  const parsed = notebookInspectResultSchema.safeParse(outcome.data);
  if (!parsed.success) {
    host.log.warn({ thread_id: threadId }, "the sandbox sent a malformed variables snapshot");
    return { status: "unavailable" };
  }
  return parsed.data;
}
