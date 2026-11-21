import { z } from "zod";

/**
 * Workspace path rules (KOBE-27): the shape every workspace path must have, the server-owned and
 * agent-internal areas, and the member's drop folder. Shared by the sandbox wire
 * (sandbox-wire/workspace-sync.ts, which re-exports these) and the browser (KOBE-720: kept out of
 * the sandbox-wire subpath so web code can use them from the package root).
 */

/** Areas only the server writes (read-only to the agent). Trailing slash included. */
export const WORKSPACE_SERVER_OWNED_PREFIXES = ["uploads/", "projects/"] as const;
/**
 * The member's drop folder (CE5, KOBE-199): a file dropped on the rail lands directly in
 * `uploads/`. The one spot of a server-owned area the member may write and delete; every other
 * `uploads/` path is a thread's (`uploads/<thread id>/<name>`, KOBE-144).
 */
export const WORKSPACE_DROP_FOLDER = "uploads";
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Zero-width and invisible characters a lookalike could hide in (ZWSP, ZWNJ, ZWJ, WJ, BOM, SHY).
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff\u00ad]/gu;

/**
 * Whether a name reads as a thread's folder name (a UUID), after trimming, NFKC (fullwidth
 * digits) and dropping invisible characters, so a lookalike cannot pass as one.
 */
export function isThreadFolderName(name: string): boolean {
  return UUID_SHAPE.test(name.normalize("NFKC").replace(INVISIBLE, "").trim());
}

/** A member's drop: `uploads/<name>`, a direct child whose name is not a thread folder's. */
export function isMemberDropPath(path: string): boolean {
  const prefix = `${WORKSPACE_DROP_FOLDER}/`;
  if (!path.startsWith(prefix)) return false;
  const name = path.slice(prefix.length);
  return name !== "" && !name.includes("/") && !isThreadFolderName(name);
}

/** Agent-internal; never synced (session JSONL is rebuilt from Postgres). */
export const WORKSPACE_EXCLUDED_PREFIXES = [".kobe/"] as const;

export const WORKSPACE_PATH_MAX_BYTES = 1024;
export const WORKSPACE_SEGMENT_MAX_BYTES = 255;
/** Most entries per manifest page, hashes per `blobs/missing` call and changes per commit. */
export const WORKSPACE_MAX_BATCH = 1000;

const ENCODER = new TextEncoder();
const utf8Bytes = (s: string): number => ENCODER.encode(s).length;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;
// Bidi embedding/override/isolate controls, LRM/RLM/ALM and the BOM: they make a name display as
// another. Other format characters (ZWJ/ZWNJ in Persian, Indic and emoji names) stay allowed.
const SPOOFING = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c\ufeff]/u;

/**
 * A workspace path: relative to `/workspace`, POSIX separators, NFC-agnostic bytes as written by
 * the sandbox. No leading `/`, no empty, `.` or `..` segments, no control or format characters
 * (bidi controls, BOM) or backslashes, at most {@link WORKSPACE_PATH_MAX_BYTES} UTF-8 bytes and
 * {@link WORKSPACE_SEGMENT_MAX_BYTES} per segment. Never an object key (keys are derived from hashes).
 */
export function workspacePathIssue(path: string): string | undefined {
  if (path.length === 0) return "empty";
  if (utf8Bytes(path) > WORKSPACE_PATH_MAX_BYTES) return "too long";
  if (CONTROL.test(path) || path.includes("\\")) return "control character or backslash";
  // Bidirectional controls make a name display as another (see SPOOFING).
  if (SPOOFING.test(path)) return "bidirectional control or BOM";
  if (path.startsWith("/")) return "absolute";
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return "empty, . or .. segment";
    if (utf8Bytes(segment) > WORKSPACE_SEGMENT_MAX_BYTES) return "segment too long";
  }
  return undefined;
}

export const workspacePathSchema = z.string().superRefine((path, ctx) => {
  const issue = workspacePathIssue(path);
  if (issue !== undefined) ctx.addIssue({ code: "custom", message: `workspace path: ${issue}` });
});

export const isServerOwnedPath = (path: string): boolean =>
  WORKSPACE_SERVER_OWNED_PREFIXES.some((p) => path.startsWith(p));
export const isExcludedPath = (path: string): boolean =>
  WORKSPACE_EXCLUDED_PREFIXES.some((p) => path.startsWith(p) || `${path}/` === p);

export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "lowercase hex SHA-256");

/** Who wrote a workspace version: the sandbox or the server. */
export const workspaceOriginSchema = z.enum(["sandbox", "server"]);
export type WorkspaceOrigin = z.infer<typeof workspaceOriginSchema>;
