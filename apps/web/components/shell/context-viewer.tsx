"use client";

import type { ThreadContext, ThreadContextMemories, ThreadStats } from "@kaiju/protocol";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { formatTokens } from "../../lib/admin/usage-format";
import { memoryLanes } from "../../lib/chat/context-memories";
import { SET_BY_SITE } from "../../lib/memory/items-api";
import {
  WAKE_GIVE_UP_MS,
  approximateNotice,
  contextDownload,
  formatShare,
  gaugeModel,
  nextWakeDelay,
  type ContextRead,
  type GaugeKind,
  type GaugeModel,
} from "../../lib/chat/context-viewer";
import { saveBytes } from "../../lib/files/save";
import type { Panel } from "../../lib/shell/panels";
import { useKaijuExtras } from "../chat/kaiju-runtime";
import { ContextBoundary } from "./context-boundary";
import { ContextStack } from "./context-stack";
import { ContextStats, useStatsRead } from "./context-stats";
import { ContextText } from "./context-text";
import { IconAction } from "./icon-action";
import { WorkspacePanel } from "./workspace-panel";
import styles from "./context-viewer.module.css";

const PANEL: Panel = { id: "context-viewer", title: "Context", embedded: true };

const TOO_LONG = "Your sandbox is taking too long to wake. Try again in a moment.";

type Phase =
  | { readonly status: "loading" }
  | { readonly status: "waking"; readonly since: number }
  | { readonly status: "ready" }
  | { readonly status: "error"; readonly message: string; readonly terminal: boolean };

/**
 * Reads the context on open and on each `again()`: while the workspace wakes (202) it asks again
 * after the server's hint, backed off and capped, well under the route's 30 reads a minute, and
 * gives up after a few minutes. A terminal error stops it.
 */
function useContextRead(read: () => Promise<ContextRead> | null) {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ status: "loading" });
  const [context, setContext] = useState<ThreadContext | null>(null);
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  });
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const ask = (n: number) => {
      const pending = readRef.current();
      if (pending === null) return;
      void pending.then((r) => {
        if (!current) return;
        if (r.kind === "ready") {
          setContext(r.context);
          setPhase({ status: "ready" });
        } else if (r.kind === "error") {
          setPhase({ status: "error", message: r.message, terminal: r.terminal });
        } else if (Date.now() - started > WAKE_GIVE_UP_MS) {
          setPhase({ status: "error", message: TOO_LONG, terminal: false });
        } else {
          setPhase({ status: "waking", since: started });
          timer = setTimeout(() => ask(n + 1), nextWakeDelay(n, r.retryAfterMs));
        }
      });
    };
    setPhase({ status: "loading" });
    ask(0);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [attempt]);
  return { phase, context, attempt, again: () => setAttempt((n) => n + 1) };
}

/** "Waking your sandbox… 6 s", counting while it wakes. */
function WakeProgress({ since }: { readonly since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.max(0, Math.round((now - since) / 1_000));
  return (
    <p className={styles.status} role="status">
      <span className={styles.spinner} aria-hidden="true" />
      Waking your sandbox… {seconds} s
    </p>
  );
}

function summaryOf(context: ThreadContext, model: GaugeModel): string {
  const { total, window } = model;
  const used =
    window === null
      ? `${formatTokens(total)} tokens`
      : `${formatTokens(total)} of ${formatTokens(window)} tokens (${formatShare(total / window)})`;
  const parts = [used];
  if (context.model !== null) parts.push(context.model);
  if (context.captured_at !== null) {
    parts.push(`as of ${new Date(context.captured_at).toLocaleTimeString()}`);
  }
  return parts.join(" · ");
}

function Notices({ context }: { readonly context: ThreadContext }) {
  const approximate = approximateNotice(context);
  return (
    <>
      {approximate !== null && (
        <p className={styles.notice} role="note" data-context-approximate>
          {approximate}
        </p>
      )}
      {context.source === "none" && (
        <p className={styles.notice} role="note">
          No model call yet in this conversation.
        </p>
      )}
      {context.truncated && (
        <p className={styles.notice} role="note">
          {context.omitted_sections > 0
            ? `Some sections were shortened, and ${context.omitted_sections} left out of the middle, to fit.`
            : "Some sections were shortened to fit."}
        </p>
      )}
      {context.tokens_basis === "estimate" && (
        <p className={styles.notice} role="note">
          The model reported no usage for this call: the token counts are estimates.
        </p>
      )}
    </>
  );
}

/** Reads the memories the latest run was given (KOBE-382) on open and with each refresh. */
function useMemoriesRead(
  read: (() => Promise<ThreadContextMemories | null> | null) | undefined,
  attempt: number,
) {
  const [memories, setMemories] = useState<ThreadContextMemories | null>(null);
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  });
  useEffect(() => {
    let current = true;
    void readRef.current?.()?.then((m) => {
      if (current) setMemories(m);
    });
    return () => {
      current = false;
    };
  }, [attempt]);
  return memories;
}

