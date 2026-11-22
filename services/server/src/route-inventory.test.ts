import { describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "./app.js";
import type { ServerDeps } from "./deps.js";
import type { IsolationGate } from "./isolation/gate.js";
import { workspaceRoutes, type WorkspaceRoutesDeps } from "./workspace-sync/routes.js";

// The HTTP surface as Hono's ordered route table (KOBE-729): every handler and middleware entry as
// `METHOD path name`, in registration order (which is also Hono's matching order). Middleware
// (`ALL`) entries sit where they apply, so the list pins each route's middleware chain too. A
// refactor that moves routes between modules must leave this file byte-identical.
// Regenerate after adding or changing routes:
//   pnpm --filter @kobe/server exec vitest run src/route-inventory.test.ts -u

/**
 * A stand-in for every dependency: any property is another stand-in, calling one returns one.
 * Route builders only wire handlers at build time, so nothing here is ever really used.
 */
function standIn(): unknown {
  const target = function () {};
  const proxy: unknown = new Proxy(target, {
    get(_t, key) {
      if (key === "then") return undefined;
      if (key === Symbol.toPrimitive) return () => 0;
      if (key === Symbol.iterator) return function* () {};
      return proxy;
    },
    apply: () => proxy,
    construct: () => proxy as object,
  });
  return proxy;
}

function inventory(app: Pick<Hono, "routes">): string {
  return `${app.routes
    .map((r) => `${r.method} ${r.path} ${r.handler.name || "(anonymous)"}`)
    .join("\n")}\n`;
}

describe("route inventory (KOBE-729)", () => {
  it("lists the API server's routes and middleware in order", async () => {
    const app = createApp(standIn() as ServerDeps, {
      isolation: standIn() as IsolationGate,
    });
    await expect(inventory(app)).toMatchFileSnapshot("__snapshots__/route-inventory.app.txt");
  });

  it("lists the sandbox listener's workspace sync routes in order", async () => {
    const deps = {
      db: standIn(),
      objects: standIn(),
      authenticate: standIn(),
      prefix: "",
      limits: { maxFileBytes: 1, maxWorkspaceBytes: 1, maxFiles: 1 },
      quota: standIn(),
      log: standIn(),
    } as unknown as WorkspaceRoutesDeps;
    await expect(inventory(workspaceRoutes(deps))).toMatchFileSnapshot(
      "__snapshots__/route-inventory.workspace-sync.txt",
    );
  });
});
