import { randomUUID } from "node:crypto";
import pg from "pg";
import { logger as rootLogger } from "./logger.js";

/**
 * One Postgres LISTEN connection per server process for every channel (KOBE-704, storage review
 * STO-5: six dedicated connections became one). Spec D16, no Redis: a notification is only a hint
 * to re-read Postgres, the durable record. The connection lives outside the query pool, so an idle
 * listener never holds a pool slot.
 *
 * - **Many subscribers per channel**, each with its own parsing; the first subscriber of a channel
 *   LISTENs it, the last one leaving UNLISTENs it. Notifications are dispatched synchronously in
 *   the order Postgres delivers them (commit order), so per-channel order is kept; a subscriber
 *   that throws is logged and the others still get the hint; nothing waits on a subscriber.
 * - **Reconnect** with exponential backoff and half jitter; a **ping** catches a half-open TCP
 *   connection (no FIN, no RST) that would otherwise stop hints silently; the lost socket is
 *   destroyed, since `end()` waits for a server that never answers.
 * - **Delivery probe** after every connect: the session notifies itself and waits for the echo.
 *   Behind a transaction-mode pooler LISTEN "succeeds" on some backend and nothing ever arrives;
 *   that is reported and the client stays down (subscribers keep polling).
 * - **State per subscriber:** `polling()` while the connection is down (or not up yet), then
 *   `listening(session)` once LISTEN on its channel is in force. Anything committed before that
 *   was not heard, so every subscriber re-reads Postgres on `listening`; a notification lost while
 *   disconnected is never the only signal.
 *
 * Payloads carry ids only (any database session may LISTEN on any channel) and stay far below
 * Postgres' 8000-byte NOTIFY payload limit.
 */

export type ListenState = "idle" | "connecting" | "listening" | "down" | "closed";

