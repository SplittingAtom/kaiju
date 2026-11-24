/**
 * The thread's settings for its next runs (model, agent and version, thinking level, sharing) and
 * Compact now: actions through the controller's port (KOBE-716).
 */
import type { ItemReference, ThinkingLevel } from "@kaiju/protocol";
import type { ApiError, ApiResult } from "../../api/client";
import type { CompactResult, ForkOptions } from "../api";
import { SHARED_ANNOUNCEMENT } from "../share";
import type { ThreadVisibility } from "../types";
import { planRegenerate, restoreFailure } from "./model-restore";
import type { ControllerPort } from "./port";
import { CLIENT_ERROR, type SendArgs } from "./send";

export const NO_THREAD: ApiError = {
  status: 0,
  code: "thread_not_found",
  message: "Send a message first: there is no conversation to compact.",
};

/** Saves the thread's model (null: the team default); refused unless the team enabled it. */
export async function setModel(port: ControllerPort, model: string | null): Promise<boolean> {
  const threadId = port.state().threadId;
  if (threadId === null) return false;
  const res = await port.busy("model", () => port.api.setThreadModel(threadId, model));
  if (!res.ok) {
    port.fail(res.error);
    return false;
  }
  port.set((s) => ({ ...s, summary: res.data }));
  port.announce(model === null ? "The team's default model is used." : "Model changed.");
  return true;
}

/** Moves the thread to its agent's current version (D19, U8, KOBE-420). */
export async function switchAgentVersion(port: ControllerPort): Promise<boolean> {
  const state = port.state();
  const threadId = state.threadId;
  const target = state.agentCurrentVersion;
  if (threadId === null || target == null || state.busy.includes("agent-version")) return false;
  const res = await port.busy("agent-version", () => port.api.switchAgentVersion(threadId, target));
  if (!res.ok) {
    port.fail(res.error);
    return false;
  }
  port.set((s) => ({ ...s, summary: res.data }));
  port.announce(`Switched to v${target}. Your next message uses it.`);
  // A version published meanwhile is offered next (the switch answer has no current version).
  void port.refresh();
  return true;
}

/** Gives this agentless thread the agent picked in the composer (KOBE-458 ac-3). */
export async function chooseAgent(
  port: ControllerPort,
  agent: { readonly id: string; readonly name: string },
): Promise<boolean> {
  const threadId = port.state().threadId;
  if (threadId === null || port.state().busy.includes("agent")) return false;
  const res = await port.busy("agent", () => port.api.chooseThreadAgent(threadId, agent.id));
  if (!res.ok) {
    port.fail(res.error);
    return false;
  }
  port.set((s) => ({ ...s, summary: res.data }));
  port.announce(`Chatting with ${agent.name}. Your next message uses it.`);
  // The read adds the agent's name, status and current version (the answer is a summary).
  void port.refresh();
  return true;
}

/** The thread's thinking level for its next runs (KOBE-260); null = the model's default. */
export async function setThinkingLevel(
  port: ControllerPort,
  level: ThinkingLevel | null,
): Promise<boolean> {
  const threadId = port.state().threadId;
  if (threadId === null) return false;
  const res = await port.busy("thinking", () => port.api.setThreadThinking(threadId, level));
  if (!res.ok) {
    port.fail(res.error);
    return false;
  }
  port.set((s) => ({ ...s, summary: res.data }));
  port.announce(
    level === null ? "The model's default thinking level is used." : `Thinking: ${level}.`,
  );
  return true;
}

/** Regenerate with another model (CE17, KOBE-217); see `ThreadController.regenerateWith`. */
export async function regenerateWith(
  port: ControllerPort,
  send: (...args: SendArgs) => Promise<boolean>,
  saveModel: (model: string | null) => Promise<boolean>,
  request: {
    readonly model: string | null;
    readonly text: string;
    readonly parentEntryId: string;
    readonly promptEntryId?: string | undefined;
    readonly references?: readonly ItemReference[] | undefined;
  },
): Promise<boolean> {
  const plan = planRegenerate(port.state(), request.model);
  if (plan === undefined) return false;
  try {
    // No await before these: each marks the thread busy at once (`model`, then `sending`).
    if (plan.switching && !(await saveModel(request.model))) return false;
    // The prompt's viewed file goes again, read anew (KOBE-467).
    const viewing =
      request.promptEntryId === undefined ? undefined : { fromEntry: request.promptEntryId };
    const sent = await send(
      request.text,
      request.parentEntryId,
      undefined,
      undefined,
      undefined,
      undefined,
      viewing,
      request.references,
    );
    if (sent) return true;
  } catch {
    port.fail(CLIENT_ERROR);
  }
  if (plan.switching) await restoreModel(port, plan.previous);
  return false;
}

/** Puts the thread's previous model back after a failed regenerate, keeping its error shown. */
async function restoreModel(port: ControllerPort, previous: string | null): Promise<void> {
  const threadId = port.state().threadId;
  const failure = restoreFailure(port.state());
  if (threadId !== null) {
    const res = await port.busy("model", () => port.api.setThreadModel(threadId, previous));
    if (res.ok) port.set((s) => ({ ...s, summary: res.data }));
  }
  port.set((s) => ({ ...s, actionError: failure }));
}

/** Shares the thread with its project or the team, or makes it private again (owner only). */
export async function setVisibility(
  port: ControllerPort,
  visibility: ThreadVisibility,
): Promise<boolean> {
  const threadId = port.state().threadId;
  if (threadId === null) return false;
  const res = await port.busy("share", () => port.api.shareThread(threadId, visibility));
  if (!res.ok) {
    port.fail(res.error);
    return false;
  }
  port.set((s) => ({ ...s, summary: { ...res.data, readOnly: false } }));
  port.announce(SHARED_ANNOUNCEMENT[visibility]);
  return true;
}

/** Compact now (CE15, KOBE-213); see `ThreadController.compact`. */
export async function compact(
  port: ControllerPort,
  focus?: string,
): Promise<ApiResult<CompactResult>> {
  const threadId = port.state().threadId;
  if (threadId === null) return { ok: false, error: NO_THREAD };
  const res = await port.busy("compact", () => port.api.compactThread(threadId, focus));
  if (res.ok) port.announce("The conversation was compacted.");
  else port.fail(res.error);
  await port.refresh();
  return res;
}

/** Forks the thread; a refusal is the caller's to show, not the thread's error banner. */
export async function fork(
  port: ControllerPort,
  options?: ForkOptions,
): Promise<ApiResult<{ threadId: string }>> {
  const threadId = port.state().threadId;
  if (threadId === null) return { ok: false, error: NO_THREAD };
  return port.busy("fork", () => port.api.forkThread(threadId, options));
}
