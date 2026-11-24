"use client";

import {
  BrainCircuitIcon,
  BrainIcon,
  InboxIcon,
  Loader2Icon,
  PlusIcon,
  RotateCwIcon,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useId, useRef, useState } from "react";
import {
  LONG_DELTA_TOKENS,
  TO_REVIEW_HREF,
  learnBlocker,
  learnIndicator,
  tokensLabel,
  type LearnState,
} from "../../lib/chat/learn-api";
import type { MenuBindings } from "../../lib/shell/menu";
import { useBindCommands } from "../shell/command-bindings";
import markStyles from "../shell/icon-action.module.css";
import { claimNudge } from "../../lib/chat/learn-nudge";
import nudgeStyles from "./plus-learn.module.css";
import { useNavigate } from "../shell/use-navigate";
import { chatPortalContainer } from "../ui/chat-portal";
import { PLUS_CONTENT, PLUS_ITEM } from "./plus-menu-styles";
import type { Learn } from "./use-learn";

/** Before the first message there is nothing to learn from. */
export const NOT_STARTED_LEARN =
  "Kaiju learns from a conversation once a reply has finished. Send a message first.";
/** The one-time "New" hint on Memory (per browser), until the member opens it once. */
export const LEARN_HINT_KEY = "kobe.learn-hint.v1";

function hintSeen(): boolean {
  try {
    return localStorage.getItem(LEARN_HINT_KEY) === "seen";
  } catch {
    return true;
  }
}
function markHintSeen() {
  try {
    localStorage.setItem(LEARN_HINT_KEY, "seen");
  } catch {
    // Storage blocked: the hint simply shows again next time.
  }
}

/**
 * The + button's face for the Learn state: what it says (its tooltip's second line and accessible
 * description; the name stays "Add to your message") and which mark it shows.
 */
export function plusIndicator(state: LearnState | null): {
  readonly description?: string;
  readonly mark: "spinner" | "count" | "dot" | null;
  readonly count?: number;
} {
  const ind = learnIndicator(state);
  if (ind.kind === "running")
    return { description: "Kaiju is learning from this chat", mark: "spinner" };
  if (ind.kind === "candidates")
    return {
      description: `${ind.count === 1 ? "1 memory suggestion" : `${ind.count} memory suggestions`} to review (Memory)`,
      mark: "count",
      count: ind.count,
    };
  if (ind.kind === "new")
    return { description: "New messages to learn from (Memory)", mark: "dot" };
  return { mark: null };
}

/** How long the nudge's pulse lasts (the CSS animation: two beats). */
export const LEARN_NUDGE_PULSE_MS = 2_400;

/**
 * The Learn nudge (KOBE-410): true while the dot pulses, once per crossing the server names
 * (`state.nudge.key`) per thread, only while the dot shows. A hint: it never starts a pass.
 */
export function useLearnNudge(threadId: string | null, state: LearnState | null): boolean {
  const [pulse, setPulse] = useState(false);
  // The crossing this + claimed (a re-run of the effect before the pulse ends keeps it), and the
  // one it finished pulsing.
  const claimed = useRef<string | null>(null);
  const done = useRef<string | null>(null);
  const key = state?.nudge?.key ?? null;
  const dot = plusIndicator(state).mark === "dot";
  useEffect(() => {
    if (threadId === null || key === null || !dot) return undefined;
    const crossing = `${threadId} ${key}`;
    if (done.current === crossing) return undefined;
    if (claimed.current !== crossing) {
      if (!claimNudge(threadId, key)) return undefined;
      claimed.current = crossing;
    }
    setPulse(true);
    const timer = setTimeout(() => {
      done.current = crossing;
      setPulse(false);
    }, LEARN_NUDGE_PULSE_MS);
    return () => {
      clearTimeout(timer);
      setPulse(false);
    };
  }, [threadId, key, dot]);
  return pulse;
}

/** The + with its Learn mark: a spinner, the count (1–99, then 99+) or a dot (`pulse`: the nudge). */
export function PlusFace({
  face,
  pulse = false,
}: {
  readonly face: ReturnType<typeof plusIndicator>;
  readonly pulse?: boolean;
}) {
  return (
    <>
      <PlusIcon aria-hidden />
      {face.mark === "spinner" && (
        <Loader2Icon
          aria-hidden
          data-kobe-learn-mark="spinner"
          className="text-primary absolute -end-0.5 -top-0.5 size-3 animate-spin"
        />
      )}
      {face.mark === "count" && (
        <span className={markStyles.count} data-kobe-learn-mark="count" aria-hidden="true">
          {(face.count ?? 0) > 99 ? "99+" : face.count}
        </span>
      )}
      {face.mark === "dot" && (
        <span
          className={pulse ? `${markStyles.dot} ${nudgeStyles.pulse}` : markStyles.dot}
          data-kobe-learn-mark="dot"
          data-kobe-learn-nudge={pulse ? "pulse" : undefined}
          aria-hidden="true"
        />
      )}
    </>
  );
}

