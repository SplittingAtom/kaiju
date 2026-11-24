import { referencesBody } from "../../lib/apps/app-items";
import { textAfterSend } from "../../lib/chat/after-send";
import { appContextBody } from "../../lib/apps/app-context";
import type { useAui } from "@assistant-ui/react";
import type { DragEvent, KeyboardEvent } from "react";
import type { useComposerMentionDrop } from "./composer-mention-drop";
import type { useComposerDictation } from "./composer-steer";
import type { useChatSession, KaijuThreadExtras } from "./kaiju-runtime";
import { IN_TRASH, READ_ONLY } from "../../lib/chat/thread-commands";
import type { MenuBinding, MenuBindings } from "../../lib/shell/menu";

const NOTHING_TO_STEER = "Nothing is running to steer.";

/**
 * The composer's own actions for the palette and the shortcuts (CE23, KOBE-225): Go to the message
 * box (Mod+/) and Steer now (Mod+Shift+Enter, which the input itself also handles while a run is
 * on), each with why it can't run.
 */
export function composerBindings(
  focus: () => void,
  steer: { readonly run: () => void; readonly unavailable: string | undefined },
  state: { readonly running: boolean; readonly readOnly: boolean; readonly inTrash: boolean },
): MenuBindings {
  const closed = state.readOnly ? READ_ONLY : state.inTrash ? IN_TRASH : null;
  return {
    "focus-composer": { onSelect: focus, blocker: closed },
    steer: {
      onSelect: steer.run,
      blocker: closed ?? (state.running ? (steer.unavailable ?? null) : NOTHING_TO_STEER),
    },
  };
}

/** Up arrow edits the last sent message only from an empty input, the caret at its start. */
export function wantsEditLast(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  const el = e.currentTarget;
  return (
    e.key === "ArrowUp" &&
    !e.shiftKey &&
    !e.altKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    // Safari ends a composition with a keydown that is no longer composing but reports 229.
    !e.nativeEvent.isComposing &&
    e.nativeEvent.keyCode !== 229 &&
    el.value === "" &&
    el.selectionStart === 0 &&
    // An open trigger popover (the @ picker, the / menu) owns the arrows.
    el.getAttribute("aria-expanded") !== "true"
  );
}

/** Backspace with nothing to delete: an empty input, no modifier, no IME composing. */
export function wantsChipBack(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  const el = e.currentTarget;
  return (
    e.key === "Backspace" &&
    !e.shiftKey &&
    !e.altKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.nativeEvent.isComposing &&
    e.nativeEvent.keyCode !== 229 &&
    el.value === "" &&
    el.selectionStart === 0
  );
}

type Session = ReturnType<typeof useChatSession>;

/** What the queue action reads from the render it was made in. */
export interface QueueInput {
  readonly controller: KaijuThreadExtras["controller"];
  readonly empty: boolean;
  readonly blocker: string | undefined;
  readonly piRefusal: string | null;
  readonly dictation: ReturnType<typeof useComposerDictation>;
  readonly session: Session;
  readonly draft: string;
  readonly text: string;
  readonly aui: ReturnType<typeof useAui>;
}

/** The send used while a run holds the thread: it queues the message, settling the draft once sent. */
export function createQueue(q: QueueInput): () => Promise<void> {
  const { controller, empty, blocker, piRefusal, dictation, session, draft, text, aui } = q;
  return async () => {
    if (!controller || empty || blocker !== undefined || piRefusal !== null) return;
    dictation.stop();
    const content = session.mentions.contentFor(draft, text.trim());
    const mentions = session.mentions.forText(draft, content);
    const attach = session.attachments.ready(draft);
    const chips = session.appContexts.forDraft(draft);
    const skill = session.skillPicks.get(draft);
    const viewing = session.viewing.body();
    const contexts = appContextBody(chips);
    const items = session.appItems.forDraft(draft);
    const references = referencesBody(items);
    if (
      await controller.send(
        content,
        undefined,
        attach,
        mentions,
        contexts,
        skill,
        viewing,
        references,
      )
    ) {
      // Only what went: text, mentions, chips and a skill added during the send stay (KOBE-415).
      const remaining = textAfterSend(aui.composer.getState().text, text);
      session.attachments.sent(draft);
      session.mentions.settleSent(draft, mentions, remaining);
      session.appContexts.removeSent(draft, chips);
      session.appItems.removeSent(draft, items);
      session.skillPicks.clearSent(draft, skill);
      aui.composer.setText(remaining);
    }
  };
}

