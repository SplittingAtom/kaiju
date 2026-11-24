import type { MemoryPassFailureCode } from "@kaiju/protocol";
import { SYSTEM_ACTOR, type KaijuTx } from "@kaiju/db";
import { recordAudit } from "../../audit/record.js";
import type { LearningPassInput } from "./pass-input/assemble.js";

/**
 * The learning pass's audit rows (KOBE-393, SM28 `memory.pass.*`), each the last write of the
 * transaction that changes the pass row. Metadata only: ids, the model alias, the prompt version,
 * counts and a reason code, never a statement, quote, evidence or message text. Passes run on
 * BackgroundTasks (no request context), so the actor is stated: the person who started the pass,
 * or the system for the stale-pass sweep.
 */

interface PassRef {
  readonly teamId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly passId: string;
}

const person = (p: PassRef) => ({ kind: "user" as const, id: p.userId });

export function auditPassStarted(
  tx: KaijuTx,
  pass: PassRef & { readonly modelAlias: string; readonly promptVersion: string },
  input: Pick<LearningPassInput, "partial" | "truncated" | "summarised"> & {
    readonly entries: number;
  },
) {
  return recordAudit(tx, {
    action: "memory.pass.started",
    teamId: pass.teamId,
    actor: person(pass),
    target: {
      passId: pass.passId,
      threadId: pass.threadId,
      modelAlias: pass.modelAlias,
      extractorVersion: pass.promptVersion,
      entries: input.entries,
      partial: input.partial,
      truncated: input.truncated,
      summarised: input.summarised,
    },
  });
}

export interface PassCounts {
  readonly replied: number;
  readonly stored: number;
  readonly dropped: number;
  readonly skill_hints: number;
}

export function auditPassCompleted(
  tx: KaijuTx,
  pass: PassRef,
  counts: PassCounts,
  attempts: number,
) {
  return recordAudit(tx, {
    action: "memory.pass.completed",
    teamId: pass.teamId,
    actor: person(pass),
    target: {
      passId: pass.passId,
      threadId: pass.threadId,
      replied: counts.replied,
      stored: counts.stored,
      dropped: counts.dropped,
      skillHints: counts.skill_hints,
      attempts,
    },
  });
}

export function auditPassFailed(
  tx: KaijuTx,
  pass: PassRef,
  code: MemoryPassFailureCode | "interrupted",
  attempts: number,
) {
  return recordAudit(tx, {
    action: "memory.pass.failed",
    teamId: pass.teamId,
    actor: code === "interrupted" ? SYSTEM_ACTOR : person(pass),
    target: { passId: pass.passId, threadId: pass.threadId, reason: code, attempts },
  });
}
