import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createListenClient,
  type ListenClient,
  type ListenClientOptions,
  type ListenConnection,
  type ListenSession,
} from "../pg-listen.js";

/**
 * A fake pg.Client: records queries, answers them per the test's `behaviour`, echoes the
 * delivery probe's pg_notify back as a notification, and can be failed or fed notifications.
 */
class FakeClient extends EventEmitter implements ListenConnection {
  readonly queries: string[] = [];
  ended = false;
  destroyed = false;
  connected = false;
  constructor(
    readonly config: { application_name?: string | undefined },
    private readonly behaviour: Behaviour,
  ) {
    super();
  }
  async connect(): Promise<void> {
    await this.behaviour.connect(this);
    this.connected = true;
  }
  async query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> {
    this.queries.push(text);
    const answer = this.behaviour.query?.(this, text, values);
    if (answer) return answer;
    if (text.startsWith("SELECT pg_notify")) {
      const [channel, payload] = values as [string, string];
      queueMicrotask(() => this.notify(channel, payload));
    }
    return { rows: [] };
  }
  async end(): Promise<void> {
    this.ended = true;
    await this.behaviour.end?.();
  }
  destroy(): void {
    this.destroyed = true;
  }
  notify(channel: string, payload: string): void {
    this.emit("notification", { channel, payload, processId: 1 });
  }
  fail(err = new Error("connection reset")): void {
    this.emit("error", err);
  }
  listened(): string[] {
    return this.queries.filter((q) => q.startsWith("LISTEN ")).map((q) => q.slice(7));
  }
}

interface Behaviour {
  connect(c: FakeClient): Promise<void>;
  query?(c: FakeClient, text: string, values?: unknown[]): Promise<{ rows: unknown[] }> | undefined;
  end?(): Promise<void>;
}

const ok: Behaviour = { connect: () => Promise.resolve() };

const clients: FakeClient[] = [];
let listen: ListenClient | undefined;

function make(behaviour: Behaviour = ok, options: Partial<ListenClientOptions> = {}) {
  listen = createListenClient({
    connectionString: "postgres://fake",
    applicationName: "kaiju-test-listen",
    reconnectMinMs: 100,
    reconnectMaxMs: 1_000,
    pingMs: 1_000,
    pingTimeoutMs: 500,
    log: { warn: () => undefined, error: () => undefined },
    createClient: (config) => {
      const c = new FakeClient(config, behaviour);
      clients.push(c);
      return c;
    },
    ...options,
  });
  return listen;
}

/** Lets pending promise callbacks run (fake timers do not advance microtasks by themselves). */
const settle = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};

