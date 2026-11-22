"use client";

import { AppContextChips } from "../apps/app-context-chips";
import { AppItemChips } from "../apps/app-item-chips";
import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { NEW_DRAFT } from "../../lib/chat/attachments";
import { isThreadRunning } from "../../lib/chat/thread-state";
import { ComposerAttachments } from "./attachment-chips";
import { ViewingChip } from "./viewing-chip";
import { ContinueChip } from "./continue-from";
import { isBrowsing } from "../../lib/chat/head";
import { MentionChips, MentionPicker } from "./mention-picker";
import { useComposerMentionDrop } from "./composer-mention-drop";
import { useComposerDictation, useSteer } from "./composer-steer";
import { useChatSession, type KobeThreadExtras } from "./kobe-runtime";
import { ariaKeyShortcuts } from "../../lib/shell/commands";
import { refusedPiCommand } from "../../lib/shell/pi-commands";
import { shortcutOf } from "../../lib/shell/shortcuts";
import { useBindCommands, useBoundCommands } from "../shell/command-bindings";
import { cn } from "../../lib/utils";
import { ComposerSelectors, useComposerPicker, useFoldedSelectors } from "./composer-selectors";
import { ModelWarning } from "./model-picker";
import { useReloadDraft } from "./use-reload-draft";
import { SkillPickChip } from "./plus-skills";
import { SlashMenu } from "./slash-menu";
import { useAppInserts } from "./composer-app-inserts";
import {
  composerBindings,
  createDragHandlers,
  createKeyDown,
  createQueue,
} from "./composer-handlers";
import {
  ComposerFooterRow,
  ComposerHint,
  ComposerNotes,
  ComposerToolbar,
  ReadOnlyBanner,
  TrashBanner,
} from "./composer-parts";
import panelStyles from "./composer.module.css";

export { INSERT_SETTLE_MS, settlesInsert } from "./composer-app-inserts";

/**
 * The composer (D17). Idle: Enter sends. While a run holds the thread the primary button reads
 * **Queue** and Enter queues the message (it runs next, in order); Ctrl/Cmd+Shift+Enter steers it
 * into the running agent at its next safe point. The Steer now and Stop buttons sit in the
 * steering panel above the input (CE10, `steering-panel.tsx`). The text is cleared only
 * once the server accepted it. The mic button dictates into the prompt (`lib/chat/dictation.ts`);
 * sending stops dictation. Its toolbar starts with the + menu (KOBE-451: Attach files,
 * Connectors, Memory with Learn from this chat (KOBE-395), Skills, Apps). Before the first prompt the toolbar then holds the
 * conversation's Agent, Model and Thinking selectors (KOBE-418), folded into one menu on a narrow
 * composer; after it they move to the line below, before the context gauge (KOBE-450).
 */