/** The connection a subscriber's `listening` call is about; `active` turns false once it is lost. */
export interface ListenSession {
  readonly active: boolean;
  /**
   * Runs a query on this LISTEN connection (a session advisory lock that must end with it, for
   * example). Rejects once the connection is lost.
   */
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

export interface ListenSubscriber {
  /** A notification on the channel (payload as sent; empty string when none). */
  notification(payload: string): void;
  /** LISTEN on the channel is in force on a (new) connection: re-read anything missed. */
  listening?(session: ListenSession): void;
  /** The connection is down or not up yet: hints are not heard until the next `listening`. */
  polling?(): void;
}

export interface ListenClient {
  /** Registers a subscriber (connecting on first use); returns its unsubscribe. */
  subscribe(channel: string, subscriber: ListenSubscriber): () => void;
  readonly state: ListenState;
  /** Channels with at least one subscriber. */
  readonly channels: readonly string[];
  close(): Promise<void>;
}

/** The part of `pg.Client` the listener uses (tests pass a fake). */
export interface ListenConnection {
  connect(): Promise<unknown>;
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
  /** Drops the socket at once (a half-open one never answers `end()`). */
  destroy(): void;
  on(
    event: "notification",
    listener: (msg: { channel: string; payload?: string | undefined }) => void,
  ): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  removeAllListeners(event?: string): unknown;
}

export interface ListenLog {
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface ListenTuning {
  readonly reconnectMinMs: number;
  readonly reconnectMaxMs: number;
  /** Health check of the connection (detects half-open TCP). */
  readonly pingMs: number;
  /** A ping, LISTEN or the probe not answered within this is a lost connection. */
  readonly pingTimeoutMs: number;
  readonly connectTimeoutMs: number;
}

export interface ListenClientOptions extends Partial<ListenTuning> {
  /** App-role URL: Postgres directly or a session-mode pooler (LISTEN is per session). */
  readonly connectionString: string;
  /** `application_name` of the session, so `pg_stat_activity` attributes it. */
  readonly applicationName: string;
  readonly log?: ListenLog;
  /** Tests: a fake client. */
  readonly createClient?: (config: pg.ClientConfig) => ListenConnection;
}

export const LISTEN_DEFAULTS: ListenTuning = {
  reconnectMinMs: 250,
  reconnectMaxMs: 10_000,
  pingMs: 30_000,
  pingTimeoutMs: 10_000,
  connectTimeoutMs: 10_000,
};

/** The listener's own channel for the delivery probe (payload: a random nonce). */
export const LISTEN_PROBE_CHANNEL = "kobe_listen_probe";

const CHANNEL = /^[a-z_][a-z0-9_]{0,62}$/;
/** How long close() waits for `end()` before dropping the socket. */
const CLOSE_TIMEOUT_MS = 2_000;
/** Server-side TCP keepalives of the LISTEN session: a dead client is dropped in ~1 min. */
const KEEPALIVES =
  "SET tcp_keepalives_idle = 30; SET tcp_keepalives_interval = 10; SET tcp_keepalives_count = 3";
/** SQLSTATE 42704: a server without `idle_session_timeout` (before PostgreSQL 14). */
const UNDEFINED_OBJECT = "42704";

/** A real `pg.Client` as a {@link ListenConnection}. */
export function pgListenConnection(config: pg.ClientConfig): ListenConnection {
  const client = new pg.Client(config);
  return {
    connect: () => client.connect(),
    query: (text, values) => client.query(text, values),
    end: () => client.end(),
    destroy: () => client.connection.stream.destroy(),
    on: (event: string, listener: (...args: never[]) => void) =>
      client.on(event as "end", listener as () => void),
    removeAllListeners: (event?: string) => client.removeAllListeners(event),
  };
}

/**
 * One query at a time on the connection (pg 9 drops queueing of concurrent `query()` calls): the
 * ping, a late LISTEN and a subscriber's session query wait for each other.
 */
function serialized(c: ListenConnection): ListenConnection {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    connect: () => c.connect(),
    query: (text, values) => {
      const run = tail.then(() => c.query(text, values));
      tail = run.catch(() => undefined);
      return run;
    },
    end: () => c.end(),
    destroy: () => c.destroy(),
    on: (event: string, listener: (...args: never[]) => void) =>
      c.on(event as "end", listener as () => void),
    removeAllListeners: (event?: string) => c.removeAllListeners(event),
  };
}

interface Entry {
  readonly subscriber: ListenSubscriber;
  /** The session this subscriber was last told `listening` about. */
  session: Session | undefined;
  /** Told `polling` since (subscribers hear each state change once, not every failed retry). */
  polled: boolean;
}

interface Session extends ListenSession {
  active: boolean;
}

export function createListenClient(options: ListenClientOptions): ListenClient {
  const tuning: ListenTuning = {
    reconnectMinMs: options.reconnectMinMs ?? LISTEN_DEFAULTS.reconnectMinMs,
    reconnectMaxMs: options.reconnectMaxMs ?? LISTEN_DEFAULTS.reconnectMaxMs,
    pingMs: options.pingMs ?? LISTEN_DEFAULTS.pingMs,
    pingTimeoutMs: options.pingTimeoutMs ?? LISTEN_DEFAULTS.pingTimeoutMs,
    connectTimeoutMs: options.connectTimeoutMs ?? LISTEN_DEFAULTS.connectTimeoutMs,
  };
  const log: ListenLog = options.log ?? rootLogger.child({ component: "pg-listen" });
  const createClient = options.createClient ?? pgListenConnection;
  const byChannel = new Map<string, Set<Entry>>();
  /** Channels LISTENed (or being LISTENed) on the current connection. */
  const listened = new Set<string>();
  /** Of those, the ones whose LISTEN has not completed yet (announced on completion). */
  const pending = new Set<string>();
  let state: ListenState = "idle";
  let client: ListenConnection | undefined;
  let session: Session | undefined;
  let attempt = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let pingTimer: NodeJS.Timeout | undefined;
  let probe: { nonce: string; resolve: () => void } | undefined;

  const guarded = (what: string, channel: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      log.error({ err, channel }, `LISTEN subscriber failed (${what})`);
    }
  };

