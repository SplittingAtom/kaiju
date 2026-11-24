/** The projection's types and message ids (KOBE-716: out of `lib/chat/tree.ts`). */
import type { ItemReference } from "@kaiju/protocol";
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { SentFile } from "../attachments";
import type { ParsedEntry } from "../entries";
import type { EntryMarker } from "../markers";
import type { LiveRun } from "../live";
import type { ThreadEntry } from "../types";

export type KaijuMessageMeta =
  | {
      readonly kind: "user";
      /** The entry id; undefined for a prompt Pi hasn't committed yet. */
      readonly entryId?: string | undefined;
      /** Where an edit of this message branches from (its entry's parent). */
      readonly parentEntryId: string | null;
      readonly text: string;
      /**
       * The skill the message was sent with (KOBE-451): the server's line, taken out of `text`, so
       * an edit or a regenerate sends the member's text and names the skill again.
       */
      readonly skill?: string | undefined;
      /**
       * App items it referenced (KOBE-490): the server's line, taken out of `text`, so an edit or
       * a regenerate sends them again as references (chips), never as typed text.
       */
      readonly references?: readonly ItemReference[] | undefined;
      /** Not an entry yet: the run's prompt as sent, shown until Pi saves it (no edit, no fork). */
      readonly pending: boolean;
      /** Its run still holds the thread ("Sent, waiting for the agent"); never once it ended. */
      readonly waiting?: boolean | undefined;
      /** Files sent with it (chips): from the send while pending, from Pi's text once committed. */
      readonly attachments?: readonly ChipFile[] | undefined;
      /** Skipped-actions reports of a run that left no answer after this prompt (KOBE-181). */
      readonly skipped?: readonly SkippedReport[] | undefined;
      /** Markers above the message (below a fork or the root) and after it (KOBE-209). */
      readonly before?: readonly EntryMarker[] | undefined;
      readonly after?: readonly EntryMarker[] | undefined;
    }
  | {
      readonly kind: "assistant";
      readonly entryIds: readonly string[];
      readonly live: boolean;
      /** Tool calls whose output the list trimmed (toolCallId → result entry): read on expand. */
      readonly fullOutputs?: Readonly<Record<string, string>> | undefined;
      /** The prompt this answer replies to (past answers it continues): its run's usage. */
      readonly promptEntryId?: string | undefined;
      /** When the answer's last entry was stored (the footer's timestamp). */
      readonly at?: string | undefined;
      /** A rail-launched app card (KOBE-440): no answer actions, no feedback. */
      readonly appCard?: boolean | undefined;
      readonly before?: readonly EntryMarker[] | undefined;
      readonly after?: readonly EntryMarker[] | undefined;
    };

/** A scheduled run's skipped-actions report (KOBE-178), as the card shows it. */
export interface SkippedReport {
  readonly text: string;
  readonly count: number;
}

/** A file shown on a sent message; `size` is unknown for files not sent from this tab. */
export interface ChipFile {
  readonly name: string;
  readonly mimeType: string;
  readonly size?: number | undefined;
  /** Sandbox path of an upload, to look its size and thumbnail up after a reload (KOBE-194). */
  readonly path?: string | undefined;
  readonly previewUrl?: string | undefined;
}

export interface ProjectedItem {
  readonly parentId: string | null;
  readonly message: ThreadMessageLike & { readonly id: string };
  /** Everything the message was built from: equal deps (by identity) → reuse the old message. */
  readonly deps: readonly unknown[];
}

export interface Projection {
  readonly items: readonly ProjectedItem[];
  readonly headId: string | null;
  readonly nodeOfEntry: ReadonlyMap<string, string>;
  readonly lastEntryOfNode: ReadonlyMap<string, string>;
  /** The tree entries loaded here (an older page may not be). */
  readonly loaded: ReadonlySet<string>;
  /** Every entry as parsed for this projection (the tree reuses it, KOBE-545). */
  readonly parsed?: ReadonlyMap<string, ParsedEntry> | undefined;
}

export interface LiveOverlay {
  readonly run: LiveRun;
  /** The run still holds the thread (streaming or waiting). */
  readonly active: boolean;
  /** The run's message text, shown until Pi commits it (from pending-messages or the send). */
  readonly prompt?:
    | {
        readonly text: string;
        readonly parentEntryId: string | null;
        readonly files?: readonly SentFile[] | undefined;
      }
    | undefined;
}

export interface ToolResultInfo {
  readonly text: string;
  readonly isError: boolean;
}

export interface Node {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: "user" | "assistant";
  readonly entries: ThreadEntry[];
}

export type MessagePart = Exclude<ThreadMessageLike["content"], string>[number];

export const PREFIX_PROMPT = "prompt:";
export const PREFIX_LIVE = "live:";
export const PREFIX_SKIPPED = "skipped:";
export const PREFIX_EMPTY = "empty:";

/** The note of a version whose run ended before Pi saved its message (a root edit, KOBE-214). */
export const EMPTY_VERSION_NOTE =
  "This version has no messages: its run ended before the agent saved the message.";
export const PART_MARKER = "data-kaiju-marker";

export function messageMeta(message: {
  readonly metadata?: { readonly custom?: unknown } | undefined;
}) {
  return message.metadata?.custom as KaijuMessageMeta | undefined;
}
