/**
 * Contract checks of the fake server (KOBE-717): the fake's answers, read over `fetch` as the web
 * reads them, parsed with the `@kobe/protocol` schema of the route. A drift fails the area's test.
 */
import { expect } from "vitest";
import type { z } from "zod";
import type { FakeKobe } from "../fake-kobe";

/** The JSON body of one request to the fake, in the active team, with its status. */
export async function call(
  fake: FakeKobe,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const res = await fake.fetch(path, {
    method,
    headers: { "x-kobe-team": fake.teamId, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : (JSON.parse(text) as unknown) };
}

/** Asks the fake and parses its answer with `schema`; the parse issues fail the test. */
export async function expectContract<S extends z.ZodType>(
  fake: FakeKobe,
  schema: S,
  method: string,
  path: string,
  body?: unknown,
): Promise<z.infer<S>> {
  const res = await call(fake, method, path, body);
  expect(res.status, `${method} ${path}`).toBeLessThan(300);
  const parsed = schema.safeParse(res.body);
  expect(parsed.error?.issues ?? [], `${method} ${path}`).toEqual([]);
  return parsed.data as z.infer<S>;
}
