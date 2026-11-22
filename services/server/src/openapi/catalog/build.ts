import { z } from "zod";

/**
 * The OpenAPI catalog (KOBE-727, KOBE-771): member and admin routes described one line per
 * operation, with their request and response schemas once the area is detailed. Areas with full
 * hand-written descriptions (`openapi/<area>.ts`) stay as they are; the catalog covers every other
 * route of the member and admin API so that the document lists them all.
 *
 * An area marked `detailed` gives every entry a `CatalogDetail` (request body, query, response,
 * status, extra errors), built from the zod schemas the routes validate with and the response
 * schemas in `@kobe/protocol`. An entry without detail carries `x-kobe-detail: "summary"`: its
 * summary, path parameters and the error envelope are documented, its bodies are not (yet).
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

type JsonSchema = Record<string, unknown>;

/**
 * A schema published as `#/components/schemas/<name>`: the route's own zod schema (request bodies
 * as input, responses as output), or, for a response the route builds without a schema, a JSON
 * Schema of the fields the handler sends, marked `x-kobe-untyped` (listed in the KOBE-771 ledger).
 */
export interface NamedSchema {
  readonly name: string;
  readonly zod?: z.ZodType;
  readonly json?: JsonSchema;
}

/** A component from a zod schema the route (or `@kobe/protocol`) already defines. */
export const named = (name: string, zod: z.ZodType): NamedSchema => ({ name, zod });

/** A component for a response with no schema in code: the fields the handler sends, as is. */
export const untyped = (name: string, json: JsonSchema): NamedSchema => ({
  name,
  json: { ...json, "x-kobe-untyped": true },
});

/** Shared error responses (`#/components/responses/<name>`), all with the `Error` envelope. */
export const ERROR_RESPONSES = {
  "400": [
    "BadRequest",
    "`invalid_request` (body, query or path parameter not valid) or `team_header_required`.",
  ],
  "401": ["Unauthenticated", "`unauthenticated`: no session."],
  "403": [
    "Forbidden",
    "`forbidden` (missing permission), `not_a_team_member` or `read_only`; the code says which.",
  ],
  "402": ["PaymentRequired", "`budget_exhausted`: the team's or member's budget is used up."],
  "404": ["NotFound", "Not found, or not visible to the caller (another team's or member's)."],
  "409": [
    "Conflict",
    "The resource's state refuses the change, or `no_active_team` / `team_mismatch` (stale tab).",
  ],
  "413": ["PayloadTooLarge", "`too_large`: the request body is over the route's limit."],
  "422": [
    "Unprocessable",
    "The request is well-formed but refused (for example an invalid value the code names).",
  ],
  "429": ["RateLimited", "`rate_limited`: too many requests; retry later."],
  "502": ["BadGateway", "An upstream (sandbox, connector, model or registry) failed."],
  "503": ["Unavailable", "Not available right now (switched off, waking or not configured)."],
} as const;

export type ErrorStatus = keyof typeof ERROR_RESPONSES;

/** Request and response description of one operation in a detailed area. */
export interface CatalogDetail {
  /** The JSON body the route validates; `null` when the route reads no body. */
  readonly body?: NamedSchema | null;
  /** The body may be left out (the route accepts an empty request). */
  readonly bodyOptional?: boolean;
  /** Query parameters: the route's zod object, or JSON Schemas by name when it reads them by hand. */
  readonly query?: z.ZodObject | Readonly<Record<string, JsonSchema>>;
  /** Query parameters that must be present (for a hand-read `query`). */
  readonly requiredQuery?: readonly string[];
  /** The success status (default 200). */
  readonly status?: 200 | 201 | 202 | 204 | 302;
  /** The JSON success body; required unless `status` is 204/302 or `produces` is set. */
  readonly response?: NamedSchema;
  /** A non-JSON success body (download, stream, HTML), with its media type. */
  readonly produces?: string;
  /** What the success answer means, when more than "Success." helps. */
  readonly responseDescription?: string;
  /** Error statuses beyond the area's defaults. */
  readonly errors?: readonly ErrorStatus[];
}

/** A group of operations under one OpenAPI tag. */
export interface CatalogArea {
  readonly tag: string;
  readonly description: string;
  readonly entries: readonly CatalogEntry[];
  /** Every entry has a `details` row (KOBE-771); checked when the catalog is built. */
  readonly detailed?: boolean;
  /** Request and response descriptions by `"<method> <path>"`. */
  readonly details?: Readonly<Record<string, CatalogDetail>>;
  /** Routes act on the active team: add the X-Kobe-Team header (required on changes). */
  readonly teamScoped?: boolean;
  /** Error statuses every detailed operation of the area can answer (default 400, 401, 403). */
  readonly defaultErrors?: readonly ErrorStatus[];
}

type PathItem = Record<string, unknown>;

const PARAM = /\{([A-Za-z_]+)\}/g;
const DEFAULT_ERRORS: readonly ErrorStatus[] = ["400", "401", "403"];

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

const isChange = (method: CatalogMethod) => method !== "get";
const hasBody = (method: CatalogMethod) =>
  method === "post" || method === "put" || method === "patch";

/** JSON Schema of a zod schema, without the dialect line. */
export function jsonSchemaOf(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io,
    target: "draft-2020-12",
    unrepresentable: "any",
  }) as JsonSchema;
  return rest;
}

const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const responseRef = (status: ErrorStatus) => ({
  $ref: `#/components/responses/${ERROR_RESPONSES[status][0]}`,
});

