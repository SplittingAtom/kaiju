"use client";

import {
  ComposerPrimitive,
  useAui,
  useAuiState,
  type TriggerAdapter,
  type TriggerItem,
} from "@assistant-ui/react";
import { FileIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore, type RefObject } from "react";
import type { FilesApi } from "../../lib/files/api";
import {
  fileItem,
  MENTION_TRIGGER,
  mentionable,
  mentionQueryAt,
  mentionStartAt,
} from "../../lib/chat/mentions";
import { sandboxPathOf } from "@kobe/protocol";
import { useChatSession } from "./kobe-runtime";

/** Wait after the last keystroke before asking the server. */
const SEARCH_DEBOUNCE_MS = 120;
const RESULTS = 20;

interface Found {
  readonly query: string;
  readonly items: readonly TriggerItem[];
}

/**
 * The query of the `@` being typed (null when none), from the composer text and the input's caret,
 * and the server's matches for it. Previous matches stay while the next ones load.
 */
function useMentionSearch(
  files: FilesApi,
  input: RefObject<HTMLTextAreaElement | null>,
): { readonly found: Found | undefined; readonly loading: boolean } {
  const text = useAuiState((s) => s.composer.text);
  const [query, setQuery] = useState<string | null>(null);
  const [found, setFound] = useState<Found | undefined>(undefined);
  useEffect(() => {
    setQuery(mentionQueryAt(text, input.current?.selectionStart ?? text.length));
  }, [text, input]);
  useEffect(() => {
    if (query === null) return;
    let live = true;
    const timer = setTimeout(() => {
      void files.search(query, RESULTS).then(
        (res) => {
          if (!live) return;
          // Names with invisible characters are never offered (the server leaves them out too).
          const items = res.ok ? res.data.entries.filter(mentionable).map(fileItem) : [];
          setFound({ query, items });
        },
        () => {
          if (live) setFound({ query, items: [] });
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [files, query]);
  const current = query === null ? undefined : found;
  return { found: current, loading: query !== null && current?.query !== query };
}

/**
 * The `@` picker (CE22, KOBE-223) on assistant-ui's trigger popover: a listbox of the member's
 * workspace files (own files, project mounts, uploads) under the composer's `TriggerPopoverRoot`.
 * The input is the combobox (ARIA wired by `ComposerPrimitive.Input`): arrows move, Enter or Tab
 * picks, Escape closes and leaves the text. Picking (KOBE-756) hands the file to `onPick`, which
 * adds the same chip as a drop from the Files tree or answers why not; once it is taken the typed
 * `@query` leaves the text, caret where the `@` was, and a refused pick leaves the text exactly as
 * typed (the refusal shows under the composer). The send appends its `@file(...)` marker, which the server turns
 * into the absolute sandbox path. The popover stays closed while there is nothing to pick, so
 * Enter still sends a message that merely contains an `@`.
 */
export function MentionPicker({
  input,
  onPick,
}: {
  readonly input: RefObject<HTMLTextAreaElement | null>;
  /** Takes the picked workspace path into the draft as a chip; answers why not, if refused. */
  readonly onPick: (path: string) => string | undefined;
}) {
  const aui = useAui();
  const session = useChatSession();
  const { found, loading } = useMentionSearch(session.files, input);
  const items = found?.items;
  // The input still shows the text as typed here (the library's own edit renders next), so the
  // edit is decided from it: refused, the typed text comes back unchanged; taken, `[@, caret)` goes
  // (and one space after it). The library keeps only its own idea of the caret, not the input's,
  // so the caret is put where the `@` was once the new text is on screen.
  const execute = (item: TriggerItem) => {
    const el = input.current;
    const typed = el?.value ?? aui.composer.getState().text;
    const caret = el?.selectionStart ?? typed.length;
    const at = mentionStartAt(typed, caret);
    if (onPick(item.id) !== undefined || at === null) {
      aui.composer.setText(typed);
      return;
    }
    const after = typed.slice(caret);
    aui.composer.setText(typed.slice(0, at) + (after.startsWith(" ") ? after.slice(1) : after));
    if (el !== null) {
      requestAnimationFrame(() => {
        if (el.value.length >= at) el.setSelectionRange(at, at);
      });
    }
  };
  const adapter = useMemo<TriggerAdapter | undefined>(
    () =>
      items === undefined || items.length === 0
        ? undefined
        : { categories: () => [], categoryItems: () => [], search: () => items },
    [items],
  );
  return (
    <ComposerPrimitive.TriggerPopover
      char={MENTION_TRIGGER}
      adapter={adapter}
      isLoading={loading}
      aria-label="Workspace files"
      className="bg-popover text-popover-foreground border-foreground/10 absolute bottom-full left-0 z-20 mb-2 max-h-72 w-full overflow-y-auto rounded-xl border p-1 shadow-lg"
    >
      <ComposerPrimitive.TriggerPopover.Action onExecute={execute} />
      <ComposerPrimitive.TriggerPopoverItems aria-label="Files">
        {(list) =>
          list.map((item, index) => (
            <ComposerPrimitive.TriggerPopoverItem
              key={item.id}
              item={item}
              index={index}
              // The input keeps the focus on a click pick (the option unmounts).
              onMouseDown={(e) => e.preventDefault()}
              className="data-[highlighted]:bg-muted flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm"
            >
              <FileIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
              <span className="truncate font-medium">{item.label}</span>
              <span className="text-muted-foreground ms-auto truncate text-xs">
                {item.description}
              </span>
            </ComposerPrimitive.TriggerPopoverItem>
          ))
        }
      </ComposerPrimitive.TriggerPopoverItems>
    </ComposerPrimitive.TriggerPopover>
  );
}

const CHIP =
  "border-foreground/10 bg-background flex min-w-0 max-w-80 items-center gap-1.5 rounded-lg border px-2 py-1 text-xs";

/**
 * The files mentioned in the draft (picked with `@`, dropped from the Files tree, or "Mention in
 * message"), as chips above the input; their @file markers stay out of the text until the send
 * appends them. Each chip shows the whole workspace path; removing it drops the mention.
 */
export function MentionChips({
  draft,
  onRemoved,
}: {
  readonly draft: string;
  /** After a chip's remove button: its button is gone, so the focus goes back (the input). */
  readonly onRemoved?: () => void;
}) {
  const { mentions: store } = useChatSession();
  const chips = useSyncExternalStore(
    store.subscribe,
    () => store.chips(draft),
    () => store.chips(draft),
  );
  if (chips.length === 0) return null;
  return (
    <ul aria-label="Mentioned files" className="flex flex-wrap gap-1.5 px-1">
      {chips.map((path) => {
        const name = path.slice(path.lastIndexOf("/") + 1);
        return (
          <li key={path} className={CHIP} title={sandboxPathOf(path)}>
            <FileIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
            <span className="truncate font-medium">@{path}</span>
            <button
              type="button"
              aria-label={`Remove mention of ${name}`}
              className="hover:bg-muted rounded p-0.5"
              onClick={() => {
                store.removeChip(draft, path);
                onRemoved?.();
              }}
            >
              <XIcon aria-hidden className="size-3" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
