import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { loadConfig, type Config } from "../config.js";
import { waitForAppSessionsToClose } from "../testing/app-sessions.js";
import { startServer } from "./server.js";

/**
 * KOBE-709 (review CODE-8): `startServer(config)` builds the whole process and `stop()` takes it
 * all down again: every job's timer, the listeners, the LISTEN client and the pools.
 */
let database: TestDatabase;
const silent = pino({ level: "silent" });

beforeAll(async () => {
  database = await createTestDatabase(testServerUrl());
});
afterAll(async () => {
  await database.drop();
});

/** Timers created while a test runs that were neither cleared nor (for a timeout) fired. */
class TimerLedger {
  readonly #live = new Map<unknown, string>();
  readonly #originals = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval,
  };

  install(): void {
    const { setTimeout, setInterval, clearTimeout, clearInterval } = this.#originals;
    const live = this.#live;
    const where = () => new Error().stack?.split("\n").slice(3, 6).join(" | ") ?? "";
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const handle: unknown = setTimeout(
        (...a: unknown[]) => {
          live.delete(handle);
          fn(...a);
        },
        ms,
        ...args,
      );
      live.set(handle, `timeout ${String(ms)} ms at ${where()}`);
      return handle;
    }) as typeof globalThis.setTimeout;
    globalThis.setInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const handle = setInterval(fn, ms, ...args);
      live.set(handle, `interval ${String(ms)} ms at ${where()}`);
      return handle;
    }) as typeof globalThis.setInterval;
    globalThis.clearTimeout = ((h: Parameters<typeof clearTimeout>[0]) => {
      live.delete(h);
      clearTimeout(h);
    }) as typeof globalThis.clearTimeout;
    globalThis.clearInterval = ((h: Parameters<typeof clearInterval>[0]) => {
      live.delete(h);
      clearInterval(h);
    }) as typeof globalThis.clearInterval;
  }

  uninstall(): void {
    Object.assign(globalThis, this.#originals);
  }

  live(): string[] {
    return [...this.#live.values()];
  }
}

const sockets = () =>
  process.getActiveResourcesInfo().filter((r) => r === "TCPServerWrap" || r === "TCPSocketWrap")
    .length;

function serverConfig(): Config {
  const config = loadConfig({
    KOBE_DATABASE_URL: database.appUrl,
    KOBE_PUBLIC_URL: "http://localhost:3000",
    KOBE_AUTH_SECRET: "s".repeat(48),
    KOBE_SETUP_TOKEN: "setup-token-for-start-server-0",
    KOBE_SMTP_HOST: "127.0.0.1",
    KOBE_SMTP_FROM: "Kobe <kobe@example.com>",
  });
  // Any free port.
  return { ...config, port: 0 };
}

const timers = new TimerLedger();
beforeEach(() => timers.install());
afterEach(() => timers.uninstall());

describe("startServer (KOBE-709)", () => {
  it("serves, and stop() leaves no live timers, sockets or database sessions", async () => {
    const before = sockets();
    const server = await startServer(serverConfig(), { env: {}, log: silent });
    expect(server.port).toBeGreaterThan(0);
    const res = await new Promise<number>((resolve, reject) => {
      // No keep-alive agent: the test's own client must not hold a socket open.
      import("node:http")
        .then(({ get }) =>
          get({ host: "127.0.0.1", port: server.port, path: "/healthz", agent: false }, (r) => {
            r.resume();
            r.on("end", () => resolve(r.statusCode ?? 0));
          }).on("error", reject),
        )
        .catch(reject);
    });
    expect(res).toBe(200);
    expect(timers.live().length).toBeGreaterThan(0);

    await server.stop();

    expect(timers.live()).toEqual([]);
    await expect.poll(sockets).toBeLessThanOrEqual(before);
    await waitForAppSessionsToClose(database.appRole);
  });

  it("starts the scheduler process and stops it the same way", async () => {
    const before = sockets();
    const server = await startServer(
      { ...serverConfig(), process: "scheduler" },
      { env: {}, log: silent },
    );
    await server.stop();
    expect(timers.live()).toEqual([]);
    await expect.poll(sockets).toBeLessThanOrEqual(before);
    await waitForAppSessionsToClose(database.appRole);
  });
});
