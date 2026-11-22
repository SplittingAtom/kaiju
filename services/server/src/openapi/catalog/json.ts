/**
 * Shorthand JSON Schemas for responses the routes build without a zod schema (KOBE-771). Only
 * for `untyped(...)` components: the fields a handler sends, read from its code. A route that has
 * a zod schema is described from that schema instead (`named(...)`).
 */

type JsonSchema = Record<string, unknown>;

export const str: JsonSchema = { type: "string" };
export const uuid: JsonSchema = { type: "string", format: "uuid" };
export const dateTime: JsonSchema = { type: "string", format: "date-time" };
export const bool: JsonSchema = { type: "boolean" };
export const int: JsonSchema = { type: "integer" };
export const num: JsonSchema = { type: "number" };
/** Any JSON value (the handler passes it through as stored). */
export const any: JsonSchema = {};

export const nullable = (schema: JsonSchema): JsonSchema => ({
  anyOf: [schema, { type: "null" }],
});
export const arr = (items: JsonSchema): JsonSchema => ({ type: "array", items });
export const oneOfStrings = (...values: readonly string[]): JsonSchema => ({
  type: "string",
  enum: [...values],
});

/**
 * An object with these properties; every property is required unless its name ends in `?`
 * (the handler leaves it out in some answers).
 */
export function obj(properties: Readonly<Record<string, JsonSchema>>): JsonSchema {
  const entries = Object.entries(properties).map(
    ([key, schema]) => [key.replace(/\?$/, ""), schema, !key.endsWith("?")] as const,
  );
  return {
    type: "object",
    properties: Object.fromEntries(entries.map(([key, schema]) => [key, schema])),
    required: entries.filter(([, , required]) => required).map(([key]) => key),
  };
}

/** A component reference, for nesting one schema in another. */
export const refTo = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