  /** `work`, or a rejection with `message` after `pingTimeoutMs`. */
  const withTimeout = <T>(work: Promise<T>, message: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), tuning.pingTimeoutMs);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  };

  const unanswered = (what: string) => `${what} not answered within ${tuning.pingTimeoutMs} ms`;

  const dispatch = (channel: string, payload: string | undefined) => {
    if (channel === LISTEN_PROBE_CHANNEL) {
      if (probe && payload === probe.nonce) probe.resolve();
      return;
    }
    const entries = byChannel.get(channel);
    if (!entries) return;
    for (const entry of [...entries]) {
      guarded("notification", channel, () => entry.subscriber.notification(payload ?? ""));
    }
  };

  /** Tells the channel's subscribers not yet told about `s` that LISTEN is in force. */
  const announce = (channel: string, s: Session) => {
    for (const entry of [...(byChannel.get(channel) ?? [])]) {
      if (entry.session === s || !s.active) continue;
      entry.session = s;
      entry.polled = false;
      guarded("listening", channel, () => entry.subscriber.listening?.(s));
    }
  };

  const stopPing = () => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = undefined;
  };

  const scheduleReconnect = () => {
    if (state === "closed" || reconnectTimer || byChannel.size === 0) return;
    const base = Math.min(tuning.reconnectMaxMs, tuning.reconnectMinMs * 2 ** attempt);
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
    reconnectTimer.unref();
  };

  const drop = (c: ListenConnection) => {
    c.removeAllListeners("notification");
    c.end().catch(() => undefined);
    // end() waits for the server, which never answers on a half-open socket: drop the socket too.
    try {
      c.destroy();
    } catch {
      // no socket yet
    }
  };

  const lost = (lostClient: ListenConnection, err?: unknown) => {
    if (lostClient !== client) return;
    client = undefined;
    if (session) session.active = false;
    session = undefined;
    probe = undefined;
    listened.clear();
    pending.clear();
    stopPing();
    drop(lostClient);
    if (state === "closed") return;
    state = "down";
    log.warn({ err }, "LISTEN connection lost; subscribers poll until it is back");
    for (const [channel, entries] of byChannel) {
      for (const entry of [...entries]) {
        if (entry.polled) continue;
        entry.session = undefined;
        entry.polled = true;
        guarded("polling", channel, () => entry.subscriber.polling?.());
      }
    }
    scheduleReconnect();
  };

  /** LISTENs `channel` on the current connection, then announces it. */
  const listenChannel = (channel: string) => {
    const c = client;
    const s = session;
    if (!c || !s || listened.has(channel)) return;
    listened.add(channel);
    pending.add(channel);
    withTimeout(c.query(`LISTEN ${channel}`), unanswered("LISTEN")).then(
      () => {
        if (client !== c) return;
        pending.delete(channel);
        announce(channel, s);
      },
      (err: unknown) => lost(c, err),
    );
  };

  const unlistenChannel = (channel: string) => {
    const c = client;
    if (!c || !listened.has(channel)) return;
    listened.delete(channel);
    pending.delete(channel);
    withTimeout(c.query(`UNLISTEN ${channel}`), unanswered("UNLISTEN")).catch((err: unknown) =>
      lost(c, err),
    );
  };

  const connect = async (): Promise<void> => {
    if (state === "closed") return;
    state = "connecting";
    const next = serialized(
      createClient({
        connectionString: options.connectionString,
        application_name: options.applicationName,
        keepAlive: true,
        query_timeout: tuning.pingTimeoutMs,
        connectionTimeoutMillis: tuning.connectTimeoutMs,
      }),
    );
    client = next;
    next.on("notification", (msg) => {
      if (client === next) dispatch(msg.channel, msg.payload);
    });
    next.on("error", (err) => lost(next, err));
    next.on("end", () => lost(next));
    const channels = [...byChannel.keys()];
    try {
      await next.connect();
      if (client !== next) throw new Error("closed while connecting");
      // A role default must never end the listener for idling: it idles by design.
      await next.query("SET idle_session_timeout = 0").catch((err: unknown) => {
        if ((err as { code?: unknown } | null)?.code !== UNDEFINED_OBJECT) throw err;
      });
      // Server-side keepalives (KOBE-704 review): when this client vanishes behind a half-open
      // socket, Postgres ends its backend (and the session locks it holds, such as the gateway
      // sync's leader lock) in about a minute instead of after the OS default of ~2 h. A pooler
      // or managed Postgres may ignore or refuse them; that is logged, not fatal.
      await next.query(KEEPALIVES).catch((err: unknown) => {
        if (client !== next) throw err;
        log.warn({ err }, "LISTEN connection: server-side TCP keepalives not set");
      });
      for (const channel of [LISTEN_PROBE_CHANNEL, ...channels]) {
        if (client !== next) throw new Error("closed while connecting");
        await withTimeout(next.query(`LISTEN ${channel}`), unanswered("LISTEN"));
      }
      await probeDelivery(next);
    } catch (err) {
      if (client === next) lost(next, err);
      else drop(next); // close() ran meanwhile: leave nothing behind
      return;
    }
    if ((state as ListenState) === "closed" || client !== next) {
      drop(next);
      return;
    }
    state = "listening";
    attempt = 0;
    const s: Session = {
      active: true,
      query: <R>(text: string, values?: unknown[]) => {
        if (!s.active || client !== next) {
          return Promise.reject(new Error("the LISTEN connection is not listening"));
        }
        return next.query(text, values) as Promise<{ rows: R[] }>;
      },
    };
    session = s;
    for (const channel of channels) listened.add(channel);
    pingTimer = setInterval(() => {
      withTimeout(next.query("SELECT 1"), unanswered("ping")).catch((err: unknown) =>
        lost(next, err),
      );
    }, tuning.pingMs);
    pingTimer.unref();
    for (const channel of channels) {
      if (byChannel.has(channel)) announce(channel, s);
      else unlistenChannel(channel); // its last subscriber left while we connected
    }
    // Channels subscribed while we connected.
    for (const channel of byChannel.keys()) listenChannel(channel);
  };

  async function probeDelivery(c: ListenConnection): Promise<void> {
    const nonce = randomUUID();
    const heard = new Promise<void>((resolve) => {
      probe = { nonce, resolve };
    });
    try {
      await c.query("SELECT pg_notify($1, $2)", [LISTEN_PROBE_CHANNEL, nonce]);
      await withTimeout(
        heard,
        "LISTEN connection does not receive notifications: KOBE_DATABASE_URL must reach " +
          "Postgres directly or through a session-mode pooler (not transaction mode)",
      );
    } finally {
      probe = undefined;
    }
  }

  return {
    get state() {
      return state;
    },
    get channels() {
      return [...byChannel.keys()];
    },
    subscribe(channel, subscriber) {
      if (!CHANNEL.test(channel)) throw new Error(`invalid LISTEN channel: ${channel}`);
      if (state === "closed") return () => undefined;
      const entry: Entry = { subscriber, session: undefined, polled: false };
      let entries = byChannel.get(channel);
      const first = !entries;
      if (!entries) byChannel.set(channel, (entries = new Set()));
      entries.add(entry);
      if (state === "listening" && session) {
        const s = session;
        if (first || !listened.has(channel)) listenChannel(channel);
        // In flight: told when it completes. Already in force: told on the next tick.
        else if (!pending.has(channel)) queueMicrotask(() => announce(channel, s));
      } else {
        entry.polled = true;
        guarded("polling", channel, () => subscriber.polling?.());
        if (state === "idle") void connect();
        else if (state === "down" && !reconnectTimer && !client) scheduleReconnect();
      }
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const current = byChannel.get(channel);
        if (!current) return;
        current.delete(entry);
        if (current.size > 0) return;
        byChannel.delete(channel);
        if (state === "listening") unlistenChannel(channel);
      };
    },
    async close() {
      if (state === "closed") return;
      state = "closed";
      stopPing();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      byChannel.clear();
      listened.clear();
      pending.clear();
      if (session) session.active = false;
      session = undefined;
      probe = undefined;
      const current = client;
      client = undefined;
      if (current) {
        current.removeAllListeners("notification");
        // end() waits for the server, which never answers on a half-open socket: give it a
        // moment, then drop the socket so shutdown cannot hang.
        let timer: NodeJS.Timeout | undefined;
        const ended = await Promise.race([
          current.end().then(
            () => true,
            () => true,
          ),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(timer);
        if (!ended) {
          try {
            current.destroy();
          } catch {
            // no socket
          }
        }
      }
    },
  };
}
