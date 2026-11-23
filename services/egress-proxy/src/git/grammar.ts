/**
 * The git smart-HTTP request grammar (spec workspace-git G11; KOBE-763). For a connection whose
 * token is not narrowed by the host (a fine-grained token, a Gitea/Forgejo token) this check IS
 * the scope enforcement, so it is strict and works on the raw request target, never a normalised
 * copy: a request either has exactly one of these canonical shapes or gets no credential.
 *
 *   GET  <prefix>/<owner>/<repo>[.git]/info/refs?service=git-upload-pack|git-receive-pack
 *   POST <prefix>/<owner>/<repo>[.git]/git-upload-pack
 *   POST <prefix>/<owner>/<repo>[.git]/git-receive-pack
 *
 * `<prefix>` is the connection's base path (empty on github.com, `/gitea` for a sub-path
 * install); the server decides whether it belongs to a connection. Refused instead of normalised:
 * percent-encoding, backslashes, empty segments (`//`), dot segments (`.`, `..`), a trailing
 * slash, any other query, the dumb protocol (`info/refs` without `service`), a method that does
 * not fit the endpoint. The upstream path is rebuilt from the server's canonical values (base
 * path, organization) and the validated repository name, never copied from the request.
 */

export type GitService = "git-upload-pack" | "git-receive-pack";

export interface GitRequest {
  /** The base path before `/<owner>`: "" or `/a/b` (validated segments). */
  readonly prefix: string;
  readonly owner: string;
  /** The repository name without `.git`. */
  readonly repository: string;
  readonly service: GitService;
  /** `refs`: GET info/refs (discovery); `rpc`: POST git-*-pack. */
  readonly endpoint: "refs" | "rpc";
}

export type GitMatch =
  | { readonly kind: "git"; readonly request: GitRequest }
  /** Not a git smart-HTTP request: ordinary egress rules, never a git credential. */
  | { readonly kind: "not_git" }
  /** Looks like git smart-HTTP but is not canonical: refused outright, with the reason. */
  | { readonly kind: "invalid"; readonly why: string };

const MAX_PATH = 1024;
const MAX_PREFIX_SEGMENTS = 8;
const SAFE_PATH = /^[A-Za-z0-9._\-/]+$/;
const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
/** As `GIT_ORGANIZATION_PATTERN` in @kobe/db (the connection's organization). */
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** As `assertRepositoryName` on the server: one segment, never `.`/`..`, no trailing `.git`. */
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const SERVICES: ReadonlySet<string> = new Set(["git-upload-pack", "git-receive-pack"]);
/** Git-shaped endings, matched loosely (any case, any encoding) only to refuse look-alikes. */
const GIT_SHAPED = /\/(info\/refs|git-upload-pack|git-receive-pack)\/?$/i;

function loosely(raw: string): string {
  try {
    return decodeURIComponent(raw).replace(/\\/g, "/");
  } catch {
    return raw;
  }
}

/** The raw path and query of an absolute-form target (`http://host[:port]/path?query`). */
export function rawPathOf(target: string): { path: string; query: string | undefined } | undefined {
  const m = /^http:\/\/[^/?#]*(\/[^?#]*)?(?:\?([^#]*))?(#.*)?$/i.exec(target);
  if (!m || m[3] !== undefined) return undefined;
  return { path: m[1] ?? "/", query: m[2] };
}

function isDotSegment(s: string): boolean {
  return s === "." || s === "..";
}

/** Classifies one absolute-form proxy request (method + raw request target). */
export function matchGitRequest(method: string, target: string): GitMatch {
  const raw = rawPathOf(target);
  if (!raw) return { kind: "not_git" };
  const { path, query } = raw;
  const shaped = GIT_SHAPED.test(loosely(path)) || /service=git-/i.test(loosely(query ?? ""));
  if (!shaped) return { kind: "not_git" };
  const invalid = (why: string): GitMatch => ({ kind: "invalid", why });
  if (path.length > MAX_PATH) return invalid("the path is too long");
  if (!SAFE_PATH.test(path)) return invalid("the path must not be percent-encoded or escaped");
  const segments = path.split("/").slice(1);
  if (segments.some((s) => s === "")) return invalid("the path has an empty segment");
  if (segments.some(isDotSegment)) return invalid("the path has a dot segment");

  let endpoint: GitRequest["endpoint"];
  let service: GitService;
  let rest: string[];
  if (segments.length >= 4 && segments.at(-2) === "info" && segments.at(-1) === "refs") {
    if (method !== "GET") return invalid("info/refs is read with GET");
    const m = /^service=(git-upload-pack|git-receive-pack)$/.exec(query ?? "");
    if (!m) return invalid("info/refs needs ?service=git-upload-pack or git-receive-pack only");
    endpoint = "refs";
    service = m[1] as GitService;
    rest = segments.slice(0, -2);
  } else if (segments.length >= 3 && SERVICES.has(segments.at(-1) ?? "")) {
    if (method !== "POST") return invalid(`${segments.at(-1)} is called with POST`);
    if (query !== undefined) return invalid("git-*-pack takes no query");
    endpoint = "rpc";
    service = segments.at(-1) as GitService;
    rest = segments.slice(0, -1);
  } else {
    return invalid("not a git smart-HTTP endpoint");
  }
  const repoSegment = rest.at(-1) ?? "";
  const owner = rest.at(-2) ?? "";
  const prefixSegments = rest.slice(0, -2);
  const repository = /\.git$/i.test(repoSegment) ? repoSegment.slice(0, -4) : repoSegment;
  if (!OWNER.test(owner)) return invalid("not a valid organization name");
  if (!REPOSITORY.test(repository) || isDotSegment(repository) || /\.git$/i.test(repository)) {
    return invalid("not a valid repository name");
  }
  if (prefixSegments.length > MAX_PREFIX_SEGMENTS) return invalid("the base path is too deep");
  if (!prefixSegments.every((s) => SEGMENT.test(s))) return invalid("not a valid base path");
  const prefix = prefixSegments.length === 0 ? "" : `/${prefixSegments.join("/")}`;
  return { kind: "git", request: { prefix, owner, repository, service, endpoint } };
}

/** `push` for receive-pack (write), `fetch` for upload-pack (read). */
export function accessOf(service: GitService): "read" | "write" {
  return service === "git-receive-pack" ? "write" : "read";
}

/**
 * The upstream path, rebuilt from the server's canonical base path and organization and the
 * validated repository name (never the request's own text).
 */
export function upstreamPath(
  basePath: string,
  organization: string,
  repository: string,
  request: Pick<GitRequest, "service" | "endpoint">,
): string {
  const root = `${basePath}/${organization}/${repository}.git`;
  return request.endpoint === "refs"
    ? `${root}/info/refs?service=${request.service}`
    : `${root}/${request.service}`;
}
