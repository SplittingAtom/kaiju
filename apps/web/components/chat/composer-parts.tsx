"use client";

import { ComposerPrimitive } from "@assistant-ui/react";
import { MicIcon } from "lucide-react";
import type { ChangeEvent, ReactNode, RefObject } from "react";
import { MENTION_FOLDER_REFUSED } from "../../lib/chat/mention-insert";
import type { useComposerMentionDrop } from "./composer-mention-drop";
import type { PendingInsert, useComposerDictation } from "./composer-steer";
import { IconAction } from "../shell/icon-action";
import { Button } from "../ui/button";
import { ComposerSelectors, type useComposerPicker } from "./composer-selectors";
import { PlusMenu } from "./plus-menu";
import styles from "./chat.module.css";

type Dictation = ReturnType<typeof useComposerDictation>;
type Picker = ReturnType<typeof useComposerPicker>;

/**
 * The line under the box: after the first prompt the selectors lead it (KOBE-450), then the
 * hint, then the gauge at its end. It wraps on a narrow composer instead of overflowing.
 */
export function ComposerFooterRow({
  hint,
  lead,
  footer,
}: {
  readonly hint: ReactNode;
  readonly lead?: ReactNode;
  readonly footer?: ReactNode;
}) {
  return (
    <div
      data-composer-footer
      className="flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-2"
    >
      {lead}
      {hint}
      <span data-composer-gauge className="ms-auto flex shrink-0 items-center">
        {footer}
      </span>
    </div>
  );
}

export function ReadOnlyBanner({ footer }: { readonly footer?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className={styles.banner} role="note">
        You are reading a shared conversation. Fork it to ask the agent something of your own.
      </p>
      <ComposerFooterRow hint={null} footer={footer} />
    </div>
  );
}

export function TrashBanner({
  onRestore,
  footer,
}: {
  readonly onRestore: () => void;
  readonly footer?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className={styles.banner} role="note">
        This conversation is in Trash. Restore it to continue.{" "}
        <button type="button" onClick={onRestore}>
          Restore
        </button>
      </div>
      <ComposerFooterRow hint={null} footer={footer} />
    </div>
  );
}

/** The status text beside the gauge: a drop target, a blocker, a refusal, dictation or the keys. */
export function ComposerHint({
  rowDrop,
  blocker,
  piRefusal,
  dictation,
  running,
}: {
  readonly rowDrop: ReturnType<typeof useComposerMentionDrop>;
  readonly blocker: string | undefined;
  readonly piRefusal: string | null;
  readonly dictation: Dictation;
  readonly running: boolean;
}) {
  return (
    <p
      id="kobe-composer-hint"
      className="text-muted-foreground m-0 min-w-0 flex-1 basis-40 text-xs"
    >
      {rowDrop.rowDrop === "file" ? (
        "Drop to mention this file"
      ) : rowDrop.rowDrop === "item" ? (
        "Drop to insert this item"
      ) : rowDrop.rowDrop === "folder" ? (
        <span role="status">{MENTION_FOLDER_REFUSED}</span>
      ) : rowDrop.notice !== "" ? (
        <span role="status">{rowDrop.notice}</span>
      ) : blocker !== undefined ? (
        <span role="status">{blocker}</span>
      ) : piRefusal !== null ? (
        <span role="status" data-kobe-pi-refusal>
          {piRefusal}
        </span>
      ) : dictation.error ? (
        <span role="alert">{dictation.error}</span>
      ) : dictation.listening ? (
        "Listening… speak your prompt, then press the mic again to stop"
      ) : running ? (
        // Key hints stay on one line (ellipsized on a phone), so the row never grows as a run
        // starts; statuses and errors above still wrap.
        <span className="block truncate">
          Enter queues · Ctrl+Shift+Enter steers · Shift+Enter new line
        </span>
      ) : (
        <span className="block truncate">Enter sends · Shift+Enter new line</span>
      )}
    </p>
  );
}

/** The toolbar row: + menu, selectors, dictation, then Queue (during a run) or Send. */
export function ComposerToolbar({
  filePicker,
  onPick,
  draft,
  threadId,
  running,
  started,
  picker,
  folded,
  dictation,
  text,
  queue,
  queueDisabled,
  sendDisabled,
}: {
  readonly filePicker: RefObject<HTMLInputElement | null>;
  readonly onPick: (e: ChangeEvent<HTMLInputElement>) => void;
  readonly draft: string;
  readonly threadId: string | undefined;
  readonly running: boolean;
  readonly started: boolean;
  readonly picker: Picker;
  readonly folded: boolean;
  readonly dictation: Dictation;
  readonly text: string;
  readonly queue: () => unknown;
  readonly queueDisabled: boolean;
  readonly sendDisabled: boolean;
}) {
  return (
    <div data-composer-toolbar className="flex min-w-0 items-center gap-1.5">
      <input
        ref={filePicker}
        type="file"
        multiple
        tabIndex={-1}
        aria-label="Choose files to attach"
        className="sr-only"
        onChange={onPick}
      />
      <PlusMenu
        draft={draft}
        threadId={threadId ?? null}
        threadRunning={running}
        onAttach={() => filePicker.current?.click()}
      />
      {started ? (
        <span className="flex-1" />
      ) : (
        <>
          <ComposerSelectors picker={picker} folded={folded} />
          {folded && <span className="flex-1" />}
        </>
      )}
      {dictation.supported && (
        <IconAction
          command="dictate"
          label={dictation.listening ? "Stop dictation" : "Dictate"}
          variant={dictation.listening ? "destructive" : "ghost"}
          className="size-7 shrink-0 rounded-full"
          aria-pressed={dictation.listening}
          onClick={() => (dictation.listening ? dictation.stop() : dictation.start(text))}
        >
          <MicIcon
            aria-hidden
            className={dictation.listening ? "size-4 animate-pulse" : "size-4"}
          />
        </IconAction>
      )}
      {running ? (
        // CE10: the primary button queues during a run; Steer now and Stop sit in the
        // steering panel above the input.
        <Button
          type="button"
          size="sm"
          className="h-8 shrink-0 rounded-full px-3"
          onClick={() => void queue()}
          disabled={queueDisabled}
        >
          Queue
        </Button>
      ) : (
        <ComposerPrimitive.Send asChild>
          <IconAction
            command="send"
            type="button"
            variant="default"
            className="size-7 shrink-0 rounded-full"
            disabled={sendDisabled}
          />
        </ComposerPrimitive.Send>
      )}
    </div>
  );
}

/** The notes above the input: a browsed branch a send continues, and text an app inserted. */
export function ComposerNotes({
  branching,
  pending,
  onConfirm,
}: {
  readonly branching: boolean;
  readonly pending: PendingInsert | null;
  readonly onConfirm: () => void;
}) {
  return (
    <>
      {/* CT3: from a browsed branch, a send continues that branch, which becomes current. */}
      {branching && (
        <p role="note" data-kobe-branch-send="" className="text-muted-foreground m-0 px-2 text-xs">
          Sending here makes this branch current
        </p>
      )}
      {pending && (
        <p
          role="note"
          data-kobe-app-insert-from={pending.from}
          className="text-muted-foreground m-0 flex items-center gap-2 px-2 text-xs"
        >
          <span>From {pending.from}: edit the text or confirm it before you send.</span>
          <button type="button" className="underline" onClick={onConfirm}>
            Confirm
          </button>
        </p>
      )}
    </>
  );
}
