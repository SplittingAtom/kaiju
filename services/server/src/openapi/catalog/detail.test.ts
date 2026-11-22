import { describe, expect, it } from "vitest";
import { openApiDocument } from "../document.js";
import { catalogOperationId } from "./build.js";
import { CATALOG_AREAS } from "./index.js";

/**
 * KOBE-771: the catalog's detailed areas really describe their bodies, and the whole document is
 * structurally sound OpenAPI 3.1 (no validator is a dependency of the repository, so the checks
 * that matter are made here: every `$ref` resolves, every operation has a success answer and
 * declares its path parameters, operationIds are unique).
 */

type Operation = {
  readonly operationId?: string;
  readonly parameters?: readonly { name: string; in: string }[];
  readonly requestBody?: { content?: Record<string, { schema?: unknown }> };
  readonly responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
  readonly "x-kobe-detail"?: string;
};

const doc = openApiDocument() as {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
  components: Record<string, Record<string, unknown>>;
};

/** Areas whose every operation has request and response schemas (extend as areas are done). */
const DETAILED_TAGS = ["Threads", "Runs", "Artifacts", "Workspace", "Schedules"];

function refs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const item of node) refs(item, out);
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") out.push(value);
      else refs(value, out);
    }
  }
  return out;
}

const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
  Object.entries(item).map(([method, op]) => ({ path, method, op })),
);

describe("OpenAPI catalog detail (KOBE-771)", () => {
  it("marks the expected areas detailed", () => {
    expect(CATALOG_AREAS.filter((a) => a.detailed).map((a) => a.tag)).toEqual(DETAILED_TAGS);
  });

  it("gives every operation of a detailed area a 2xx schema and its request body", () => {
    for (const area of CATALOG_AREAS.filter((a) => a.detailed)) {
      for (const [method, path] of area.entries) {
        const op = doc.paths[path]?.[method];
        const name = `${method} ${path}`;
        expect(op, name).toBeDefined();
        expect(op?.["x-kobe-detail"], name).toBeUndefined();
        const success = Object.entries(op?.responses ?? {}).filter(([s]) => /^2\d\d$/.test(s));
        expect(success.length, name).toBe(1);
        const [status, answer] = success[0] ?? ["", {}];
        if (status !== "204") {
          const schemas = Object.values(answer.content ?? {}).map((c) => c.schema);
          expect(schemas.length, `${name}: success body`).toBeGreaterThan(0);
        }
        const detail = area.details?.[name];
        if (detail?.body) {
          expect(op?.requestBody?.content?.["application/json"]?.schema, name).toBeDefined();
        } else {
          expect(op?.requestBody, `${name}: no body read`).toBeUndefined();
        }
        // Errors come from the shared responses, never inline.
        for (const [s, response] of Object.entries(op?.responses ?? {})) {
          if (/^[45]\d\d$/.test(s)) expect(response, `${name} ${s}`).toHaveProperty("$ref");
        }
      }
    }
  });

  it("only refers to components that exist", () => {
    const dangling = [...new Set(refs(doc))].filter((ref) => {
      const [, , section = "", name = ""] = ref.split("/");
      return !(name in (doc.components[section] ?? {}));
    });
    expect(dangling).toEqual([]);
  });

  it("is structurally valid OpenAPI 3.1", () => {
    expect(doc.openapi).toMatch(/^3\.1\./);
    for (const { path, method, op } of operations) {
      const name = `${method} ${path}`;
      expect(["get", "post", "put", "patch", "delete"], name).toContain(method);
      expect(Object.keys(op.responses ?? {}).length, name).toBeGreaterThan(0);
      expect(
        Object.keys(op.responses ?? {}).some((s) => /^(2\d\d|2XX)$/.test(s)),
        `${name}: success answer`,
      ).toBe(true);
      const declared = new Set(
        (op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name),
      );
      const templated = [...path.matchAll(/\{([^}]+)\}/g)].map(([, p]) => p);
      expect([...declared].sort(), name).toEqual([...new Set(templated)].sort());
      const keys = (op.parameters ?? []).map((p) => `${p.in}:${p.name}`);
      expect(keys.length - new Set(keys).size, `${name}: duplicate parameter`).toBe(0);
    }
  });

  it("keeps catalog operationIds derived from method and path", () => {
    for (const area of CATALOG_AREAS) {
      for (const [method, path] of area.entries) {
        expect(doc.paths[path]?.[method]?.operationId).toBe(catalogOperationId(method, path));
      }
    }
  });
});
