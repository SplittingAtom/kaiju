import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { ServerDeps } from "../deps.js";
import type { IsolationGate } from "../isolation/gate.js";
import { createInternalApp } from "../routes/internal.js";
import { createSandboxApp } from "../routes/sandbox.js";
import { catalogOperationId, type CatalogMethod } from "./catalog/build.js";
import { CATALOG_AREAS } from "./catalog/index.js";
import { openApiDocument } from "./document.js";
import { UNDOCUMENTED_ROUTES, type AllowlistEntry } from "./undocumented-allowlist.js";

/**
 * OpenAPI completeness (KOBE-727): every route the real apps mount is either in the OpenAPI
 * document or on the allowlist with a reason, and neither list holds anything stale. Routes are
 * read from the mounted Hono apps (`app.routes`), never from a hand-written list. A new route
 * fails here until it is documented (`openapi/<area>.ts`, or one line in `openapi/catalog/`) or
 * consciously allowlisted (`undocumented-allowlist.ts`).
 */

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Dependencies that answer every property and call with another stand-in: building the apps only
 * registers routes, it never runs a handler or middleware. Every optional feature reads as
 * present, so every conditionally mounted route is mounted.
 */
function standIn(name: string): unknown {
  const target = () => undefined;
  return new Proxy(target, {
    get(_target, key) {
      if (key === "then") return undefined; // not a thenable
      if (key === Symbol.toPrimitive) return () => name;
      if (key === "publicUrl") return "https://kobe.test";
      return standIn(`${name}.${String(key)}`);
    },
    apply: () => standIn(`${name}()`),
  });
}

type Routes = { readonly routes: readonly { method: string; path: string }[] };

/** `METHOD /path` in OpenAPI form: `:id` → `{id}`, a trailing `*` → `{path}`; middleware skipped. */
function operations(app: Routes): string[] {
  const ops = app.routes
    .filter((r) => HTTP_METHODS.has(r.method))
    .map((r) => {
      const path = r.path
        .replace(/:([A-Za-z_]+)/g, "{$1}")
        .replace(/\/\*$/, "/{path}")
        .replace(/(.)\/$/, "$1");
      return `${r.method} ${path}`;
    });
  return [...new Set(ops)].sort();
}

function matches(entry: AllowlistEntry, op: string): boolean {
  const [method = "", path = ""] = entry.route.split(" ");
  const [opMethod = "", opPath = ""] = op.split(" ");
  if (method !== "*" && method !== opMethod) return false;
  if (!path.endsWith("/*")) return path === opPath;
  const prefix = path.slice(0, -2);
  return opPath === prefix || opPath.startsWith(`${prefix}/`);
}

const deps = standIn("deps") as ServerDeps;
// The user-facing listener, as `index.ts` builds it (the isolation gate adds /v1/site/isolation).
const userFacing = operations(
  createApp(deps, { isolation: standIn("isolation") as IsolationGate }),
);
// The sandbox-facing and internal listeners: separate ports, all allowlisted.
const sandbox = operations(createSandboxApp(standIn("sandbox") as never));
const internal = operations(
  createInternalApp({
    internalKey: "k".repeat(64),
    mcp: standIn("mcp"),
    kobe: standIn("kobe"),
    appResults: standIn("appResults"),
    auth: standIn("auth"),
  } as never),
);

const doc = openApiDocument();
const documented = Object.entries(doc.paths as Record<string, Record<string, unknown>>)
  .flatMap(([path, item]) => Object.keys(item).map((m) => `${m.toUpperCase()} ${path}`))
  .sort();
const allowlisted = (op: string) => UNDOCUMENTED_ROUTES.some((e) => matches(e, op));

describe("OpenAPI completeness (KOBE-727)", () => {
  it("reads a realistic route table from the mounted apps", () => {
    // Guards the stand-in: a broken build of the app would otherwise pass every check below.
    expect(userFacing.length).toBeGreaterThan(500);
    expect(userFacing).toContain("GET /v1/threads/{id}");
    expect(userFacing).toContain("GET /v1/site/isolation");
    expect(sandbox).toContain("POST /v1/sandbox/session");
    expect(internal.some((op) => op.startsWith("POST /internal/v1/mcp/"))).toBe(true);
  });

  it("documents or allowlists every route of the user-facing listener", () => {
    const missing = userFacing.filter((op) => !documented.includes(op) && !allowlisted(op));
    expect(
      missing,
      "Undocumented routes: describe them in openapi/<area>.ts or add a line in openapi/catalog/, " +
        "or allowlist them with a reason in openapi/undocumented-allowlist.ts",
    ).toEqual([]);
  });

  it("allowlists every route of the sandbox-facing and internal listeners", () => {
    expect([...sandbox, ...internal].filter((op) => !allowlisted(op))).toEqual([]);
  });

  it("documents only routes the user-facing listener mounts", () => {
    expect(documented.filter((op) => !userFacing.includes(op))).toEqual([]);
  });

  it("has no stale allowlist entry and none that covers a documented route", () => {
    const all = [...userFacing, ...sandbox, ...internal];
    const stale = UNDOCUMENTED_ROUTES.filter((e) => !all.some((op) => matches(e, op)));
    expect(stale.map((e) => e.route)).toEqual([]);
    const both = documented.filter(allowlisted);
    expect(both).toEqual([]);
    for (const entry of UNDOCUMENTED_ROUTES) {
      expect(entry.reason.length, entry.route).toBeGreaterThan(20);
    }
  });

  it("gives every operation a unique operationId and the catalog a summary per line", () => {
    const ids = Object.values(doc.paths as Record<string, Record<string, { operationId?: string }>>)
      .flatMap((item) => Object.values(item))
      .map((op) => op.operationId);
    expect(ids.filter((id) => id === undefined)).toEqual([]);
    expect(ids.length - new Set(ids).size).toBe(0);
    for (const area of CATALOG_AREAS) {
      for (const [method, path, summary] of area.entries) {
        expect(summary.trim().length, `${method} ${path}`).toBeGreaterThan(5);
        expect(catalogOperationId(method as CatalogMethod, path)).toMatch(/^[a-z][A-Za-z0-9]+$/);
      }
    }
  });
});
