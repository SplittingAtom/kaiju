import { createListenClient, type ListenClient } from "../pg-listen.js";
import {
  decodeAccessHint,
  decodeHint,
  decodeWorkspaceAccessHint,
  decodeWorkspaceHint,
  RUN_EVENTS_CHANNEL,
} from "./notify.js";

/** What a stream hears from the hub. Every call means "re-read Postgres"; none carries content. */
export interface HubSubscriber {
  /** A transaction committed events of this run up to `seq`. */
  hint(seq: number): void;
  /** Notifications may have been missed (listener (re)connected or down): re-read now. */
  resync(): void;
  /** Who may watch this run changed (KOBE-221): recheck the viewer now. */
  revalidate?(): void;
  /** The hub is shutting down: end the stream so the client reconnects to another replica. */
  close(): void;
}

/** A workspace change stream (KOBE-496): every call means "re-read Postgres". */
export interface WorkspaceHubSubscriber {
  /** A transaction committed a new revision of this user's workspace (in some team). */
  changed(): void;
  /** Notifications may have been missed (listener (re)connected or down): re-read now. */
  resync(): void;
  /** The user lost access somewhere (removed, deactivated) or hints were missed: recheck now. */
  revalidate?(): void;
  /** The hub is shutting down: end the stream so the client reconnects to another replica. */
  close(): void;
}

export interface RunEventHub {
  /** Starts listening (lazily, once) and registers a subscriber for one run. Returns unsubscribe. */
  subscribe(runId: string, subscriber: HubSubscriber): () => void;
  /** The same for one user's workspace changes (KOBE-496), on the same LISTEN connection. */
  subscribeWorkspace(userId: string, subscriber: WorkspaceHubSubscriber): () => void;
  /** Reserves one of the user's concurrent stream slots on this replica; null when at the cap. */
  acquireSlot(userId: string): (() => void) | null;
  /**
   * The same for workspace change streams (KOBE-496), counted apart from run streams: a page
   * holds one for as long as it shows file tabs, so they must never use up the run streams' slots.
   */
  acquireWorkspaceSlot(userId: string): (() => void) | null;
  /** `listening` once the LISTEN connection is up. */
  readonly state: HubState;
  /** Number of subscribed streams (all runs). */
  readonly size: number;
  close(): Promise<void>;
}

export type HubState = "idle" | "connecting" | "listening" | "down" | "closed";

export interface HubOptions {
  /** The process's shared LISTEN connection (KOBE-704); the hub never closes it. */
  readonly listen?: ListenClient;
  /**
   * Without `listen`: app-role URL of a LISTEN connection of the hub's own (tests). Must reach
   * Postgres directly or via a session-mode pooler (LISTEN is per session).
   */
  readonly connectionString?: string;
  readonly maxStreamsPerUser?: number;
  /**
   * Concurrent workspace streams per user on this replica: a page holds up to two (file tabs'
   * changes, KOBE-496; the Files panel's events, KOBE-599).
   */
  readonly maxWorkspaceStreamsPerUser?: number;
  /**
   * While the listener is down, workspace change streams re-read this often (they live as long as
   * a page, so they are not polled at the run streams' rate).
   */
  readonly workspaceDegradedPollMs?: number;
  /** Own LISTEN connection only (without `listen`): its reconnect backoff. */
  readonly reconnectMinMs?: number;
  readonly reconnectMaxMs?: number;
  /** While the listener is down, subscribers re-read this often instead of waiting for hints. */
  readonly degradedPollMs?: number;
  /** Own LISTEN connection only: its health check (detects half-open TCP). */
  readonly pingMs?: number;
  /** Own LISTEN connection only: a ping, LISTEN or the probe not answered within this is lost. */
  readonly pingTimeoutMs?: number;
  /** Resyncs after a (re)connect are spread over this window, one random delay per run. */
  readonly resyncJitterMs?: number;
}

