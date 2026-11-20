import {
  semanticMemoryItemSchema,
  semanticMemoryListQuerySchema,
  SEMANTIC_MEMORY_STATUSES,
} from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { createMemoryItemsApi, listPath, type ItemStatus } from "./items-api";

const ID = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";

/** A team item as the server sends it (KOBE-386: `stale` is a flag, not a status). */
const wireItem = {
  id: ID,
  scope: "team",
  kind: "fact",
  status: "active",
  statement: "The office closes at six.",
  tags: [],
  pinned: false,
  policy: false,
  as_of: null,
  owner_user_id: null,
  superseded_by: null,
  version: 1,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  updated_by: USER,
  stale: true,
};

describe("memory items: stale (KOBE-386)", () => {
  it("is a flag on an active item the server can send, not a status", async () => {
    expect(semanticMemoryItemSchema.safeParse(wireItem).success).toBe(true);
    expect(semanticMemoryItemSchema.safeParse({ ...wireItem, status: "stale" }).success).toBe(
      false,
    );
    const statuses: readonly ItemStatus[] = SEMANTIC_MEMORY_STATUSES;
    expect(statuses).not.toContain("stale");

    const fetchFn = (async () =>
      new Response(JSON.stringify(wireItem), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const res = await createMemoryItemsApi("team", fetchFn).get("team", ID);
    expect(res).toMatchObject({ ok: true, data: { status: "active", stale: true } });
  });

  it("filters on stale with a query the server accepts", () => {
    for (const stale of [true, false, undefined]) {
      const path = listPath({ scope: "team", status: "active", stale });
      const params = Object.fromEntries(new URL(path, "http://x").searchParams);
      expect(params.stale).toBe(stale === undefined ? undefined : String(stale));
      const query = semanticMemoryListQuerySchema.parse(params);
      expect(query.stale).toBe(stale);
    }
  });
});
