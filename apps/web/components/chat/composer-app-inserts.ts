"use client";

import { insertAt } from "../../lib/apps/app-context";
import { useAui } from "@assistant-ui/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useInsertGate, type PendingInsert } from "./composer-steer";
import { useChatSession } from "./kaiju-runtime";

/** How long the composer flashes after an app put text in it. */
const INSERT_FLASH_MS = 600;

/**
 * Edits within this long after an insert never lift its gate (KOBE-439 re-review LOW-J): a
 * keystroke the member was already making when the text arrived is not a review of it.
 */
export const INSERT_SETTLE_MS = 800;

/**
 * Whether `text` settles the pending insert: the member cleared the composer, or, once the settle
 * time has passed, changed the inserted text itself. Typing around it does not (LOW-J).
 */
export function settlesInsert(pending: PendingInsert, text: string, now: number): boolean {
  if (text === pending.text) return false;
  if (text.trim() === "") return true;
  return now - pending.at >= INSERT_SETTLE_MS && !text.includes(pending.insert);
}

/**
 * An app's `ui/message` (KOBE-439, spec §8; review MEDIUM-2, coordinator decision): the text goes
 * in at the caret of this thread's composer and **never moves the focus**: an Enter the member
 * presses in the app (or anywhere else) cannot send it. Until the member changes the inserted text
 * or confirms it, it carries a visible "From <app>" marker, and Enter, Send, Queue and every way
 * of steering do nothing (LOW-J, LOW-L). It is never sent by itself. Only a writable composer
 * listens, under its draft: the thread's id, or the new-conversation draft (a rail picker's text,
 * KOBE-460; no card is ever in a new conversation).
 */
export function useAppInserts(
  input: RefObject<HTMLTextAreaElement | null>,
  text: string,
  threadId: string | undefined,
  writable: boolean,
): {
  readonly flash: boolean;
  readonly pending: PendingInsert | null;
  confirm(): void;
} {
  const aui = useAui();
  const session = useChatSession();
  const gate = useInsertGate();
  const [flash, setFlash] = useState(false);
  const latest = useRef(text);
  latest.current = text;
  const setPending = gate.set;
  useEffect(() => {
    if (!writable || threadId === undefined) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = session.composerInserts.listen(threadId, (insert, from) => {
      const el = input.current;
      const caret = el !== null && document.activeElement === el ? el.selectionEnd : undefined;
      const next = insertAt(latest.current, caret ?? latest.current.length, insert);
      aui.composer.setText(next.text);
      setPending({ from, insert, text: next.text, at: Date.now() });
      setFlash(true);
      clearTimeout(timer);
      timer = setTimeout(() => setFlash(false), INSERT_FLASH_MS);
      return true;
    });
    return () => {
      stop();
      clearTimeout(timer);
      setPending(null); // another thread's composer never inherits this one's gate
    };
  }, [session, aui, input, threadId, writable, setPending]);
  const pending = gate.pending;
  // The composer's state shows the inserted text a render later: judge only changes after that.
  const seen = useRef<PendingInsert | null>(null);
  useEffect(() => {
    if (pending === null) return;
    if (text === pending.text) seen.current = pending;
    else if (seen.current === pending && settlesInsert(pending, text, Date.now())) setPending(null);
  }, [pending, text, setPending]);
  const confirm = () => {
    setPending(null);
    input.current?.focus();
  };
  return { flash, pending, confirm };
}
