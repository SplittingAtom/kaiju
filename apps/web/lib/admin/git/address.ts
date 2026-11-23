/**
 * The browser's copy of the server's address rules for Workspace git (KOBE-757
 * `parseGitBaseUrl`, `parseDomainPattern`, `decideGitHost`), so the console says what is wrong
 * before anything is sent. The server stays the authority and checks everything again; the
 * browser has no Public Suffix List, so the common two-level registries are recognised by shape
 * (as lib/egress-patterns.ts does).
 */
import { patternCovers } from "../../egress-patterns";

const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const HOST = new RegExp(`^(${LABEL}\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`);
const MAX_HOST_LENGTH = 253;
export const GIT_BASE_URL_MAX = 2048;
/** Host patterns a Site admin may list (the server's `GIT_ALLOWED_HOSTS_MAX`). */
export const GIT_ALLOWED_HOSTS_MAX = 50;
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go"]);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** A canonical host name (lowercase ASCII, IDNA), or null (IP literals included). */
export function normalizeHost(raw: string): string | null {
  let host = raw.trim();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "" || host.startsWith("[") || host.includes(":") || IPV4.test(host)) return null;
  let ascii: string;
  try {
    ascii = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (ascii === "" || ascii.length > MAX_HOST_LENGTH || !HOST.test(ascii)) return null;
  return ascii;
}

export type Checked<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

/** A git host's base URL as the server stores it (`https://git.example.com/forgejo`). */
export function checkBaseUrl(raw: string): Checked<{ baseUrl: string; host: string }> {
  const text = raw.trim();
  if (text === "" || text.length > GIT_BASE_URL_MAX) {
    return { ok: false, reason: "Enter the host's https address." };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "Enter the host's https address, e.g. https://git.example.com." };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "The address must use https." };
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "The address must not contain a user name or password." };
  }
  if (url.search !== "" || url.hash !== "" || text.includes("?") || text.includes("#")) {
    return { ok: false, reason: "The address must not contain a query or fragment." };
  }
  const host = normalizeHost(url.hostname);
  if (host === null) {
    return { ok: false, reason: "The address must name a host, not an IP address." };
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (/[\s?#]/.test(path) || path.includes("//") || /(^|\/)\.\.?(\/|$)/.test(path)) {
    return { ok: false, reason: "The address has an invalid path." };
  }
  const port = url.port === "" ? "" : `:${url.port}`;
  return { ok: true, value: { baseUrl: `https://${host}${port}${path}`, host } };
}

/** Whether the Site's host list lets a Workspace connect to `host` (empty list: any host). */
export function hostAllowed(allowedHosts: readonly string[] | undefined, host: string): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return true;
  return allowedHosts.some((p) => patternCovers(p, host));
}

function looksLikePublicSuffix(host: string): boolean {
  const labels = host.split(".");
  if (labels.length === 1) return true;
  if (labels.length !== 2) return false;
  const [second, tld] = labels as [string, string];
  return tld.length === 2 && SECOND_LEVEL.has(second);
}

/** One entry of the Site's allowed git hosts (`github.com`, `*.example.com`), canonical. */
export function checkHostPattern(raw: string): Checked<string> {
  const trimmed = raw.trim().toLowerCase();
  const wildcard = trimmed.startsWith("*.");
  const rest = wildcard ? trimmed.slice(2) : trimmed;
  if (rest.includes("*")) {
    return {
      ok: false,
      reason: "a wildcard is allowed only as the first label (*.example.com)",
    };
  }
  if (rest.includes("/") || rest.includes(":") || rest.includes("@")) {
    return { ok: false, reason: "enter a host name only, without scheme, port or path" };
  }
  const host = normalizeHost(rest);
  if (host === null) {
    return { ok: false, reason: "must be a host name such as github.com (no IP addresses)" };
  }
  const pattern = wildcard ? `*.${host}` : host;
  if (pattern.length > MAX_HOST_LENGTH) return { ok: false, reason: "is too long" };
  if (wildcard && looksLikePublicSuffix(host)) {
    return {
      ok: false,
      reason: `a wildcard on the public suffix ${host} would match every site under it`,
    };
  }
  return { ok: true, value: pattern };
}

export interface HostListCheck {
  /** Canonical, unique, sorted: what the server would store. */
  readonly hosts: readonly string[];
  /** One sentence per bad line, naming the line and the entry. */
  readonly problems: readonly string[];
}

/** The host list editor's text (one pattern per line; blank lines ignored). */
export function checkHostList(text: string): HostListCheck {
  const problems: string[] = [];
  const hosts = new Set<string>();
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    const checked = checkHostPattern(line);
    if (checked.ok) hosts.add(checked.value);
    else problems.push(`Line ${i + 1} (${line.trim().slice(0, 80)}): ${checked.reason}.`);
  });
  if (hosts.size > GIT_ALLOWED_HOSTS_MAX) {
    problems.push(`List at most ${GIT_ALLOWED_HOSTS_MAX} hosts (there are ${hosts.size}).`);
  }
  return { hosts: [...hosts].sort(), problems };
}
