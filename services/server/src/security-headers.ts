import type { MiddlewareHandler } from "hono";

/**
 * Headers on every server response (KOBE-695). `/v1` and `/api/auth` reach the server straight
 * from the ingress, so the web app's headers never cover them.
 *
 * - `Strict-Transport-Security` when the public URL is https (one year). `includeSubDomains`
 *   only when the operator turns it on: an install under a shared parent domain must not force
 *   HTTPS on its siblings.
 * - `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`, unless the route set its own:
 *   the frame routes (artifacts, workspace files, app frames, notebook output) answer with
 *   `SAMEORIGIN` and keep it.
 */
export interface SecurityHeaderOptions {
  readonly publicUrl: string | undefined;
  readonly includeSubDomains: boolean;
}

const HSTS_MAX_AGE_SECONDS = 31_536_000;

/** The HSTS header for this install, or undefined on a plain-http (or unknown) public URL. */
export function hstsValue(
  publicUrl: string | undefined,
  includeSubDomains: boolean,
): string | undefined {
  if (publicUrl === undefined || !URL.canParse(publicUrl)) return undefined;
  if (new URL(publicUrl).protocol !== "https:") return undefined;
  return `max-age=${HSTS_MAX_AGE_SECONDS}${includeSubDomains ? "; includeSubDomains" : ""}`;
}

export function securityHeaders(options: SecurityHeaderOptions): MiddlewareHandler {
  const hsts = hstsValue(options.publicUrl, options.includeSubDomains);
  return async (c, next) => {
    await next();
    const wanted: [string, string][] = [];
    if (hsts !== undefined) wanted.push(["strict-transport-security", hsts]);
    for (const [name, value] of [
      ["x-content-type-options", "nosniff"],
      ["x-frame-options", "DENY"],
    ] as const) {
      if (!c.res.headers.has(name)) wanted.push([name, value]);
    }
    if (wanted.length === 0) return;
    try {
      for (const [name, value] of wanted) c.res.headers.set(name, value);
    } catch {
      // Immutable headers (a redirect or a relayed fetch response): answer with a copy.
      const copy = new Response(c.res.body, c.res);
      for (const [name, value] of wanted) copy.headers.set(name, value);
      c.res = copy;
    }
  };
}
