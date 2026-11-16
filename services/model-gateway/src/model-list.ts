/**
 * `GET /v1/models` (KOBE-409 review L4): Bifrost lists every model the member's virtual key
 * allows, and the gateway sync adds the Site embedding model to every key (server calls use it).
 * A sandbox sees only the team's enabled models, as every model call is held to them: the listing
 * is read whole (it is small), entries outside `enabled` are dropped, and everything else is kept
 * as Bifrost sent it. Undefined when the answer is not an OpenAI model list (the caller fails
 * closed).
 */

/** Largest listing read (Bifrost lists at most a few thousand models). */
export const MODEL_LIST_MAX_BYTES = 4 * 1024 * 1024;

export function filterModelList(text: Buffer, enabled: ReadonlySet<string>): Buffer | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const list = parsed as { readonly data?: unknown };
  if (!Array.isArray(list.data)) return undefined;
  const data = list.data.filter(
    (m: unknown) =>
      typeof m === "object" &&
      m !== null &&
      typeof (m as { id?: unknown }).id === "string" &&
      enabled.has((m as { id: string }).id),
  );
  return Buffer.from(JSON.stringify({ ...list, data }));
}
