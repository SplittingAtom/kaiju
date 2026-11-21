import type { IncomingMessage } from "node:http";

export type BodyResult = Buffer | "too_large" | "busy";

/**
 * Reads a request body of at most `max` bytes, taking its bytes from the budget first. With a
 * declared length the body is copied into one buffer of that size as it arrives (≈1× in memory);
 * without one (chunked) the chunks are joined at the end, briefly ≈2×, so chunked bodies are
 * charged twice their size. `taken` reports what to give back.
 */
export function readBody(
  req: IncomingMessage,
  max: number,
  take: (bytes: number) => boolean,
  taken: (bytes: number) => void,
): Promise<BodyResult> {
  return new Promise((resolve, reject) => {
    const header = req.headers["content-length"];
    const declared = header === undefined ? undefined : Number(header);
    if (declared !== undefined && (!Number.isSafeInteger(declared) || declared > max)) {
      resolve("too_large");
      return;
    }
    if (declared !== undefined) {
      if (!take(declared)) {
        resolve("busy");
        return;
      }
      taken(declared);
    }
    const fixed = declared !== undefined ? Buffer.allocUnsafe(declared) : undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (r: BodyResult) => {
      if (done) return;
      done = true;
      if (typeof r === "string") req.pause();
      resolve(r);
    };
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      if (size + chunk.length > max || (fixed && size + chunk.length > fixed.length)) {
        return finish("too_large");
      }
      if (fixed) {
        chunk.copy(fixed, size);
      } else {
        if (!take(2 * chunk.length)) return finish("busy");
        taken(2 * chunk.length);
        chunks.push(chunk);
      }
      size += chunk.length;
    });
    req.on("end", () => finish(fixed ? fixed.subarray(0, size) : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