/** Mod+Shift+L, `/learn`, `/learn all` and the palette run these, as the menu items do. */
export function useLearnBindings(learn: Learn, threadId: string | null): void {
  const { state } = learn;
  const bindings: MenuBindings = {
    learn:
      threadId === null
        ? { blocker: NOT_STARTED_LEARN }
        : {
            onSelect: () => void learn.start("new"),
            blocker:
              state === null
                ? null
                : (state.blocker?.message ??
                  (state.running === null ? null : "Kaiju is already learning from this chat.")),
            choices: [
              {
                key: "new",
                label: "New messages since the last pass",
                onSelect: () => void learn.start("new"),
              },
              {
                key: "all",
                label: "The whole chat (rescan)",
                onSelect: () => void learn.start("all"),
              },
            ],
          },
  };
  useBindCommands(bindings);
}

function Reason({ id, text }: { readonly id: string; readonly text: string }) {
  return (
    <span id={id} className="text-muted-foreground ms-auto max-w-40 truncate ps-2 text-xs">
      {text}
    </span>
  );
}

/**
 * The + menu's Memory (KOBE-395; SM12, Q8): Learn from this chat (what is new since the last
 * pass), Rescan the whole chat, and the candidates from this chat waiting in To review. An item
 * that can't run stays focusable, disabled, with the reason beside it (switch, model, budget, a
 * test chat, nothing new). Estimates show for rescans and long deltas. Opening the submenu reads
 * the state again with the estimates; the "New" hint shows where Learn can run, until the member
 * opens Memory once (per browser).
 */
export function MemorySubmenu({
  learn,
  threadId,
}: {
  readonly learn: Learn;
  readonly threadId: string | null;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const newId = useId();
  const allId = useId();
  const triggerId = useId();
  const { state, refresh } = learn;
  useEffect(() => setUnseen(!hintSeen()), []);
  useEffect(() => {
    if (!open) return;
    markHintSeen();
    setUnseen(false);
    void refresh(true);
  }, [open, refresh]);

  const newBlocker = threadId === null ? NOT_STARTED_LEARN : learnBlocker(state, "new");
  const allBlocker = threadId === null ? NOT_STARTED_LEARN : learnBlocker(state, "all");
  const est = state?.estimate ?? null;
  const newNote =
    newBlocker ??
    (est?.newTokens != null && est.newTokens >= LONG_DELTA_TOKENS
      ? tokensLabel(est.newTokens)
      : null);
  const allNote = allBlocker ?? (est === null ? null : tokensLabel(est.allTokens));
  const waiting = state?.candidates ?? 0;
  const running = state?.running != null;
  // Only where Learn can run: a hint for something switched off is noise.
  const hint = unseen && state !== null && state.blocker === null;

  return (
    <DropdownMenu.Sub open={open} onOpenChange={setOpen}>
      <DropdownMenu.SubTrigger
        className={PLUS_ITEM}
        data-kobe-plus="memory"
        aria-describedby={hint || waiting > 0 || running ? triggerId : undefined}
      >
        <BrainIcon aria-hidden className="size-4 shrink-0" />
        Memory
        {(hint || waiting > 0 || running) && (
          <span id={triggerId} className="text-muted-foreground ms-auto text-xs">
            {running ? "Learning…" : waiting > 0 ? `${waiting} to review` : "New"}
          </span>
        )}
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal container={chatPortalContainer()}>
        <DropdownMenu.SubContent
          data-kobe-portal
          aria-label="Memory"
          data-kobe-memory-menu=""
          sideOffset={4}
          className={PLUS_CONTENT}
        >
          <DropdownMenu.Item
            className={PLUS_ITEM}
            data-command="learn"
            data-kobe-learn="new"
            aria-disabled={newBlocker !== null || undefined}
            aria-describedby={newNote === null ? undefined : newId}
            onSelect={(e) => {
              if (newBlocker !== null) e.preventDefault();
              else void learn.start("new");
            }}
          >
            {running ? (
              <Loader2Icon aria-hidden className="size-4 shrink-0 animate-spin" />
            ) : (
              <BrainCircuitIcon aria-hidden className="size-4 shrink-0" />
            )}
            Learn from this chat
            {newNote !== null && <Reason id={newId} text={newNote} />}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={PLUS_ITEM}
            data-kobe-learn="all"
            aria-disabled={allBlocker !== null || undefined}
            aria-describedby={allNote === null ? undefined : allId}
            onSelect={(e) => {
              if (allBlocker !== null) e.preventDefault();
              else void learn.start("all");
            }}
          >
            <RotateCwIcon aria-hidden className="size-4 shrink-0" />
            Rescan the whole chat
            {allNote !== null && <Reason id={allId} text={allNote} />}
          </DropdownMenu.Item>
          {waiting > 0 && (
            <DropdownMenu.Item
              className={PLUS_ITEM}
              data-kobe-learn="review"
              onSelect={() => navigate(TO_REVIEW_HREF)}
            >
              <InboxIcon aria-hidden className="size-4 shrink-0" />
              Review {waiting === 1 ? "1 candidate" : `${waiting} candidates`}
            </DropdownMenu.Item>
          )}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}