/**
 * Memories in context (KOBE-382, U48): what the latest run was given, per lane (Policy, Site,
 * Workspace, then the owner's own), from the run's records. Statements are plain text. Policy and
 * Site memories say "Set by the Site" (KOBE-670), never their source Workspace.
 */
function ContextMemoriesList({ memories }: { readonly memories: ThreadContextMemories }) {
  if (memories.items.length === 0) return null;
  return (
    <details className={styles.memories} data-context-memories>
      <summary>Memories in context ({memories.items.length})</summary>
      {!memories.latest && (
        <p className={styles.memoryNote} role="note" data-memories-earlier>
          From an earlier message: the newest one has not been given its memories yet.
        </p>
      )}
      {memoryLanes(memories.items).map((lane) => (
        <section key={lane.lane} aria-label={lane.label} data-memory-lane={lane.lane}>
          <h3 className={styles.memoryLane}>{lane.label}</h3>
          <ul className={styles.memoryList}>
            {lane.items.map((item) => (
              <li key={item.id}>
                {item.pinned && <span className={styles.memoryPin}>Pinned · </span>}
                {(item.lane === "site" || item.lane === "policy") && (
                  <span className={styles.memorySite}>{SET_BY_SITE} · </span>
                )}
                {item.statement}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </details>
  );
}

function PhaseLine({ phase, onRetry }: { readonly phase: Phase; readonly onRetry: () => void }) {
  if (phase.status === "loading") {
    return (
      <p className={styles.status} role="status">
        <span className={styles.spinner} aria-hidden="true" />
        Reading the context…
      </p>
    );
  }
  if (phase.status === "waking") return <WakeProgress since={phase.since} />;
  if (phase.status === "error") {
    return (
      <div className={styles.error} role="alert">
        <span>{phase.message}</span>
        {!phase.terminal && (
          <button type="button" className={styles.smallButton} onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    );
  }
  return null;
}

/**
 * The context viewer (KOBE-471, docs/specs/context-viewer.md): what the thread's latest model call
 * sent the model, read live from the owner's sandbox. A panel over the workspace like the
 * consoles (`WorkspacePanel`: modal, Escape and Close return focus to the gauge), rendered by
 * `ContextViewerHost` beside the workspace grid as the Threads panel is, so it covers the window. The text takes two thirds of the width; the stacked gauge
 * and its legend the rest (stacked above the text at phone width). A legend row filters the text
 * to its kind; Download saves what the panel holds as text (KOBE-841). Owner only: the gauge offers it
 * only on the member's own thread (the route answers 403 to anyone else). Conversation stats
 * (KOBE-842) sit under the gauge and its legend, read from the database (no sandbox), so they
 * show even while the sandbox wakes or the context cannot be read; Refresh reads them again.
 */
export function ContextViewer({
  read,
  readMemories,
  readStats,
  fallbackWindow,
  onClose,
}: {
  readonly read: () => Promise<ContextRead> | null;
  /** The latest run's memories (KOBE-382); absent: not shown. */
  readonly readMemories?: () => Promise<ThreadContextMemories | null> | null;
  /** The conversation's stats (KOBE-842); absent: not shown. */
  readonly readStats?: () => Promise<ThreadStats | null> | null;
  /** The gauge's window (the thread's next model), used when the answer has none. */
  readonly fallbackWindow: number | null;
  readonly onClose: () => void;
}) {
  const { phase, context, again, attempt } = useContextRead(read);
  const memories = useMemoriesRead(readMemories, attempt);
  const stats = useStatsRead(readStats, attempt);
  const [filter, setFilter] = useState<{ context: ThreadContext; kind: GaugeKind } | null>(null);
  // A Refresh's new answer starts unfiltered.
  const shownFilter = filter !== null && filter.context === context ? filter.kind : null;
  const pick = (kind: GaugeKind) => {
    if (context === null) return;
    setFilter(shownFilter === kind ? null : { context, kind });
  };
  const download = () => {
    if (context === null) return;
    const { filename, text } = contextDownload(context, new Date());
    saveBytes(filename, new TextEncoder().encode(text));
  };
  const model = useMemo(
    () => (context === null ? null : gaugeModel(context, fallbackWindow)),
    [context, fallbackWindow],
  );
  const busy = phase.status === "loading" || phase.status === "waking";
  return (
    <WorkspacePanel panel={PANEL} path="context-viewer" onClose={onClose}>
      <div className={styles.viewer} data-context-viewer>
        <div className={styles.toolbar}>
          <p className={styles.summary}>
            {context !== null && model !== null ? summaryOf(context, model) : ""}
          </p>
          <IconAction
            command="download-file"
            label="Download the context"
            aria-disabled={context === null}
            onClick={context === null ? undefined : download}
          />
          <IconAction
            command="refresh-files"
            label="Refresh the context"
            aria-disabled={busy}
            onClick={busy ? undefined : again}
          />
        </div>
        <PhaseLine phase={phase} onRetry={again} />
        {context !== null && <Notices context={context} />}
        {memories !== null && <ContextMemoriesList memories={memories} />}
        {context !== null && model !== null && (
          <ContextBoundary>
            <div className={styles.columns}>
              <ContextText
                sections={context.sections}
                filter={shownFilter}
                onClearFilter={() => setFilter(null)}
              />
              <div className={styles.side}>
                <ContextStack
                  model={model}
                  selected={shownFilter}
                  memoryUnknown={context.missing.includes("memory")}
                  onPick={pick}
                />
                {readStats !== undefined && <ContextStats stats={stats} />}
              </div>
            </div>
          </ContextBoundary>
        )}
        {(context === null || model === null) && readStats !== undefined && (
          <ContextStats stats={stats} />
        )}
      </div>
    </WorkspacePanel>
  );
}

/** Opens the viewer on the thread on screen, with the gauge's window; null: not offered here. */
type OpenViewer = (fallbackWindow: number | null) => void;

const OpenViewerContext = createContext<OpenViewer | null>(null);

/** The context gauge's way to open the viewer (KOBE-471); null outside the workspace. */
export function useOpenContextViewer(): OpenViewer | null {
  return useContext(OpenViewerContext);
}

/**
 * Holds the context viewer of the workspace (KOBE-471): the gauge under the composer opens it,
 * and it renders after `children` (the workspace grid), outside the composer, so the panel is
 * not inside the conversation's layout. It closes when another thread comes on screen.
 */
export function ContextViewerHost({ children }: { readonly children: ReactNode }) {
  const extras = useKaijuExtras();
  const threadId = extras?.state.threadId ?? null;
  const controller = extras?.controller ?? null;
  const [open, setOpen] = useState<{ threadId: string; window: number | null } | null>(null);
  const show = useCallback<OpenViewer>(
    (window) => {
      if (threadId !== null) setOpen({ threadId, window });
    },
    [threadId],
  );
  const close = useCallback(() => setOpen(null), []);
  // Another thread on screen closes it: coming back does not reopen it.
  if (open !== null && open.threadId !== threadId) setOpen(null);
  return (
    <OpenViewerContext.Provider value={threadId === null ? null : show}>
      {children}
      {open !== null && open.threadId === threadId && controller !== null && (
        <ContextViewer
          read={controller.threadContext}
          readMemories={controller.threadContextMemories}
          readStats={controller.threadStats}
          fallbackWindow={open.window}
          onClose={close}
        />
      )}
    </OpenViewerContext.Provider>
  );
}
