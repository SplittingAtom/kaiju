import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@kaiju/db";
import { EgressBlockedRelay } from "../egress/blocked-relay.js";
import { SkillEvalHub } from "../skills/evals/events.js";
import { openHarness, type Harness } from "../testing/harness.js";

// KOBE-704 / STO-5: every listener of a server process shares one LISTEN connection.

let h: Harness;
beforeAll(async () => {
  h = await openHarness();
});
afterAll(() => h.close());

async function waitFor(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("shared LISTEN connection (KOBE-704)", () => {
  it("carries the hub, bus, budgets, skill evals and egress relay on one session", async () => {
    const { deps } = h;
    const unsubscribe = deps.eventStream.hub.subscribe("1c7f0d4e-5a3c-4d8e-9a43-5f7b0f2d1c12", {
      hint: () => undefined,
      resync: () => undefined,
      close: () => undefined,
    });
    deps.budgets.start();
    const evals = new SkillEvalHub(deps.listen);
    evals.start();
    const relay = new EgressBlockedRelay({ db: deps.database.db, listen: deps.listen });
    relay.start();
    try {
      await waitFor(
        () => deps.listen.state === "listening" && deps.eventStream.hub.state === "listening",
      );
      expect([...deps.listen.channels].sort()).toEqual(
        [
          "kobe_egress_blocked",
          "kobe_models",
          "kobe_run_events",
          "kobe_sandbox",
          "kobe_skill_eval",
        ].sort(),
      );
      await waitFor(async () => {
        const res = await h.admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND application_name = 'kaiju-server-listen'`,
        );
        return res.rows[0]?.n === 1;
      });
      const listed = await h.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND application_name LIKE 'kaiju-%'
            AND application_name NOT IN ('kaiju-server', 'kaiju-server-listen', 'kaiju-event-stream')`,
      );
      // No other dedicated LISTEN session (the pre-KOBE-704 kaiju-event-hub, kobe-sandbox-bus).
      expect(listed.rows[0]?.n).toBe(0);
    } finally {
      unsubscribe();
      await relay.close();
      await evals.close();
    }
  });

  it("names every app-role session of the process (KOBE-736)", async () => {
    await h.deps.database.db.execute(sql`SELECT 1`);
    const { rows } = await h.admin.query<{ name: string }>(
      `SELECT DISTINCT application_name AS name FROM pg_stat_activity
        WHERE datname = current_database() AND usename <> current_user AND backend_type = 'client backend'`,
    );
    const names = rows.map((r) => r.name);
    expect(names).toContain("kaiju-server");
    for (const name of names) {
      expect(["kaiju-server", "kaiju-server-listen", "kaiju-event-stream"]).toContain(name);
    }
  });
});
