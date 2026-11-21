import type { ServerResponse } from "node:http";

/** Status line + plain-text body; `reason` is built from checked values only. */
export function reply(
  res: ServerResponse,
  status: number,
  reason: string,
  body: string,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const text = `${body}\n`;
  res.writeHead(status, reason, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(Buffer.byteLength(text)),
    connection: "close",
    ...headers,
  });
  res.end(text);
}
