import { z } from "zod";
import { sql, type KaijuDb, type KaijuTx } from "@kaiju/db";
import { logger as rootLogger } from "../logger.js";
import { createListenClient, type ListenClient } from "../pg-listen.js";
import { SANDBOX_CHANNEL } from "./constants.js";

/**
 * Hints between replicas (spec D13: "server replicas route commands to whichever replica holds a
 * sandbox's socket via Postgres LISTEN/NOTIFY"; no Redis). A hint only says "look at Postgres":
 * payloads carry one id (any database session can LISTEN on any channel, so never team ids,
 * content or tokens), receivers re-read the row under their own team's RLS, and a lost or forged
 * hint costs at most a delay (every waiter also polls) or one extra read.
 */
export type BusHint =
  /** Commands are pending for this connection: its holder delivers them. */
  | { readonly kind: "cmd"; readonly id: string }
  /** This command has a result: its requester reads it. */
  | { readonly kind: "res"; readonly id: string }
  /** This connection was replaced by a newer one of the same sandbox: its holder closes it. */
  | { readonly kind: "kick"; readonly id: string }
  /** This user was deactivated or left a team: every replica re-checks their connections. */
  | { readonly kind: "user"; readonly id: string }
  /** This connection's sandbox was hibernated (KOBE-25): its holder closes it `hibernating`. */
  | { readonly kind: "hib"; readonly id: string }
  /** This approval left `pending` (KOBE-37): the broker waiting on it re-reads the row. */
  | { readonly kind: "apr"; readonly id: string }
  /** The member moved files (KOBE-304): this connection's holder sends `workspace.moved`. */
  | { readonly kind: "mv"; readonly id: string }
  /**
   * Refresh in the Files panel (KOBE-599): this connection's holder sends `workspace.sync_now`
   * with `request` (a random id the requester waits on; two ids, nothing else).
   */
  | { readonly kind: "sync"; readonly id: string; readonly request: string }
  /** The sync asked for by request `id` finished (`synced`) or could not run (`unsynced`). */
  | { readonly kind: "synced"; readonly id: string }
  | { readonly kind: "unsynced"; readonly id: string };

const KINDS = new Set(["cmd", "res", "kick", "user", "hib", "apr", "mv", "synced", "unsynced"]);
const uuid = z.uuid();

export function encodeBusHint(hint: BusHint): string {
  return hint.kind === "sync" ? `sync:${hint.id}:${hint.request}` : `${hint.kind}:${hint.id}`;
}

/** Never throws; undefined for anything that is not a well-formed hint. */
export function decodeBusHint(payload: string | undefined): BusHint | undefined {
  if (payload === undefined || payload.length > 96) return undefined;
  const sep = payload.indexOf(":");
  const kind = payload.slice(0, sep);
  const id = payload.slice(sep + 1);
  if (kind === "sync") {
    const [connection = "", request = "", ...rest] = id.split(":");
    if (rest.length > 0 || !uuid.safeParse(connection).success) return undefined;
    if (!uuid.safeParse(request).success) return undefined;
    return { kind, id: connection.toLowerCase(), request: request.toLowerCase() };
  }
  if (payload.length > 64) return undefined;
  if (sep < 0 || !KINDS.has(kind) || !uuid.safeParse(id).success) return undefined;
  return { kind, id: id.toLowerCase() } as BusHint;
}

/** Queues a hint inside `tx` (delivered on commit) without a bus instance (any process). */
export async function notifyHintInTx(tx: KaijuTx, hint: BusHint): Promise<void> {
  await tx.execute(sql`SELECT pg_notify(${SANDBOX_CHANNEL}, ${encodeBusHint(hint)})`);
}

export type BusState = "idle" | "connecting" | "listening" | "down" | "closed";

export interface SandboxBus {
  /** Starts listening (idempotent). */
  start(): void;
  /** Queues a hint inside `tx`: Postgres delivers it on commit, never for a rollback. */
  notifyInTx(tx: KaijuTx, hint: BusHint): Promise<void>;
  /** Sends a hint now (outside any transaction). */
  notify(db: KaijuDb, hint: BusHint): Promise<void>;
  readonly state: BusState;
  close(): Promise<void>;
}

export interface BusOptions {
  /** The process's shared LISTEN connection (KOBE-704); the bus never closes it. */
  readonly listen?: ListenClient;
  /** Without `listen`: app-role URL of a LISTEN connection of the bus's own (operator CLI, tests). */
  readonly connectionString?: string;
  readonly onHint: (hint: BusHint) => void;
  /** Hints may have been missed (listener (re)connected or down): re-read everything. */
  readonly onResync: () => void;
  /** Own LISTEN connection only: its reconnect backoff. */
  readonly reconnectMinMs?: number;
  readonly reconnectMaxMs?: number;
  readonly degradedPollMs?: number;
}

/**
 * {@link SANDBOX_CHANNEL} on the process's shared LISTEN connection (KOBE-704; same design as the
 * event-stream hub, KOBE-31): resync after every (re)connect, poll while down. The connection
 * reconnects with jittered backoff and pings to catch half-open TCP. Needs a direct or
 * session-mode connection to Postgres.
 */
export function createSandboxBus(options: BusOptions): SandboxBus {
  const log = rootLogger.child({ component: "sandbox-bus" });
  const pollMs = options.degradedPollMs ?? 1_000;
  const owned = options.listen
    ? undefined
    : createListenClient({
        connectionString: requiredUrl(options.connectionString),
        applicationName: "kobe-sandbox-bus",
        ...(options.reconnectMinMs === undefined ? {} : { reconnectMinMs: options.reconnectMinMs }),
        ...(options.reconnectMaxMs === undefined ? {} : { reconnectMaxMs: options.reconnectMaxMs }),
      });
  const listen = options.listen ?? (owned as ListenClient);
  let started = false;
  let closed = false;
  let listening = false;
  let unlisten: (() => void) | undefined;
  let pollTimer: NodeJS.Timeout | undefined;

  const safely = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      log.error({ err }, "sandbox bus handler failed");
    }
  };
  const resync = () => safely(options.onResync);

  const startPolling = () => {
    pollTimer ??= setInterval(resync, pollMs);
    pollTimer.unref();
  };
  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
  };

  return {
    get state(): BusState {
      if (closed) return "closed";
      if (!started) return "idle";
      if (listening) return "listening";
      return listen.state === "connecting" ? "connecting" : "down";
    },
    start() {
      if (started || closed) return;
      started = true;
      unlisten = listen.subscribe(SANDBOX_CHANNEL, {
        notification: (payload) => {
          const hint = decodeBusHint(payload);
          if (hint) safely(() => options.onHint(hint));
        },
        listening: () => {
          listening = true;
          stopPolling();
          resync();
        },
        polling: () => {
          const wasListening = listening;
          listening = false;
          startPolling();
          if (wasListening) resync();
        },
      });
    },
    async notifyInTx(tx, hint) {
      await notifyHintInTx(tx, hint);
    },
    async notify(db, hint) {
      await db.execute(sql`SELECT pg_notify(${SANDBOX_CHANNEL}, ${encodeBusHint(hint)})`);
    },
    async close() {
      if (closed) return;
      closed = true;
      listening = false;
      stopPolling();
      unlisten?.();
      await owned?.close();
    },
  };
}

function requiredUrl(url: string | undefined): string {
  if (!url) throw new Error("the sandbox bus needs a shared LISTEN client or a connection string");
  return url;
}
