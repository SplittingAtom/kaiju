import type { Socket } from "node:net";
import { MAX_CLIENT_HELLO_BYTES, parseClientHello } from "./client-hello.js";

/**
 * The TLS server name must be the CONNECT host: compared as a lowercased literal with at most one
 * trailing dot removed, never decoded or IDNA-converted (the host is already canonical ASCII).
 */
export function sniMatches(serverName: string | undefined, host: string): boolean {
  if (serverName === undefined) return false;
  const name = serverName.toLowerCase();
  return (name.endsWith(".") ? name.slice(0, -1) : name) === host;
}

export interface ClientHelloRead {
  readonly bytes: Buffer;
  readonly serverName: string | undefined;
  readonly why?: string;
}

/** Collects the client's first bytes until its ClientHello is complete (or invalid, or too slow). */
export function readClientHello(
  socket: Socket,
  head: Buffer,
  timeoutMs: number,
): Promise<ClientHelloRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = head.length > 0 ? [head] : [];
    let size = head.length;
    let done = false;
    const finish = (serverName: string | undefined, why?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.pause();
      resolve({ bytes: Buffer.concat(chunks), serverName, ...(why ? { why } : {}) });
    };
    const check = () => {
      const result = parseClientHello(Buffer.concat(chunks));
      if (result.status === "ok") finish(result.serverName);
      else if (result.status === "invalid") finish(undefined, result.why);
      else if (size > MAX_CLIENT_HELLO_BYTES) finish(undefined, "ClientHello too large");
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      check();
    };
    const onClose = () => finish(undefined, "closed before ClientHello");
    const timer = setTimeout(() => finish(undefined, "no ClientHello in time"), timeoutMs);
    socket.on("data", onData);
    socket.once("close", onClose);
    if (size > 0) check();
    if (!done) socket.resume();
  });
}