export const HUB_DEFAULTS = {
  maxStreamsPerUser: 16,
  maxWorkspaceStreamsPerUser: 16,
  workspaceDegradedPollMs: 20_000,
  reconnectMinMs: 250,
  reconnectMaxMs: 10_000,
  degradedPollMs: 1_000,
  pingMs: 30_000,
  pingTimeoutMs: 10_000,
  resyncJitterMs: 1_000,
} as const;

/** Probe payloads of hubs before KOBE-704 (they probed on this channel): ignored. */
const LEGACY_PROBE_PREFIX = "probe:";

/**
 * Postgres LISTEN/NOTIFY fan-out for one server process (spec D16, no Redis). The process's one
 * shared LISTEN connection ({@link ListenClient}, KOBE-704) carries {@link RUN_EVENTS_CHANNEL},
 * however many streams are open, so streams never exhaust connections; it lives outside the query
 * pool so a stream never holds a pool slot while idle. Notifications are only hints dispatched to
 * the subscribers of that run; after any (re)connect every subscriber resyncs, and while the
 * listener is down subscribers are polled, so a missed notification delays an event but never
 * loses it.
 */
export function createRunEventHub(options: HubOptions): RunEventHub {
  const opts = { ...HUB_DEFAULTS, ...options };
  const byRun = new Map<string, Set<HubSubscriber>>();
  const byUser = new Map<string, Set<WorkspaceHubSubscriber>>();
  const slots = new Map<string, number>();
  const workspaceSlots = new Map<string, number>();
  let lastWorkspacePoll = 0;
  const owned = options.listen
    ? undefined
    : createListenClient({
        connectionString: requiredUrl(options.connectionString),
        applicationName: "kaiju-event-hub",
        reconnectMinMs: opts.reconnectMinMs,
        reconnectMaxMs: opts.reconnectMaxMs,
        pingMs: opts.pingMs,
        pingTimeoutMs: opts.pingTimeoutMs,
      });
  const listen = options.listen ?? (owned as ListenClient);
  let started = false;
  let closed = false;
  let listening = false;
  let unlisten: (() => void) | undefined;
  let pollTimer: NodeJS.Timeout | undefined;

  const each = (fn: (s: { close(): void }) => void) => {
    for (const set of byRun.values()) for (const s of [...set]) fn(s);
    for (const set of byUser.values()) for (const s of [...set]) fn(s);
  };

  /**
   * Every subscriber re-reads, spread over `windowMs` with one random delay per run: the watchers
   * of one run wake together (their reads coalesce into one query in the stream reader) while
   * different runs don't all hit the database in the same instant.
   */
  const resyncAll = (windowMs: number, workspaces = true) => {
    for (const runId of byRun.keys()) {
      const fire = () => {
        const current = byRun.get(runId);
        if (current) {
          for (const s of [...current]) {
            s.resync();
            // Access hints may have been missed too (KOBE-221): recheck the viewers.
            s.revalidate?.();
          }
        }
      };
      if (windowMs <= 0) fire();
      else setTimeout(fire, Math.random() * windowMs).unref();
    }
    if (!workspaces) return;
    // Workspace streams: one random delay per user (their pages read together).
    for (const userId of byUser.keys()) {
      const fire = () => {
        for (const s of [...(byUser.get(userId) ?? [])]) {
          s.resync();
          s.revalidate?.(); // a removal's hint may have been missed too
        }
      };
      if (windowMs <= 0) fire();
      else setTimeout(fire, Math.random() * windowMs).unref();
    }
  };

  const dispatch = (payload: string) => {
    if (payload.startsWith(LEGACY_PROBE_PREFIX)) return;
    const workspaceUser = decodeWorkspaceHint(payload);
    if (workspaceUser !== undefined) {
      const watchers = byUser.get(workspaceUser);
      if (watchers) for (const s of [...watchers]) s.changed();
      return;
    }
    const workspaceAccess = decodeWorkspaceAccessHint(payload);
    if (workspaceAccess !== undefined) {
      const watchers = byUser.get(workspaceAccess);
      if (watchers) for (const s of [...watchers]) s.revalidate?.();
      return;
    }
    const access = decodeAccessHint(payload);
    if (access !== undefined) {
      const watchers = byRun.get(access);
      if (watchers) for (const s of [...watchers]) s.revalidate?.();
      return;
    }
    const hint = decodeHint(payload);
    if (!hint) return;
    const set = byRun.get(hint.runId);
    if (set) for (const s of [...set]) s.hint(hint.seq);
  };

  const startPolling = () => {
    pollTimer ??= setInterval(() => {
      const now = Date.now();
      const workspaces = now - lastWorkspacePoll >= opts.workspaceDegradedPollMs;
      if (workspaces) lastWorkspacePoll = now;
      resyncAll(opts.degradedPollMs, workspaces);
    }, opts.degradedPollMs);
    pollTimer.unref();
  };
  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
  };
  /** Subscribes to the shared connection on first use; kept until close(). */
  const start = () => {
    if (started) return;
    started = true;
    unlisten = listen.subscribe(RUN_EVENTS_CHANNEL, {
      notification: dispatch,
      listening: () => {
        listening = true;
        stopPolling();
        // Anything committed before LISTEN took effect was not heard: everyone re-reads once.
        resyncAll(opts.resyncJitterMs);
      },
      polling: () => {
        const wasListening = listening;
        listening = false;
        startPolling();
        // A lost connection: hints may have been missed, re-read now.
        if (wasListening) resyncAll(0);
      },
    });
  };

  /** Takes one of `userId`'s slots in `slots` (null at `max`); returns its release. */
  function takeSlot(slots: Map<string, number>, userId: string, max: number) {
    const used = slots.get(userId) ?? 0;
    if (used >= max) return null;
    slots.set(userId, used + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (slots.get(userId) ?? 1) - 1;
      if (n <= 0) slots.delete(userId);
      else slots.set(userId, n);
    };
  }

  /** Adds `subscriber` under `id`, starting the listener on first use; returns unsubscribe. */
  function register<S>(map: Map<string, Set<S>>, id: string, subscriber: S): () => void {
    const key = id.toLowerCase();
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(subscriber);
    start(); // polls until the first LISTEN is up
    return () => {
      const current = map.get(key);
      if (!current) return;
      current.delete(subscriber);
      if (current.size === 0) map.delete(key);
    };
  }

  return {
    get state(): HubState {
      if (closed) return "closed";
      if (!started) return "idle";
      if (listening) return "listening";
      return listen.state === "connecting" ? "connecting" : "down";
    },
    get size() {
      let n = 0;
      for (const set of byRun.values()) n += set.size;
      for (const set of byUser.values()) n += set.size;
      return n;
    },
    subscribe(runId, subscriber) {
      if (closed) {
        queueMicrotask(() => subscriber.close());
        return () => undefined;
      }
      return register(byRun, runId, subscriber);
    },
    subscribeWorkspace(userId, subscriber) {
      if (closed) {
        queueMicrotask(() => subscriber.close());
        return () => undefined;
      }
      return register(byUser, userId, subscriber);
    },
    acquireSlot: (userId) => takeSlot(slots, userId, opts.maxStreamsPerUser),
    acquireWorkspaceSlot: (userId) =>
      takeSlot(workspaceSlots, userId, opts.maxWorkspaceStreamsPerUser),
    async close() {
      if (closed) return;
      closed = true;
      listening = false;
      stopPolling();
      unlisten?.();
      each((s) => s.close());
      byRun.clear();
      byUser.clear();
      await owned?.close();
    },
  };
}

function requiredUrl(url: string | undefined): string {
  if (!url) throw new Error("the event hub needs a shared LISTEN client or a connection string");
  return url;
}
