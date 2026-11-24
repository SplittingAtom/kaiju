import type { SavedMemoryItem, ToolsResponse } from "./protocol.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalVersion(value: unknown): value is number | undefined {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0);
}

const isString = (value: unknown): value is string => typeof value === "string";

/** A saved memory of a `recall` or `show_memory_item` answer (KOBE-399); undefined when malformed. */
export function parseSavedItem(value: unknown): SavedMemoryItem | undefined {
  if (!isRecord(value) || !isRecord(value.provenance)) return undefined;
  const { id, version, scope, kind, statement, policy, pinned } = value;
  const { actor_kind: actor, as_of: asOf, saved_on: savedOn } = value.provenance;
  if (![id, scope, kind, statement, actor, savedOn].every(isString)) return undefined;
  if (!optionalVersion(version) || version === undefined) return undefined;
  if (typeof policy !== "boolean" || typeof pinned !== "boolean") return undefined;
  if (asOf !== null && !isString(asOf)) return undefined;
  return {
    id: id as string,
    version,
    scope: scope as string,
    kind: kind as string,
    statement: statement as string,
    policy,
    pinned,
    provenance: { actor_kind: actor as string, as_of: asOf, saved_on: savedOn as string },
  };
}

function parseItems(value: unknown): SavedMemoryItem[] | undefined | false {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return false;
  const items: SavedMemoryItem[] = [];
  for (const raw of value as unknown[]) {
    const item = parseSavedItem(raw);
    if (item === undefined) return false;
    items.push(item);
  }
  return items;
}

/**
 * A `memory.put` / `memory.read` / `memory.show` answer (memory.ts), or undefined when it is
 * malformed (fail closed).
 */
export function parseMemoryReply(value: Record<string, unknown>): ToolsResponse | undefined {
  const id = value.id as string;
  if (value.op === "show") {
    const item = parseSavedItem(value.item);
    const status = isRecord(value.item) ? value.item.status : undefined;
    if (item === undefined || !isString(status)) return undefined;
    return { id, ok: true, op: "show", item: { ...item, status } };
  }
  if (value.op === "put") {
    const { status, scope, path, version, previous_version: previous } = value;
    if (status !== "applied" && status !== "pending_approval") return undefined;
    if (typeof scope !== "string" || typeof path !== "string") return undefined;
    if (!optionalVersion(version) || !optionalVersion(previous)) return undefined;
    return {
      id,
      ok: true,
      op: "put",
      status,
      scope,
      path,
      ...(version === undefined ? {} : { version }),
      ...(previous === undefined ? {} : { previous_version: previous }),
    };
  }
  if (value.op !== "read" || !Array.isArray(value.files) || typeof value.truncated !== "boolean") {
    return undefined;
  }
  const files = [];
  for (const item of value.files as unknown[]) {
    if (!isRecord(item)) return undefined;
    const { scope, path, content, version } = item;
    if (typeof scope !== "string" || typeof path !== "string") return undefined;
    if (content !== undefined && typeof content !== "string") return undefined;
    if (!Number.isSafeInteger(version)) return undefined;
    files.push({
      scope,
      path,
      version: version as number,
      ...(content === undefined ? {} : { content }),
    });
  }
  const items = parseItems(value.items);
  if (items === false) return undefined;
  return {
    id,
    ok: true,
    op: "read",
    files,
    truncated: value.truncated,
    ...(items === undefined ? {} : { items }),
  };
}
