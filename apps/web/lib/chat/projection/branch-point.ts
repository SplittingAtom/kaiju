/** Where a new version of a prompt branches from (KOBE-716: out of `lib/chat/tree.ts`). */
import {
  splitAppContext,
  splitItemReferences,
  splitSkillRequest,
  type ItemReference,
} from "@kobe/protocol";
import { messageMeta, type KobeMessageMeta, type Projection } from "./types";
/**
 * Where a new version of the prompt `messageId` branches from (Edit, Regenerate): its entry's
 * parent. For the first prompt that is Pi's root settings entry, so the new version is a sibling
 * root (KOBE-214). Undefined for an answer, a prompt Pi hasn't saved, one with no entry above it
 * (`parent_entry_id` can't name the root itself), or one whose parent isn't loaded here (the new
 * version could not be placed beside it).
 */
/** A branch point: where it branches from, the member's text and the skill it was sent with. */
export interface BranchPoint {
  readonly parentEntryId: string;
  /** The prompt's own entry: a regenerate names it so its run's viewed file goes again (KOBE-467). */
  readonly promptEntryId?: string | undefined;
  readonly text: string;
  readonly skill?: string | undefined;
  /** App items it referenced (KOBE-490), sent again as references. */
  readonly references?: readonly ItemReference[] | undefined;
}

/**
 * The server's skill line (KOBE-451) out of a user message's text, kept after any app context
 * (which stays in the text, as sent): the member's text and the skill, null when none.
 */
export function withoutSkillLine(text: string): {
  readonly text: string;
  readonly skill: string | null;
  readonly references: readonly ItemReference[];
} {
  const ctx = splitAppContext(text);
  const { skill, rest } = splitSkillRequest(ctx.rest);
  // ... and the server's references line (KOBE-490), taken off the end.
  const refs = splitItemReferences(rest);
  if (skill === null && refs.references.length === 0) return { text, skill, references: [] };
  return { text: text.slice(0, ctx.restAt) + refs.rest, skill, references: refs.references };
}

export function branchPoint(
  projection: Projection,
  messageId: string | null | undefined,
): BranchPoint | undefined {
  if (!messageId) return undefined;
  const item = projection.items.find((i) => i.message.id === messageId);
  return branchPointOfMeta(projection, item ? messageMeta(item.message) : undefined);
}

/** `branchPoint` for a message whose metadata is at hand (no lookup). */
export function branchPointOfMeta(
  projection: Projection,
  meta: KobeMessageMeta | undefined,
): BranchPoint | undefined {
  if (meta?.kind !== "user" || meta.pending || meta.parentEntryId === null) return undefined;
  if (!projection.loaded.has(meta.parentEntryId)) return undefined;
  return {
    parentEntryId: meta.parentEntryId,
    ...(meta.entryId === undefined ? {} : { promptEntryId: meta.entryId }),
    text: meta.text,
    ...(meta.skill === undefined ? {} : { skill: meta.skill }),
    ...(meta.references === undefined ? {} : { references: meta.references }),
  };
}
