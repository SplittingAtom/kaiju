import type { Socket } from "node:net";

/** HTTP server sockets allow half-open connections: close for real shortly after replying. */
const LINGER_MS = 1_000;

export function closeSoon(socket: Socket): void {
  setTimeout(() => socket.destroy(), LINGER_MS).unref();
}

/** A raw HTTP/1.1 response on a CONNECT socket, then close. `reason` is built from checked values. */
export function reply(
  socket: Socket,
  status: number,
  reason: string,
  body: string,
  headers: string[] = [],
): void {
  if (socket.destroyed) return;
  const text = `${body}\n`;
  closeSoon(socket);
  socket.end(
    [
      `HTTP/1.1 ${status} ${reason}`,
      "Content-Type: text/plain; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(text)}`,
      "Connection: close",
      ...headers,
      "",
      text,
    ].join("\r\n"),
  );
}