function queryParameters(detail: CatalogDetail): JsonSchema[] {
  const { query } = detail;
  if (!query) return [];
  if (query instanceof z.ZodObject) {
    const json = jsonSchemaOf(query, "input");
    const required = new Set((json.required as string[] | undefined) ?? []);
    return Object.entries((json.properties ?? {}) as Record<string, JsonSchema>).map(
      ([name, schema]) => ({ name, in: "query", required: required.has(name), schema }),
    );
  }
  const required = new Set(detail.requiredQuery ?? []);
  return Object.entries(query).map(([name, schema]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema,
  }));
}

const teamHeader = (required: boolean) => ({
  name: "X-Kobe-Team",
  in: "header",
  required,
  description: "The team the client believes is active. Required on changes; must match.",
  schema: { type: "string", format: "uuid" },
});

function detailedParts(
  area: CatalogArea,
  method: CatalogMethod,
  path: string,
  detail: CatalogDetail,
): Record<string, unknown> {
  const key = `${method} ${path}`;
  if (hasBody(method) && detail.body === undefined) {
    throw new Error(`catalog ${key}: say what body the route reads (a schema, or null)`);
  }
  if (!hasBody(method) && detail.body) throw new Error(`catalog ${key}: ${method} has no body`);
  const status = detail.status ?? 200;
  if (!detail.response && !detail.produces && status !== 204 && status !== 302) {
    throw new Error(`catalog ${key}: a ${status} answer needs a response schema`);
  }
  const success: Record<string, unknown> = {
    description: detail.responseDescription ?? (status === 204 ? "Done; no body." : "Success."),
    ...(detail.response
      ? { content: { "application/json": { schema: schemaRef(detail.response.name) } } }
      : detail.produces
        ? { content: { [detail.produces]: { schema: { type: "string" } } } }
        : {}),
  };
  const errors = [...new Set([...(area.defaultErrors ?? DEFAULT_ERRORS), ...(detail.errors ?? [])])]
    .sort()
    .map((s) => [s, responseRef(s)] as const);
  return {
    ...(detail.body
      ? {
          requestBody: {
            required: !detail.bodyOptional,
            content: { "application/json": { schema: schemaRef(detail.body.name) } },
          },
        }
      : {}),
    responses: { [String(status)]: success, ...Object.fromEntries(errors) },
  };
}

function operation(area: CatalogArea, entry: CatalogEntry): Record<string, unknown> {
  const [method, path, summary, notes] = entry;
  const detail = area.details?.[`${method} ${path}`];
  if (area.detailed && !detail) throw new Error(`catalog ${method} ${path} has no detail`);
  const parameters = [
    ...pathParameters(path),
    ...(detail ? queryParameters(detail) : []),
    ...(area.teamScoped ? [teamHeader(isChange(method))] : []),
  ];
  const head = {
    operationId: catalogOperationId(method, path),
    summary,
    ...(notes ? { description: notes } : {}),
    tags: [area.tag],
    ...(parameters.length > 0 ? { parameters } : {}),
  };
  if (detail) return { ...head, ...detailedParts(area, method, path, detail) };
  return {
    ...head,
    ...(hasBody(method)
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
        content: { "application/json": { schema: schemaRef("Error") } },
      },
    },
    "x-kobe-detail": "summary",
  };
}

/** The catalog's paths; throws on an operation listed twice or a detail for no entry. */
export function catalogPaths(areas: readonly CatalogArea[]): Record<string, PathItem> {
  const paths: Record<string, PathItem> = {};
  for (const area of areas) {
    const keys = new Set(area.entries.map(([method, path]) => `${method} ${path}`));
    const stale = Object.keys(area.details ?? {}).filter((key) => !keys.has(key));
    if (stale.length > 0) throw new Error(`catalog details for no entry: ${stale.join(", ")}`);
    for (const entry of area.entries) {
      const [method, path] = entry;
      const item = (paths[path] ??= {});
      if (item[method]) throw new Error(`catalog lists ${method} ${path} twice`);
      item[method] = operation(area, entry);
    }
  }
  return paths;
}

/**
 * The components the catalog's details name: request bodies as zod input, responses as output.
 * Throws when one name stands for two different schemas.
 */
export function catalogSchemas(areas: readonly CatalogArea[]): Record<string, JsonSchema> {
  const schemas: Record<string, JsonSchema> = {};
  const add = (named: NamedSchema, io: "input" | "output") => {
    const json = named.zod ? jsonSchemaOf(named.zod, io) : named.json;
    if (!json) throw new Error(`catalog schema ${named.name} has no definition`);
    const current = schemas[named.name];
    if (current && JSON.stringify(current) !== JSON.stringify(json)) {
      throw new Error(`catalog schema name ${named.name} stands for two schemas`);
    }
    schemas[named.name] = json;
  };
  for (const area of areas) {
    for (const detail of Object.values(area.details ?? {})) {
      if (detail.body) add(detail.body, "input");
      if (detail.response) add(detail.response, "output");
    }
  }
  return schemas;
}

/** The shared error responses, by component name. */
export function catalogErrorResponses(): Record<string, unknown> {
  return Object.fromEntries(
    Object.values(ERROR_RESPONSES).map(([name, description]) => [
      name,
      { description, content: { "application/json": { schema: schemaRef("Error") } } },
    ]),
  );
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

/**
 * `schemas` with the catalog's merged in; throws when a name the hand-written areas use stands
 * for a different schema in the catalog (reusing a name for the same schema is fine).
 */
export function mergeSchemas(
  schemas: Record<string, JsonSchema>,
  extra: Record<string, JsonSchema>,
): Record<string, JsonSchema> {
  for (const [name, json] of Object.entries(extra)) {
    const current = schemas[name];
    if (current && JSON.stringify(current) !== JSON.stringify(json)) {
      throw new Error(`schema name ${name} is used for two schemas`);
    }
  }
  return { ...schemas, ...extra };
}
