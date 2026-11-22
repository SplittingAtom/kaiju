/**
 * The OpenAPI catalog (KOBE-727): member and admin routes described at summary level, one line
 * per operation. Areas with full request and response schemas (`openapi/<area>.ts`) stay as they
 * are; the catalog covers every other route of the member and admin API so that the document
 * lists them all. An operation built here carries `x-kobe-detail: "summary"`: its summary,
 * path parameters and the error envelope are documented, its bodies are not (yet).
 */

export type CatalogMethod = "get" | "post" | "put" | "patch" | "delete";

/**
 * One operation: method, full path (OpenAPI form: `{param}`; a trailing wildcard is `{path}`),
 * a one-line summary, and optional notes (who may call it, what it answers, side effects).
 */
export type CatalogEntry = readonly [
  method: CatalogMethod,
  path: string,
  summary: string,
  notes?: string,
];

/** A group of operations under one OpenAPI tag. */
export interface CatalogArea {
  readonly tag: string;
  readonly description: string;
  readonly entries: readonly CatalogEntry[];
}

type PathItem = Record<string, unknown>;

const PARAM = /\{([A-Za-z_]+)\}/g;

/** `get /v1/team/rules/{id}` → `getTeamRulesById`: unique as long as (method, path) is. */
export function catalogOperationId(method: CatalogMethod, path: string): string {
  const words = path
    .replace(/^\/v1\//, "/")
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const param = /^\{([A-Za-z_]+)\}$/.exec(segment)?.[1];
      return param ? `by-${param}` : segment;
    })
    .flatMap((segment) => segment.split(/[^A-Za-z0-9]+/))
    .filter(Boolean);
  return [method, ...words]
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}

function pathParameters(path: string) {
  return [...path.matchAll(PARAM)].map(([, name]) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
    ...(name === "path"
      ? { description: "The rest of the path (may contain slashes).", "x-kobe-wildcard": true }
      : {}),
  }));
}

function operation(area: CatalogArea, entry: CatalogEntry): Record<string, unknown> {
  const [method, path, summary, notes] = entry;
  const parameters = pathParameters(path);
  return {
    operationId: catalogOperationId(method, path),
    summary,
    ...(notes ? { description: notes } : {}),
    tags: [area.tag],
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(method === "post" || method === "put" || method === "patch"
      ? {
          requestBody: {
            required: false,
            description: "JSON body as the route validates it (not described here yet).",
            content: { "application/json": { schema: { type: "object" } } },
          },
        }
      : {}),
    responses: {
      "2XX": { description: "Success (body not described here yet)." },
      default: {
        description: "Error: `{code, message}`.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
    },
    "x-kobe-detail": "summary",
  };
}

/** The catalog's paths; throws on an operation listed twice. */
export function catalogPaths(areas: readonly CatalogArea[]): Record<string, PathItem> {
  const paths: Record<string, PathItem> = {};
  for (const area of areas) {
    for (const entry of area.entries) {
      const [method, path] = entry;
      const item = (paths[path] ??= {});
      if (item[method]) throw new Error(`catalog lists ${method} ${path} twice`);
      item[method] = operation(area, entry);
    }
  }
  return paths;
}

/** The catalog's tags, in area order; throws on a tag used by two areas. */
export function catalogTags(areas: readonly CatalogArea[]) {
  const seen = new Set<string>();
  return areas.map((area) => {
    if (seen.has(area.tag)) throw new Error(`catalog tag ${area.tag} is used twice`);
    seen.add(area.tag);
    return { name: area.tag, description: area.description };
  });
}

/**
 * `paths` with `extra` merged in per method; throws when both describe the same operation, so a
 * catalog line never silently replaces a fully described operation.
 */
export function mergePaths(
  paths: Record<string, PathItem>,
  extra: Record<string, PathItem>,
): Record<string, PathItem> {
  const merged: Record<string, PathItem> = { ...paths };
  for (const [path, item] of Object.entries(extra)) {
    const current = merged[path] ?? {};
    for (const method of Object.keys(item)) {
      if (method in current) throw new Error(`${method} ${path} is described twice`);
    }
    merged[path] = { ...current, ...item };
  }
  return merged;
}