type RowDrop = ReturnType<typeof useComposerMentionDrop>;

/** The panel's drag handlers: workspace rows are mentions, files from the computer attach. */
export function createDragHandlers(
  rowDrop: RowDrop,
  attach: (list: FileList | null) => void,
  setDragging: (dragging: boolean) => void,
) {
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  return {
    onDragOver: (e: DragEvent) => {
      if (rowDrop.over(e) || !hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    },
    onDrop: (e: DragEvent) => {
      if (rowDrop.drop(e) || !hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      attach(e.dataTransfer.files);
    },
    onDragLeave: (e: DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return; // into a child
      setDragging(false);
      rowDrop.leave();
    },
  };
}

/** What the input's key handler reads from the render it was made in. */
export interface KeyDownInput {
  readonly rowDrop: RowDrop;
  readonly state: KaijuThreadExtras["state"];
  readonly controller: KaijuThreadExtras["controller"];
  readonly session: Session;
  readonly draft: string;
  readonly editLast: MenuBinding | undefined;
  readonly appPending: unknown;
  readonly piRefusal: string | null;
  readonly running: boolean;
  readonly steer: () => unknown;
  readonly queue: () => unknown;
}

export function createKeyDown(k: KeyDownInput) {
  const { rowDrop, state, controller, session, draft, editLast, running } = k;
  return (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (rowDrop.notice !== "") rowDrop.clearNotice();
    // Escape drops Continue from here (CT8) unless a popover (the @ or / menu) takes it.
    if (
      e.key === "Escape" &&
      state.continueFrom !== undefined &&
      e.currentTarget.getAttribute("aria-expanded") !== "true"
    ) {
      e.preventDefault();
      controller?.clearContinue();
      return;
    }
    // Backspace in an empty input takes back the last file chip (KOBE-756).
    if (wantsChipBack(e)) {
      const chips = session.mentions.chips(draft);
      const last = chips.at(-1);
      if (last !== undefined) {
        e.preventDefault();
        session.mentions.removeChip(draft, last);
      }
      return;
    }
    if (wantsEditLast(e)) {
      if (editLast?.onSelect && !editLast.blocker) {
        e.preventDefault();
        editLast.onSelect();
      }
      return;
    }
    // Text an app inserted is not sent, queued or steered until the member changes or confirms it
    // (MEDIUM-2, LOW-L): only a plain Shift+Enter (a new line) gets through.
    const newLine = e.shiftKey && !e.ctrlKey && !e.metaKey;
    if (e.key === "Enter" && !newLine && k.appPending !== null) {
      e.preventDefault();
      return;
    }
    // An open trigger popover (the / menu) takes Enter itself; otherwise a refused Pi word stays.
    if (
      e.key === "Enter" &&
      !newLine &&
      !e.nativeEvent.isComposing &&
      k.piRefusal !== null &&
      e.currentTarget.getAttribute("aria-expanded") !== "true"
    ) {
      e.preventDefault();
      return;
    }
    if (e.key !== "Enter" || e.nativeEvent.isComposing || !running) return;
    // An open trigger popover (the @ picker, the / menu) takes Enter to pick, not to queue.
    if (e.currentTarget.getAttribute("aria-expanded") === "true") return;
    if (e.shiftKey && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void k.steer();
    } else if (!e.shiftKey) {
      e.preventDefault();
      void k.queue();
    }
  };
}
