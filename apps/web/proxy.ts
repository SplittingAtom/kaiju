import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, hstsHeader, newNonce } from "./lib/security/csp";

/**
 * Per-request CSP nonce (Next 16 proxy): Next reads the nonce from the request's
 * `Content-Security-Policy` header and puts it on its own scripts and styles, and the browser gets
 * the same policy. Pages render per request for this (`app/layout.tsx` awaits `connection()`).
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV === "development" });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  // KOBE-695: HSTS on an https install (runtime: one image serves http and https installs).
  const hsts = hstsHeader(process.env);
  if (hsts !== undefined) response.headers.set("strict-transport-security", hsts);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not static chunks, images, the favicon or the JSON health route.
      source: "/((?!api/|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
