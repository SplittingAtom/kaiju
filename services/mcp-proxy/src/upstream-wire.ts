import type { UpstreamFailure } from "./upstream-types.js";

/** A failure inside an upstream session, mapped to its result by `sessionResult`. */
export class UpstreamError extends Error {
  constructor(
    readonly failure: UpstreamFailure,
    /** For `auth_required`: the HTTP status the upstream refused with. */
    readonly authStatus?: 401 | 403,
  ) {
    super(failure);
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** One SSE event's data lines joined, per the EventSource rules (enough for JSON-RPC payloads). */
function* sseEvents(buffer: { text: string }): Generator<string> {
  for (;;) {
    const match = /\r?\n\r?\n/.exec(buffer.text);
    if (!match) return;
    const block = buffer.text.slice(0, match.index);
    buffer.text = buffer.text.slice(match.index + match[0].length);
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data !== "") yield data;
  }
}

/** The JSON-RPC response to `id` in a parsed message, if it is one. */
export function responseFor(message: unknown, id: number): Record<string, unknown> | undefined {
  if (!isObject(message) || message.id !== id) return undefined;
  return "result" in message || "error" in message ? message : undefined;
}

/** A whole response body as text, at most `maxBytes`. */
export async function readLimited(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new UpstreamError("too_large");
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** Reads an SSE stream until the response to `id`, within the size cap. */
export async function readSse(
  body: ReadableStream<Uint8Array> | null,
  id: number,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  if (!body) throw new UpstreamError("protocol_error");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const buffer = { text: "" };
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new UpstreamError("protocol_error");
      size += value.byteLength;
      if (size > maxBytes) throw new UpstreamError("too_large");
      buffer.text += decoder.decode(value, { stream: true });
      for (const data of sseEvents(buffer)) {
        let message: unknown;
        try {
          message = JSON.parse(data);
        } catch {
          continue;
        }
        const response = responseFor(message, id);
        if (response) return response;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
