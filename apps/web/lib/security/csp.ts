/**
 * Content Security Policy for the web app (coordinator security review of KOBE-32). Scripts run only
 * from this origin with the request's nonce (`'strict-dynamic'` lets Next's nonced bootstrap load
 * its chunks); no `'unsafe-eval'` outside `next dev` (React's dev tooling needs it). Styles: our
 * stylesheets and nonced `<style>`; `style-src-attr 'unsafe-inline'` allows only `style="…"`
 * attributes (layout libraries set heights that way; attributes can't run code or load anything).
 * Images: this origin and data URLs only (agent Markdown never loads images, `markdown.tsx`).
 * The API and event stream are same-origin (`connect-src 'self'`). Never framed.
 *
 * Not set: `upgrade-insecure-requests` (a plain-HTTP install would break its own requests).
 * Artifacts (KOBE-55) are framed from `/v1/artifacts/…/frame` (same origin, its own CSP), so
 * `frame-src 'self'` is enough; only this comment changed for them.
 */
export interface CspOptions {
  readonly dev: boolean;
}

export function buildCsp(nonce: string, { dev }: CspOptions): string {
  const directives: readonly (readonly string[])[] = [
    ["default-src", "'self'"],
    [
      "script-src",
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(dev ? ["'unsafe-eval'"] : []),
    ],
    ["style-src", "'self'", `'nonce-${nonce}'`],
    ["style-src-attr", "'unsafe-inline'"],
    ["img-src", "'self'", "data:"],
    ["font-src", "'self'"],
    ["connect-src", "'self'"],
    ["media-src", "'self'"],
    ["frame-src", "'self'"],
    ["worker-src", "'self'"],
    ["manifest-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
  ];
  return directives.map((d) => d.join(" ")).join("; ");
}

/** 128 random bits, base64 (works on plain-HTTP origins and in the Edge/Node proxy runtime). */
export function newNonce(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Headers for every response (`next.config.ts`); the CSP itself is per request (`proxy.ts`). */
export const SECURITY_HEADERS: readonly { readonly key: string; readonly value: string }[] = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), payment=()" },
];

const HSTS_MAX_AGE_SECONDS = 31_536_000;

/**
 * KOBE-695: `Strict-Transport-Security` for page responses when the install's public URL
 * (`KAIJU_PUBLIC_URL`) is https; undefined otherwise (a plain-HTTP install must not pin itself).
 * Read per request (`proxy.ts`): `next.config.ts` headers are fixed at build time, and one image
 * serves every install. `includeSubDomains` only with `KAIJU_HSTS_INCLUDE_SUBDOMAINS=true` (chart
 * `ingress.hsts.includeSubDomains`, default off: an install under a shared parent domain must not
 * force HTTPS on its siblings). The server sends the same header on `/v1` and `/api/auth`.
 */
export function hstsHeader(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const raw = env.KAIJU_PUBLIC_URL?.trim() ?? "";
  if (!URL.canParse(raw) || new URL(raw).protocol !== "https:") return undefined;
  const sub = env.KAIJU_HSTS_INCLUDE_SUBDOMAINS === "true" ? "; includeSubDomains" : "";
  return `max-age=${HSTS_MAX_AGE_SECONDS}${sub}`;
}
