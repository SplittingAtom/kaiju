/**
 * Header names before the rename to Kaiju (KOBE-749, spec docs/specs/rename-kaiju.md §3 change 6),
 * accepted by receivers for one release and removed in KOBE-754 (RN-10). For the same release,
 * senders send both names ({@link withLegacyHeaderNames}, {@link setRenamedHeader}), so a new
 * sender still reaches an old receiver during a rolling upgrade; from KOBE-754 on they send only
 * the new name. Receivers accept the old one because the components roll out separately: an API
 * client or script still sends `x-kobe-team`, a sandbox started from an image built before the
 * rename sends the old run and thread headers, and during `helm upgrade` an old server, mcp-proxy
 * or egress-proxy pod can call a new one (or the reverse) for a few minutes. The one response
 * header that crosses such a boundary (the workspace file's entry, read by sandbox agents) is
 * sent under both names for the same release. Anything a component strips or overwrites before
 * passing headers on, it strips or overwrites under both names, so nothing can smuggle a value in
 * under the old name.
 *
 * Keys are the new names, values the old ones; all lower case (Node and Hono read headers
 * case-insensitively).
 */
export const LEGACY_HEADER_NAMES = {
  "x-kaiju-team": "x-kobe-team",
  "x-kaiju-run-id": "x-kobe-run-id",
  "x-kaiju-run-token": "x-kobe-run-token",
  "x-kaiju-server-call": "x-kobe-server-call",
  "kaiju-sandbox-token": "kobe-sandbox-token",
  "kaiju-thread-id": "kobe-thread-id",
  /** A response header (server → sandbox agent): the server sends both names for one release. */
  "x-kaiju-workspace-entry": "x-kobe-workspace-entry",
} as const;

export type RenamedHeader = keyof typeof LEGACY_HEADER_NAMES;

/**
 * One renamed header through a reader of single headers (Hono's `c.req.header`, a `Headers`
 * object's `get`, an `IncomingHttpHeaders` lookup): the new name when the request carries it,
 * else the old one. The new name wins when both are present, even when they differ.
 */
export function readRenamedHeader<T>(
  get: (name: string) => T | null | undefined,
  name: RenamedHeader,
): T | undefined {
  const current = get(name);
  if (current !== undefined && current !== null) return current;
  const legacy = get(LEGACY_HEADER_NAMES[name]);
  return legacy === null ? undefined : legacy;
}

/**
 * A copy of Node request headers in which every old name is moved to its new name (when the new
 * one is absent) and removed, so code downstream reads and checks only the new names.
 */
export function withRenamedHeaders<T extends Record<string, unknown>>(headers: T): T {
  const legacyNames = new Set<string>(Object.values(LEGACY_HEADER_NAMES));
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(headers).filter(([name]) => !legacyNames.has(name)),
  );
  for (const [current, legacy] of Object.entries(LEGACY_HEADER_NAMES)) {
    if (out[current] === undefined && headers[legacy] !== undefined) out[current] = headers[legacy];
  }
  return out as T;
}

/**
 * A copy of outgoing headers in which every renamed header set under its new name is also set,
 * with the same value, under its old name (this release only; KOBE-754 removes it), so a receiver
 * from before the rename reads it too. A value already under an old name is always replaced or
 * dropped, never passed on: the old name carries only what the new one says.
 */
export function withLegacyHeaderNames<T extends Record<string, string>>(
  headers: T,
): Record<string, string> {
  const legacyNames = new Set<string>(Object.values(LEGACY_HEADER_NAMES));
  const out: Record<string, string> = Object.fromEntries(
    Object.entries(headers).filter(([name]) => !legacyNames.has(name.toLowerCase())),
  );
  for (const [name, value] of Object.entries(headers)) {
    const legacy = (LEGACY_HEADER_NAMES as Record<string, string>)[name.toLowerCase()];
    if (legacy !== undefined) out[legacy] = value;
  }
  return out;
}

/** Sets a renamed header under its new and (this release only, KOBE-754) its old name. */
export function setRenamedHeader(
  target: { set(name: string, value: string): void },
  name: RenamedHeader,
  value: string,
): void {
  target.set(name, value);
  target.set(LEGACY_HEADER_NAMES[name], value);
}
