/** Memory documents (KOBE-155): the Undo chip's delete and restore (KOBE-717 area). */
import type { FakeCore } from "./core";
import { error, json, NOW, type FakeAnswer, type FakeRequest } from "./state";

/**
 * `/v1/memory/:id` (KOBE-155) for the Undo chip: DELETE answers 204, `POST .../restore` the doc
 * at the asked version. Both are recorded in `requests`; `failNext` makes one fail.
 */

export function memoryRoute(k: FakeCore, method: string, url: URL, headers: Headers): Response {
  if (headers.get("x-kaiju-team") !== k.teamId) return error(409, "team_mismatch");
  const [, , id, leaf] = url.pathname.split("/").filter(Boolean); // v1 memory id restore
  if (method === "DELETE" && id && leaf === undefined) return new Response(null, { status: 204 });
  if (method === "POST" && id && leaf === "restore") {
    return json(200, {
      id,
      scope: "user",
      path: "notes.md",
      current_version: 3,
      size_bytes: 1,
      updated_at: NOW,
      updated_by: null,
      content: "",
      versions: [],
    });
  }
  return error(404, "not_found");
}

/** Answers its paths; undefined for any other. */
export function memoryArea(k: FakeCore, req: FakeRequest): FakeAnswer {
  const { method, url, headers } = req;
  if (url.pathname.startsWith("/v1/memory/")) return memoryRoute(k, method, url, headers);
  return undefined;
}