function recorder() {
  const events: string[] = [];
  const sessions: ListenSession[] = [];
  return {
    events,
    sessions,
    sub: {
      notification: (p: string) => events.push(`n:${p}`),
      listening: (s: ListenSession) => {
        sessions.push(s);
        events.push("listening");
      },
      polling: () => events.push("polling"),
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1); // jitter off: delays are the full backoff step
});
afterEach(async () => {
  await listen?.close();
  listen = undefined;
  clients.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createListenClient", () => {
  it("connects lazily, sets application_name and no idle-session timeout, LISTENs and probes", async () => {
    const l = make();
    expect(clients).toHaveLength(0);
    const r = recorder();
    l.subscribe("kaiju_a", r.sub);
    expect(r.events).toEqual(["polling"]); // not listening yet: subscribers poll
    await settle();
    expect(clients).toHaveLength(1);
    const c = clients[0] as FakeClient;
    expect(c.config.application_name).toBe("kaiju-test-listen");
    expect(c.queries[0]).toBe("SET idle_session_timeout = 0");
    // Server-side keepalives: Postgres drops a dead client (and its locks) in about a minute.
    expect(c.queries[1]).toBe(
      "SET tcp_keepalives_idle = 30; SET tcp_keepalives_interval = 10; SET tcp_keepalives_count = 3",
    );
    expect(c.listened()).toContain("kaiju_a");
    expect(c.queries.some((q) => q.startsWith("SELECT pg_notify"))).toBe(true);
    expect(l.state).toBe("listening");
    expect(r.events).toEqual(["polling", "listening"]);
    c.notify("kaiju_a", "hello");
    c.notify("kaiju_b", "not ours");
    expect(r.events).toEqual(["polling", "listening", "n:hello"]);
  });

  it("retries a failing connect with a growing delay up to the maximum", async () => {
    let failures = 5;
    const l = make({
      connect: () =>
        failures-- > 0 ? Promise.reject(new Error("ECONNREFUSED")) : Promise.resolve(),
    });
    const r = recorder();
    l.subscribe("kaiju_a", r.sub);
    await settle();
    expect(clients).toHaveLength(1);
    expect(l.state).toBe("down");
    const delays: number[] = [];
    for (const expected of [100, 200, 400, 800, 1_000]) {
      const before = clients.length;
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(clients.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(clients.length).toBe(before + 1);
      delays.push(expected);
    }
    expect(delays).toEqual([100, 200, 400, 800, 1_000]);
    expect(l.state).toBe("listening");
    // Every failed client was ended and its socket dropped.
    for (const c of clients.slice(0, -1)) expect(c.ended && c.destroyed).toBe(true);
    expect(r.events.at(-1)).toBe("listening");
  });

  it("switches subscribers to polling on an error while listening, and back after reconnecting", async () => {
    const l = make();
    const a = recorder();
    const b = recorder();
    l.subscribe("kaiju_a", a.sub);
    l.subscribe("kaiju_b", b.sub);
    await settle();
    expect(l.state).toBe("listening");
    const first = clients[0] as FakeClient;
    const session = a.sessions[0] as ListenSession;
    expect(session.active).toBe(true);
    first.fail();
    expect(l.state).toBe("down");
    expect(session.active).toBe(false);
    expect(a.events.at(-1)).toBe("polling");
    expect(b.events.at(-1)).toBe("polling");
    expect(first.ended && first.destroyed).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(clients).toHaveLength(2);
    expect(l.state).toBe("listening");
    expect((clients[1] as FakeClient).listened().sort()).toEqual(
      ["kaiju_a", "kaiju_b", "kobe_listen_probe"].sort(),
    );
    expect(a.events.at(-1)).toBe("listening");
    expect(b.events.at(-1)).toBe("listening");
    // A late event from the dead client is ignored.
    first.notify("kaiju_a", "stale");
    expect(a.events).not.toContain("n:stale");
  });

  it("treats an unanswered ping as a lost (half-open) connection", async () => {
    let hang = false;
    const l = make({
      connect: () => Promise.resolve(),
      query: (_c, text) => (hang && text === "SELECT 1" ? new Promise(() => undefined) : undefined),
    });
    const r = recorder();
    l.subscribe("kaiju_a", r.sub);
    await settle();
    expect(l.state).toBe("listening");
    hang = true;
    await vi.advanceTimersByTimeAsync(1_000); // ping sent
    expect(l.state).toBe("listening");
    await vi.advanceTimersByTimeAsync(500); // no answer within pingTimeoutMs
    expect(l.state).toBe("down");
    expect((clients[0] as FakeClient).destroyed).toBe(true);
    expect(r.events.at(-1)).toBe("polling");
  });

  it("stays down when the delivery probe never echoes (transaction-mode pooler)", async () => {
    const l = make({
      connect: () => Promise.resolve(),
      query: (_c, text) =>
        text.startsWith("SELECT pg_notify") ? Promise.resolve({ rows: [] }) : undefined,
    });
    l.subscribe("kaiju_a", recorder().sub);
    await settle();
    expect(l.state).toBe("connecting");
    await vi.advanceTimersByTimeAsync(500);
    expect(l.state).toBe("down");
  });

  it("leaves no client when close() runs during connect", async () => {
    let release: (() => void) | undefined;
    const l = make({ connect: () => new Promise<void>((r) => (release = r)) });
    l.subscribe("kaiju_a", recorder().sub);
    await settle();
    expect(l.state).toBe("connecting");
    const closing = l.close();
    release?.();
    await closing;
    await settle();
    const c = clients[0] as FakeClient;
    expect(c.ended).toBe(true);
    expect(c.listened()).toEqual([]);
    expect(l.state).toBe("closed");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(clients).toHaveLength(1); // no reconnect after close
  });

  it("isolates subscribers: a throwing or slow one blocks nobody", async () => {
    const errors: unknown[] = [];
    const l = make(ok, { log: { warn: () => undefined, error: (o) => errors.push(o) } });
    const got: string[] = [];
    l.subscribe("kaiju_a", {
      notification: () => {
        throw new Error("boom");
      },
      listening: () => {
        throw new Error("boom too");
      },
    });
    l.subscribe("kaiju_a", {
      // never settles: the client must not wait on it
      notification: () => void new Promise(() => undefined),
    });
    l.subscribe("kaiju_a", { notification: (p) => got.push(p) });
    await settle();
    expect(l.state).toBe("listening");
    const c = clients[0] as FakeClient;
    c.notify("kaiju_a", "1");
    c.notify("kaiju_a", "2");
    expect(got).toEqual(["1", "2"]); // in order, despite the others
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(l.state).toBe("listening");
  });

  it("LISTENs a channel added later once, and UNLISTENs when its last subscriber leaves", async () => {
    const l = make();
    l.subscribe("kaiju_a", recorder().sub);
    await settle();
    const c = clients[0] as FakeClient;
    const b1 = recorder();
    const b2 = recorder();
    const off1 = l.subscribe("kaiju_b", b1.sub);
    const off2 = l.subscribe("kaiju_b", b2.sub);
    await settle();
    expect(c.listened().filter((ch) => ch === "kaiju_b")).toHaveLength(1);
    expect(b1.events).toEqual(["listening"]);
    expect(b2.events).toEqual(["listening"]);
    c.notify("kaiju_b", "x");
    expect(b1.events.at(-1)).toBe("n:x");
    expect(b2.events.at(-1)).toBe("n:x");
    off1();
    await settle();
    expect(c.queries).not.toContain("UNLISTEN kaiju_b");
    off2();
    off2(); // idempotent
    await settle();
    expect(c.queries.filter((q) => q === "UNLISTEN kaiju_b")).toHaveLength(1);
    expect(l.channels).toEqual(["kaiju_a"]);
    c.notify("kaiju_b", "after");
    expect(b2.events).not.toContain("n:after");
  });

  it("runs session queries on the listening connection only", async () => {
    const l = make();
    const r = recorder();
    l.subscribe("kaiju_a", r.sub);
    await settle();
    const session = r.sessions[0] as ListenSession;
    await session.query("SELECT pg_try_advisory_lock($1)", [1]);
    expect((clients[0] as FakeClient).queries).toContain("SELECT pg_try_advisory_lock($1)");
    (clients[0] as FakeClient).fail();
    await expect(session.query("SELECT 1")).rejects.toThrow(/not listening/);
  });

  it("tells a subscriber joining a channel whose LISTEN is in flight only once LISTEN is done", async () => {
    let releaseListen: (() => void) | undefined;
    const l = make({
      connect: () => Promise.resolve(),
      query: (_c, text) =>
        text === "LISTEN kaiju_b"
          ? new Promise((r) => (releaseListen = () => r({ rows: [] })))
          : undefined,
    });
    l.subscribe("kaiju_a", recorder().sub);
    await settle();
    expect(l.state).toBe("listening");
    const first = recorder();
    const second = recorder();
    l.subscribe("kaiju_b", first.sub);
    await settle();
    l.subscribe("kaiju_b", second.sub);
    await settle();
    expect(first.events).toEqual([]);
    expect(second.events).toEqual([]); // not before LISTEN completed
    releaseListen?.();
    await settle();
    expect(first.events).toEqual(["listening"]);
    expect(second.events).toEqual(["listening"]);
  });

  it("goes on when the server refuses the keepalive settings (a pooler)", async () => {
    const l = make({
      connect: () => Promise.resolve(),
      query: (_c, text) =>
        text.startsWith("SET tcp_keepalives")
          ? Promise.reject(Object.assign(new Error("unsupported"), { code: "08P01" }))
          : undefined,
    });
    l.subscribe("kaiju_a", recorder().sub);
    await settle();
    expect(l.state).toBe("listening");
  });

  it("destroys the socket when end() does not return on close (half-open)", async () => {
    const l = make({ connect: () => Promise.resolve(), end: () => new Promise(() => undefined) });
    l.subscribe("kaiju_a", recorder().sub);
    await settle();
    expect(l.state).toBe("listening");
    let closed = false;
    void l.close().then(() => (closed = true));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(closed).toBe(false);
    expect((clients[0] as FakeClient).destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect((clients[0] as FakeClient).destroyed).toBe(true);
    expect(closed).toBe(true);
  });

  it("refuses channel names that are not plain identifiers", () => {
    const l = make();
    expect(() => l.subscribe("kaiju; DROP TABLE x", recorder().sub)).toThrow(/channel/);
  });

  it("answers a subscribe after close with nothing and never connects", async () => {
    const l = make();
    await l.close();
    const r = recorder();
    const off = l.subscribe("kaiju_a", r.sub);
    off();
    await settle();
    expect(clients).toHaveLength(0);
    expect(r.events).toEqual([]);
  });
});
