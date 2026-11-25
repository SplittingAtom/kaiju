import { sql, withTeam } from "@kaiju/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { piSessionEntrySql } from "../sandbox-wire/entries.js";
import { RunFixture } from "../testing/run-fixture.js";
import { isSkippedSummaryEntry } from "./skipped-summary.js";

/**
 * KOBE-827: skipped-actions notes written before the rename keep `kobe.skipped_actions` in
 * `thread_entries` (append-only history, not rewritten). They are still the server's own entries:
 * never a branch point, never restored into Pi.
 */
const f = new RunFixture();
beforeAll(async () => {
  await f.setup();
});
afterAll(async () => {
  await f.teardown();
});

const AT = "2026-11-05T10:00:00.000Z";

describe("skipped-actions notes from before the rename (KOBE-827)", () => {
  it("are recognised as the server's notes under both names", async () => {
    const w = await f.world();
    const thread = await f.thread(w.owner);
    const insert = (entryId: string, customType: string) =>
      f.fx.admin.query(
        `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
         VALUES ($1, $2, $3, NULL, 'custom_message', $4)`,
        [
          w.team,
          thread,
          entryId,
          { type: "custom_message", id: entryId, parentId: null, timestamp: AT, customType },
        ],
      );
    await insert("ks-000000000000000000000001", "kobe.skipped_actions");
    await insert("ks-000000000000000000000002", "kaiju.skipped_actions");
    await insert("x1", "evil.skipped_actions");

    const known = await withTeam(f.fx.db, w.team, async (tx) => ({
      old: await isSkippedSummaryEntry(tx, w.team, thread, "ks-000000000000000000000001"),
      current: await isSkippedSummaryEntry(tx, w.team, thread, "ks-000000000000000000000002"),
      other: await isSkippedSummaryEntry(tx, w.team, thread, "x1"),
    }));
    expect(known).toEqual({ old: true, current: true, other: false });

    const piEntries = await withTeam(f.fx.db, w.team, (tx) =>
      tx.execute<{ entry_id: string }>(sql`
        SELECT entry_id FROM thread_entries
         WHERE team_id = ${w.team} AND thread_id = ${thread} AND ${piSessionEntrySql}
         ORDER BY entry_id`),
    );
    expect(piEntries.rows.map((r) => r.entry_id)).toEqual(["x1"]);
  });
});