export function Composer({
  extras,
  footer,
}: {
  readonly extras: KobeThreadExtras;
  /** The end of the row under the box (the context gauge, KOBE-418); shown under a banner too. */
  readonly footer?: ReactNode;
}) {
  const aui = useAui();
  const session = useChatSession();
  const text = useAuiState((s) => s.composer.text);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const { controller, state } = extras;
  const running = isThreadRunning(state);
  const inTrash = state.summary?.deletedAt != null;
  const empty = text.trim() === "";
  // A message starting with a Pi command Kobe doesn't offer is never sent (KOBE-450, LOW-5).
  const piRefusal = refusedPiCommand(text);
  const dictation = useComposerDictation();
  const { steer, unavailable } = useSteer(extras);
  const draft = remoteId ?? NEW_DRAFT;
  const blocker = session.attachments.blocker(draft);
  const filePicker = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = useState(false);
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const folded = useFoldedSelectors(panel);
  const picker = useComposerPicker(extras);
  // KOBE-450: the selectors leave the toolbar once the thread has its first prompt.
  const started = remoteId !== undefined;
  // A fork at a prompt opens with that prompt as its draft (KOBE-216), once.
  useEffect(() => {
    if (remoteId === undefined) return;
    const prefill = session.takeComposerDraft(remoteId);
    if (prefill !== undefined) aui.composer.setText(prefill);
  }, [remoteId, session, aui]);
  useReloadDraft(draft);

  const attach = (list: FileList | null) => {
    if (list && list.length > 0) session.attachments.add(draft, [...list], remoteId);
  };
  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    attach(e.target.files);
    e.target.value = ""; // the same file can be picked again after removing it
  };
  const readOnly = extras.state.summary?.readOnly === true;
  // A workspace row from the Files tree is a mention (KOBE-374); files from the computer attach.
  // An app frame's pointer drag (KOBE-553) drops on the panel too.
  const rowDrop = useComposerMentionDrop({
    draft,
    text,
    input,
    writable: !readOnly && !inTrash,
    panel,
  });
  // A new conversation's draft takes a rail picker's text too (KOBE-460).
  const appInsert = useAppInserts(input, text, draft, !readOnly && !inTrash);
  const { onDragOver, onDrop, onDragLeave } = createDragHandlers(rowDrop, attach, setDragging);
  const queue = createQueue({
    controller,
    empty,
    blocker,
    piRefusal,
    dictation,
    session,
    draft,
    text,
    aui,
  });
  useBindCommands(
    composerBindings(
      () => input.current?.focus(),
      { run: () => void steer(), unavailable },
      { running, readOnly, inTrash },
    ),
  );
  const editLast = useBoundCommands()["edit-last-message"];
  const onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void = createKeyDown({
    rowDrop,
    state,
    controller,
    session,
    draft,
    editLast,
    appPending: appInsert.pending,
    piRefusal,
    running,
    steer,
    queue,
  });

  if (readOnly && !inTrash) return <ReadOnlyBanner footer={footer} />;
  if (inTrash) {
    return <TrashBanner onRestore={() => void aui.threadListItem.unarchive()} footer={footer} />;
  }

  // Trigger popovers (KOBE-223 `@` files, KOBE-224 `/` actions) share the input's keys.
  return (
    <ComposerPrimitive.TriggerPopoverRoot>
      <ComposerPrimitive.Root
        className="relative flex w-full flex-col gap-2"
        onSubmit={() => {
          dictation.stop();
          // A new thread is created by this send: its title is the message's first line.
          if (remoteId === undefined) session.setNextTitle(text);
        }}
      >
        <div
          ref={setPanel}
          data-kobe-composer-panel
          data-running={running || undefined}
          data-dragging={dragging || undefined}
          data-mention-drop={rowDrop.rowDrop ?? undefined}
          data-app-insert={appInsert.flash || undefined}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={cn(
            panelStyles.panel,
            "border-foreground/10 data-[dragging]:border-primary data-[dragging]:bg-primary/5 bg-muted/30 flex w-full cursor-text flex-col gap-2 rounded-2xl border p-2",
          )}
        >
          <MentionPicker input={input} onPick={rowDrop.pick} />
          <SlashMenu input={input} />
          <ComposerAttachments draft={draft} threadId={remoteId} />
          <MentionChips draft={draft} onRemoved={() => input.current?.focus()} />
          <AppContextChips draft={draft} />
          <AppItemChips draft={draft} />
          <SkillPickChip draft={draft} />
          <ViewingChip />
          <ContinueChip extras={extras} />
          <ComposerNotes
            branching={isBrowsing(state)}
            pending={appInsert.pending}
            onConfirm={appInsert.confirm}
          />
          <label htmlFor="kobe-composer" className="sr-only">
            Message
          </label>
          <ComposerPrimitive.Input
            ref={input}
            id="kobe-composer"
            placeholder={
              running ? "Type to queue a message, or steer the agent" : "Message the agent"
            }
            aria-describedby="kobe-composer-hint"
            aria-keyshortcuts={ariaKeyShortcuts(shortcutOf("focus-composer"))}
            onKeyDown={onKeyDown}
            submitMode="enter"
            rows={1}
            enterKeyHint="send"
            className={cn(
              panelStyles.input,
              "caret-primary placeholder:text-muted-foreground/60 max-h-48 min-h-10 w-full resize-none border-0 bg-transparent px-2.5 py-1 text-base leading-6 outline-none focus-visible:shadow-none",
            )}
          />
          <ComposerToolbar
            filePicker={filePicker}
            onPick={onPick}
            draft={draft}
            threadId={remoteId}
            running={running}
            started={started}
            picker={picker}
            folded={folded}
            dictation={dictation}
            text={text}
            queue={queue}
            queueDisabled={
              empty || blocker !== undefined || appInsert.pending !== null || piRefusal !== null
            }
            sendDisabled={blocker !== undefined || appInsert.pending !== null || piRefusal !== null}
          />
          {picker && <ModelWarning picker={picker} />}
        </div>
        <ComposerFooterRow
          footer={footer}
          hint={
            <ComposerHint
              rowDrop={rowDrop}
              blocker={blocker}
              piRefusal={piRefusal}
              dictation={dictation}
              running={running}
            />
          }
          lead={
            started ? (
              <ComposerSelectors picker={picker} folded={false} placement="below" />
            ) : undefined
          }
        />
      </ComposerPrimitive.Root>
    </ComposerPrimitive.TriggerPopoverRoot>
  );
}
