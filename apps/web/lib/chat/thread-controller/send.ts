/**
 * Sending a message (D17): starts a run on an idle thread, otherwise it queues (KOBE-716: moved out
 * of `ThreadController`, which keeps the stream it opens).
 */
import type { ItemReference } from "@kobe/protocol";
import type { ApiError } from "../../api/client";
import type { AppContextWire } from "../api";
import type { MessageFiles } from "../attachments";
import { isBrowsing } from "../head";
import { newLiveRun } from "../live";
import { currentRunId } from "../thread-state";
import { viewingBody, type ViewingChoice } from "../viewing";
import type { ControllerPort } from "./port";

export const CLIENT_ERROR: ApiError = {
  status: 0,
  code: "client_error",
  message: "Your message was not sent. Try again.",
};

export type SendArgs = [
  text: string,
  parentEntryId?: string | undefined,
  attach?: MessageFiles | undefined,
  mentions?: readonly string[] | undefined,
  appContext?: readonly AppContextWire[] | undefined,
  skill?: string | undefined,
  viewing?: ViewingChoice | undefined,
  references?: readonly ItemReference[] | undefined,
];

/** What sending needs beyond the common port: keys, the run it started, its stream. */
export interface SendPort extends ControllerPort {
  newKey(): string;
  disposed(): boolean;
  /** A run this tab started: its whole stream is live, none of it history (KOBE-484). */
  ownRun(runId: string): void;
  /** Streams the run that just started (closing any other stream). */
  startStream(runId: string): void;
}

export async function sendMessage(port: SendPort, ...args: SendArgs): Promise<boolean> {
  const [text, parentEntryId, attach, mentions, appContext, skill, viewing, references] = args;
  const state = port.state();
  const threadId = state.threadId;
  // One message at a time: a second Enter before the server answered is not a second message.
  if (threadId === null || state.sending !== undefined) return false;
  const key = port.newKey();
  const queues = currentRunId(state) !== undefined;
  // From a browsed branch (CT3): the message continues the head, which makes it current.
  const head = state.head;
  // Continue from here (CT8): the answer's last entry, as an edit names its prompt's parent.
  const from = state.continueFrom;
  const explicit = parentEntryId ?? from;
  const parent = explicit ?? (isBrowsing(state) ? head : undefined);
  const branchFrom = parent ?? state.summary?.leafEntryId ?? null;
  const followups = state.followups;
  port.set((s) => ({
    ...s,
    // An edit from a browsed branch shows under the edited prompt (its new branch); a plain
    // send continues the head, which then settles once its run starts (`settleHead`).
    ...(explicit !== undefined && !queues ? { head: undefined } : {}),
    continueFrom: undefined,
    sending: { key, text, parentEntryId: branchFrom, queues, files: attach?.files },
    actionError: undefined,
    followups: undefined, // shown until the next send (KOBE-222)
    queuePaused: false, // sending releases a queue held by Stop
  }));
  const body = {
    content: text,
    parentEntryId: parent,
    fileIds: attach?.fileIds,
    mentions,
    appContext,
    skill,
    ...viewingBody(viewing),
    references,
  };
  let res = await port.api.sendMessage(threadId, body, key);
  if (!res.ok && res.error.status === 0) res = await port.api.sendMessage(threadId, body, key);
  if (port.disposed()) return res.ok;
  if (!res.ok) {
    // Nothing was sent: the follow-ups come back with the draft (review N2).
    port.set((s) => ({
      ...s,
      sending: undefined,
      followups: s.followups ?? followups,
      head: s.head ?? head,
      continueFrom: s.continueFrom ?? from,
    }));
    port.fail(res.error, text);
    return false;
  }
  const { runId, queued } = res.data;
  port.ownRun(runId);
  port.set((s) => ({
    ...s,
    // A queued message stays shown as "sending" until the queue read below lists it.
    sending: queued && s.sending ? { ...s.sending, runId } : undefined,
    announcement: queued ? "Message queued. It runs after the current one." : "Message sent.",
    announcementSeq: s.announcementSeq + 1,
    ...(queued
      ? {}
      : {
          live: { ...newLiveRun(runId), started: true },
          livePrompt: { text, parentEntryId: branchFrom, files: attach?.files },
          runs: [
            { runId, threadId, status: "running" as const, trigger: "user" as const },
            ...s.runs.filter((r) => r.status === "queued"),
          ],
        }),
  }));
  if (!queued) port.startStream(runId);
  await port.refresh();
  port.set((s) => (s.sending?.key === key ? { ...s, sending: undefined } : s));
  return true;
}

/** Steer now (D17): inject into the current run at Pi's next safe point; no run: a send. */
export async function steerRun(
  port: ControllerPort,
  text: string,
  mentions: readonly string[] | undefined,
  send: (...args: SendArgs) => Promise<boolean>,
): Promise<boolean> {
  const runId = currentRunId(port.state());
  if (runId === undefined) return send(text, undefined, undefined, mentions);
  const res = await port.busy("steer", () => port.api.steer(runId, text, mentions));
  if (!res.ok) {
    port.fail(res.error, text);
    return false;
  }
  port.announce("Sent to the running agent.");
  return true;
}
