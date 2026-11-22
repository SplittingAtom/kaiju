import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { signingKeyEnvName } from "@kobe/session-token";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { loadConfig, type Config } from "../config.js";
import type { RuntimeClassLike } from "../isolation/runtime-class.js";
import { SchedulerRunner } from "../scheduler/runner.js";
import { waitForAppSessionsToClose } from "../testing/app-sessions.js";
import { FakeS3 } from "../testing/fake-s3.js";
import { KEY_PAIRS, SETTINGS } from "../testing/sandbox-fixtures.js";
import { startServer } from "./server.js";

/**
 * KOBE-709 (review CODE-8): `startServer(config)` builds the whole process and `stop()` takes it
 * all down again: every job's timer, the listeners, the LISTEN client and the pools.
 */
let database: TestDatabase;
const silent = pino({ level: "silent" });
const s3 = new FakeS3("kobe-test", "AKIDSTARTSERVER");
let s3Url = "";
// The sandbox runtime's Kubernetes client reads KUBECONFIG: a cluster nobody listens on, so every
// call fails at once (the runtime logs it) and nothing reaches a real cluster.
const kubeDir = mkdtempSync(join(tmpdir(), "kobe-start-server-"));
const previousKubeconfig = process.env.KUBECONFIG;

beforeAll(async () => {
  database = await createTestDatabase(testServerUrl());
  s3Url = await s3.start();
  const kubeconfig = join(kubeDir, "config");
  writeFileSync(
    kubeconfig,
    [
      "apiVersion: v1",
      "kind: Config",
      "clusters: [{ name: none, cluster: { server: 'https://127.0.0.1:1' } }]",
      "users: [{ name: none, user: { token: none } }]",
      "contexts: [{ name: none, context: { cluster: none, user: none, namespace: kobe } }]",
      "current-context: none",
    ].join("\n"),
  );
  process.env.KUBECONFIG = kubeconfig;
});
afterAll(async () => {
  if (previousKubeconfig === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = previousKubeconfig;
  rmSync(kubeDir, { recursive: true, force: true });
  await s3.stop();
  await database.drop();
});

/** A port nobody listens on right now (the sandbox and internal listeners take fixed ports). */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (typeof address !== "object" || !address) throw new Error("no port");
  return address.port;
}

/** A sandbox configuration (fake cluster), object storage (FakeS3) and the MCP proxy key. */
async function sandboxEnv(): Promise<Record<string, string>> {
  const settings = {
    ...SETTINGS,
    endpoints: {
      ...SETTINGS.endpoints,
      server: { ...SETTINGS.endpoints.server, targetPort: await freePort() },
    },
  };
  const keys = Object.fromEntries(
    Object.entries(KEY_PAIRS).map(([audience, pair]) => [
      signingKeyEnvName(audience as keyof typeof KEY_PAIRS),
      pair.privatePem,
    ]),
  );
  return {
    KOBE_SANDBOX_CONFIG: JSON.stringify(settings),
    ...keys,
    KOBE_RUNTIME_CLASS: "gvisor",
    KOBE_S3_BUCKET: s3.bucket,
    KOBE_S3_ENDPOINT: s3Url,
    KOBE_S3_ACCESS_KEY_ID: s3.accessKeyId,
    KOBE_S3_SECRET_ACCESS_KEY: "secret-for-start-server",
    KOBE_INTERNAL_PORT: String(await freePort()),
    KOBE_MCP_PROXY_INTERNAL_KEY: "k".repeat(32),
  };
}

const GVISOR: RuntimeClassLike[] = [{ metadata: { name: "gvisor" }, handler: "runsc" }];

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
    this.#live.clear();
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

/**
 * No live timer once the stop's last callbacks ran (a query the LISTEN client still had on the
 * wire errors on the next ticks). Well under every job's interval and the 10 s query timeouts,
 * so a leaked timer cannot clear itself by firing.
 */
const settledTimers = () =>
  expect.poll(() => timers.live(), { timeout: 2_000, interval: 50 }).toEqual([]);

const sockets = () =>
  process.getActiveResourcesInfo().filter((r) => r === "TCPServerWrap" || r === "TCPSocketWrap")
    .length;

function serverConfig(extra: Record<string, string> = {}): Config {
  const config = loadConfig({
    ...extra,
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

    // Memoised: a second signal waits for the same shutdown instead of closing twice.
    const first = server.stop();
    expect(server.stop()).toBe(first);
    await first;

    await settledTimers();
    await expect.poll(sockets).toBeLessThanOrEqual(before);
    await waitForAppSessionsToClose(database.appRole);
  });

  it("starts every job with a sandbox runtime and object storage, and stops them all", async () => {
    const before = sockets();
    const env = await sandboxEnv();
    const server = await startServer(serverConfig(env), {
      env,
      log: silent,
      listRuntimeClasses: () => Promise.resolve(GVISOR),
    });
    expect(server.jobs).toEqual(
      expect.arrayContaining([
        "isolation",
        "kobe-skills-seed",
        "workspace-collector",
        "external-scan-sweep",
        "skill-late-scan",
        "skill-mirror-sweep",
        "skill-eval-hub",
        "skill-eval-sweep",
        "skill-eval-reaper",
        "retention",
        "offboarding",
        "team-reconciler",
        "hibernation",
        "pod-reconciler",
        "scheduled-run-hook",
        "orbit-eval-sweep",
      ]),
    );
    await server.stop();
    await settledTimers();
    await expect.poll(sockets).toBeLessThanOrEqual(before);
    await waitForAppSessionsToClose(database.appRole);
  });

  it("starts the scheduler's runner only once the isolation check has settled", async () => {
    const tick = vi.spyOn(SchedulerRunner.prototype, "tick");
    let answer: (classes: RuntimeClassLike[]) => void = () => undefined;
    const listed = new Promise<RuntimeClassLike[]>((resolve) => {
      answer = resolve;
    });
    const env = await sandboxEnv();
    const server = await startServer(
      { ...serverConfig(env), process: "scheduler" },
      { env, log: silent, listRuntimeClasses: () => listed },
    );
    try {
      expect(server.jobs).toContain("scheduler");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(tick).not.toHaveBeenCalled();
      answer(GVISOR);
      await expect.poll(() => tick.mock.calls.length).toBeGreaterThan(0);
    } finally {
      await server.stop();
      tick.mockRestore();
    }
    await settledTimers();
    await waitForAppSessionsToClose(database.appRole);
  });

  it("starts the scheduler process and stops it the same way", async () => {
    const before = sockets();
    const server = await startServer(
      { ...serverConfig(), process: "scheduler" },
      { env: {}, log: silent },
    );
    await server.stop();
    await settledTimers();
    await expect.poll(sockets).toBeLessThanOrEqual(before);
    await waitForAppSessionsToClose(database.appRole);
  });
});
