import type { ThreadContextResult } from "@kaiju/protocol";
import { sealReply } from "@kaiju/protocol/node";
import { fromCapture, fromSession, readCapture } from "../context/assemble.js";
import { replaySession } from "../context/session-replay.js";
import { SessionRestore, ensureSessionDir } from "../pi/session-files.js";
import type { Frame, ManagerPort } from "./manager-options.js";
import {
  PI_REQUEST_TIMEOUT_MS,
  PI_SLOW_REQUEST_TIMEOUT_MS,
  SLOW_COMMANDS,
  fileExists,
  piFailure,
} from "./manager-util.js";
import { fail, ok, type CommandOutcome } from "./outcome.js";
import type { Thread } from "./thread.js";

// `pi.command`, `thread.context` and `session.restore` for `ThreadManager`.

export async function runPiCommand(
  port: ManagerPort,
  thread: Thread,
  frame: Frame<"pi.command">,
): Promise<CommandOutcome> {
  const { id: _serverId, ...command } = frame.command;
  // Never starts a Pi while the sandbox drains (KOBE-733: nothing may start between the quiet
  // check, the final scan and the reclaim proof).
  if (port.draining()) return fail("pi_unavailable", "sandbox is shutting down");
  if (thread.restoring) return fail("pi_rejected", "session restore in progress");
  // Nothing reaches Pi around a compaction in progress (KOBE-213); its entry is read after it.
  if (thread.compacting) return fail("pi_rejected", "the thread is compacting");
  if (
    command.type === "get_entries" &&
    command.since === undefined &&
    !(await fileExists(port.sessionFile(thread.id)))
  ) {
    // KOBE-258: Pi 1.0.0 keeps a new session's setup entries (model, thinking level) in memory
    // until the first user message. Reported, they would be mirrored, and the thread's next Pi
    // (restarted for a run's config) makes new ones with other ids: `get_entries since` then
    // fails for good. Before the file exists nothing is durable, so nothing is reported.
    return ok({ entries: [], leafId: null });
  }
  const prepared = await thread.withLock(() => port.ensureProcess(thread, undefined));
  if (prepared !== undefined) return prepared;
  // KOBE-169: no pi.command runs against config a tool planted (the plant could be gone again by
  // the next prompt, so check before and after). The allow-list has no command that selects a
  // model from Pi's catalog (set_model is gone; model choice is run.start's), this is the second line.
  {
    const before = await thread.verifyRuntime();
    if (before !== undefined) {
      await thread.stopTampered(before, command.type);
      return fail("runtime_tampered", before);
    }
  }
  try {
    const timeout = SLOW_COMMANDS.has(command.type)
      ? PI_SLOW_REQUEST_TIMEOUT_MS
      : PI_REQUEST_TIMEOUT_MS;
    const response = await thread.request(command, timeout);
    const after = await thread.verifyRuntime();
    if (after !== undefined) {
      await thread.stopTampered(after, command.type);
      return fail("runtime_tampered", after);
    }
    return response.success ? ok(response.data) : fail("pi_rejected", response.error);
  } catch (error) {
    return piFailure(error);
  }
}

export async function readContext(
  port: ManagerPort,
  thread: Thread,
  frame: Frame<"thread.context">,
): Promise<CommandOutcome> {
  if (thread.restoring) return fail("pi_rejected", "session restore in progress");
  if (thread.compacting) return fail("pi_rejected", "the thread is compacting");
  const file = thread.contextFile;
  const capture = file === undefined ? undefined : await readCapture(file);
  // Sealed to the requesting server process (CV8): the command row only ever holds ciphertext.
  const sealed = (result: ThreadContextResult) =>
    ok({ sealed: sealReply(frame.reply_key, JSON.stringify(result), frame.thread_id) });
  if (capture !== undefined) {
    return sealed(fromCapture(capture, thread.promptParts, frame.max_bytes));
  }
  let call;
  try {
    call = await replaySession(port.sessionFile(thread.id));
  } catch {
    // Fixed text: nothing of the file (or its path) reaches the server or its logs.
    return fail("internal", "the session could not be read");
  }
  return sealed(fromSession(call, null, frame.max_bytes));
}

export async function restoreSession(
  port: ManagerPort,
  thread: Thread,
  frame: Frame<"session.restore">,
): Promise<CommandOutcome> {
  if (thread.runId !== undefined) return fail("pi_rejected", "thread has an active run");
  return thread.withLock(async () => {
    if (thread.runId !== undefined) return fail("pi_rejected", "thread has an active run");
    if (frame.part === 0) {
      await thread.stopProcess();
      await ensureSessionDir(port.options.sessionDir, {
        shared: port.options.identities !== undefined,
        workspaceDir: port.options.workspaceDir,
      });
      await port.restores.get(thread.id)?.abort();
      port.restores.set(
        thread.id,
        new SessionRestore(
          port.sessionFile(thread.id),
          port.options.restoreMaxBytes,
          port.options.workspaceDir,
        ),
      );
      thread.restoring = true;
    }
    const restore = port.restores.get(thread.id);
    if (restore === undefined) return fail("pi_rejected", "no restore in progress (part 0 first)");
    try {
      // Pi refuses a session whose stored cwd does not exist (verified 1.0.0): the restored
      // session belongs to this sandbox's workspace, whatever the server's copy says.
      const header =
        frame.header === undefined
          ? undefined
          : { ...frame.header, cwd: port.options.workspaceDir };
      const entries = await restore.writePart(frame.part, header, frame.entries, () =>
        port.defaultHeader(thread.id),
      );
      if (!frame.final) return ok({ part: frame.part, entries });
      const total = await restore.commit();
      port.endRestore(thread);
      return ok({ restored: true, entries: total });
    } catch (error) {
      await restore.abort();
      port.endRestore(thread);
      return fail("internal", `session restore failed: ${(error as Error).message}`);
    }
  });
}
