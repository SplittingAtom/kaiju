import type { InjectedHeader } from "@kaiju/db";

/** Header names compared the way CGI-style servers see them (`X_Api_Key` = `X-Api-Key`). */
const headerKey = (name: string) => name.toLowerCase().replace(/_/g, "-");

/** Never forwarded upstream (hop-by-hop, proxy credentials, framing the proxy decides). */
const DROP_REQUEST = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "expect",
  "http2-settings",
  "content-length",
]);
/** Never relayed back to the sandbox. */
const DROP_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "alt-svc",
  "content-length",
]);

/** Header names the client listed in `Connection` (hop-by-hop by declaration). */
function connectionTokens(value: string | string[] | undefined): Set<string> {
  const joined = Array.isArray(value) ? value.join(",") : (value ?? "");
  return new Set(
    joined
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t !== ""),
  );
}

/** The request headers sent upstream: the client's minus what is dropped, plus the injected ones. */
export function upstreamHeaders(
  rawHeaders: readonly string[],
  host: string,
  injected: readonly InjectedHeader[],
  contentLength: number | undefined,
): [string, string][] {
  const out: [string, string][] = [];
  const injectedNames = new Set(injected.map((h) => headerKey(h.name)));
  const listed = new Map<string, string[]>();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] as string;
    const lower = name.toLowerCase();
    if (lower === "connection") {
      for (const token of connectionTokens(rawHeaders[i + 1])) listed.set(headerKey(token), []);
    }
  }
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] as string;
    // Compared as CGI-style servers see names: `Content_Length` is `Content-Length`.
    const key = headerKey(name);
    if (DROP_REQUEST.has(key) || listed.has(key) || injectedNames.has(key)) continue;
    if (key.startsWith("proxy-")) continue;
    out.push([name, rawHeaders[i + 1] as string]);
  }
  out.unshift(["Host", host]);
  if (contentLength !== undefined) out.push(["Content-Length", String(contentLength)]);
  for (const h of injected) out.push([h.name, h.value]);
  return out;
}

/**
 * A `Location` for the client: the same host's https URL becomes http (so it comes back through
 * the upgrade and is re-checked); anything else is passed unchanged (re-checked as its own request).
 */
export function rewriteLocation(location: string, host: string): string {
  let url: URL;
  try {
    url = new URL(location, `https://${host}/`);
  } catch {
    return location;
  }
  if (
    url.protocol === "https:" &&
    url.hostname === host &&
    (url.port === "" || url.port === "443")
  ) {
    return `http://${host}${url.pathname}${url.search}${url.hash}`;
  }
  return location;
}

/**
 * The secret parts of an injected value: the whole value and, for `<scheme> <credential>` values
 * (`Bearer x`, `Basic x`), the credential alone. Parts shorter than 4 characters are not matched.
 */
export function secretParts(injected: readonly InjectedHeader[]): string[] {
  const parts = new Set<string>();
  for (const h of injected) {
    parts.add(h.value);
    const space = h.value.indexOf(" ");
    if (space > 0) parts.add(h.value.slice(space + 1).trim());
  }
  return [...parts].filter((p) => p.length >= 4);
}

function containsSecret(value: string, injected: readonly InjectedHeader[]): boolean {
  return secretParts(injected).some((p) => value.includes(p));
}

/** The response headers relayed to the sandbox (multi-valued ones kept as such). */
export function downstreamHeaders(
  rawHeaders: readonly string[],
  host: string,
  injected: readonly InjectedHeader[],
): [string, string][] {
  const listed = new Set<string>();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if ((rawHeaders[i] as string).toLowerCase() === "connection") {
      for (const t of connectionTokens(rawHeaders[i + 1])) listed.add(t);
    }
  }
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] as string;
    const lower = name.toLowerCase();
    let value = rawHeaders[i + 1] as string;
    if (DROP_RESPONSE.has(lower) || listed.has(lower)) continue;
    // An upstream echoing a credential back in a header never shows it to the sandbox.
    if (containsSecret(value, injected)) continue;
    if (lower === "location" || lower === "content-location") value = rewriteLocation(value, host);
    out.push([name, value]);
  }
  return out;
}
