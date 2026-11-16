import type { KobeTx } from "@kobe/db";
import { registerMemoryReminder } from "../../notifications/memory.js";
import type { MemoryWho } from "../items/who.js";

/** To review lives in a Workspace: the request's active one (the routes require it). */
export function workspaceOf(who: MemoryWho): string {
  if (who.teamId === null) throw new Error("To review needs an active workspace");
  return who.teamId;
}

/** Undo reopened a candidate of the pass: its reminder is owed again (idempotent). */
export function noticeOpenAgain(
  tx: KobeTx,
  teamId: string,
  userId: string,
  passId: string,
): Promise<void> {
  return registerMemoryReminder(tx, teamId, {
    objectId: passId,
    about: null,
    recipients: [userId],
  });
}
