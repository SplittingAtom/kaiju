import { describe, expect, it } from "vitest";
import { withTeam } from "@kaiju/db";
import { notifyConversionEndInTx } from "./conversion/bell.js";
import { sweepGitConversions } from "./conversion/job.js";
import { runConversion } from "./conversion/runner.js";
import { startConversion } from "./conversion/start.js";
import { LeaseLost, readConversion } from "./conversion/store.js";
import {
  deps,
  fx,
  hostRepo,
  kind,
  must,
  project,
  setWireHook,
  settled,
  unreachable,
  world,
  type World,
} from "../testing/git-conversion-fixture.js";
import type { Person } from "../testing/event-stream-fixture.js";

/**
 * KOBE-819: the bell tells the member who started a Convert to repo how it ended (finished, or
 * failed with the member-safe reason the dialog shows), exactly once per end: the notification is
 * written in the transaction that records the end, in a savepoint, so a retried job, a racing
 * replica or a repeated write adds nothing, and a notification that cannot be written never fails
 * or re-runs the conversion.
 */

/** An attempt started without the route's own run (the test drives the job). */
async function begin(w: World, projectId: string): Promise<string> {
  const started = await startConversion(deps(), { teamId: w.team, userId: w.owner.id }, projectId, {
    connection_id: w.connectionId,
  });
  if (!started.ok) throw new Error(JSON.stringify(started.body));
  return started.value.id;
}

async function bellRows(team: string) {
  const { rows } = await fx.admin.query<{
    user_id: string;
    kind: string;
    git_conversion_id: string;
    git_attempt: number;
    git_failure: string | null;
  }>(
    `SELECT user_id, kind, git_conversion_id, git_attempt, git_failure FROM notifications
      WHERE team_id = $1 AND kind LIKE 'git.%' ORDER BY created_at, git_attempt`,
    [team],
  );
  return rows;
}

async function gitNotes(p: Person): Promise<Record<string, unknown>[]> {
  const res = await p.browser.request("GET", "/v1/notifications");
  expect(res.status, res.text).toBe(200);
  return (res.json.notifications as Record<string, unknown>[]).filter((n) =>
    String(n.kind).startsWith("git."),
  );
}

describe("a conversion that finished (KOBE-819 ac-1)", () => {
  it("tells the member who started it, once, naming the project and the repository", async () => {
    const w = await world();
    const p = await project(w, [{ by: w.owner, message: "one", files: { "a.txt": "1" } }]);
    hostRepo(p.slug);
    const id = await begin(w, p.id);
    expect(await runConversion(deps(), w.team, id)).toBe("completed");
    expect(await bellRows(w.team)).toEqual([
      {
        user_id: w.owner.id,
        kind: "git.conversion.completed",
        git_conversion_id: id,
        git_attempt: 1,
        git_failure: null,
      },
    ]);
    // The job running again (a resume sweep, another replica) finds nothing to claim, and a
    // second write of the same end (a racing replica) is a no-op.
    expect(await runConversion(deps(), w.team, id)).toBe("busy");
    const row = must(await withTeam(fx.db, w.team, (tx) => readConversion(tx, w.team, id)));
    await Promise.all([
      withTeam(fx.db, w.team, (tx) => notifyConversionEndInTx(tx, row)),
      withTeam(fx.db, w.team, (tx) => notifyConversionEndInTx(tx, row)),
    ]);
    expect(await bellRows(w.team)).toHaveLength(1);

    expect(await gitNotes(w.owner)).toEqual([
      expect.objectContaining({
        kind: "git.conversion.completed",
        schedule_id: null,
        thread_id: null,
        run_id: null,
        git_conversion_id: id,
        project_id: p.id,
        project_name: `Project ${p.slug}`,
        git_repository: `acme/${p.slug}`,
        read_at: null,
      }),
    ]);
    // Addressed to the requester only.
    expect(await gitNotes(w.admin)).toEqual([]);
    expect(await gitNotes(w.member)).toEqual([]);
  });

  it("tells nobody when the requester was deactivated meanwhile", async () => {
    const w = await world();
    const p = await project(w, [{ by: w.owner, message: "one", files: { "a.txt": "1" } }]);
    hostRepo(p.slug);
    const id = await begin(w, p.id);
    await fx.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [w.owner.id]);
    expect(await runConversion(deps(), w.team, id)).toBe("completed");
    expect(await bellRows(w.team)).toEqual([]);
  });

  it("a notification that cannot be written neither fails nor re-runs the conversion", async () => {
    const w = await world();
    const p = await project(w, [{ by: w.owner, message: "one", files: { "a.txt": "1" } }]);
    hostRepo(p.slug);
    const id = await begin(w, p.id);
    const fn = `kaiju_test_refuse_${w.team.replaceAll("-", "")}`;
    await fx.admin.query(`
      CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'refused by the test'; END $$`);
    await fx.admin.query(`
      CREATE TRIGGER ${fn} BEFORE INSERT ON notifications FOR EACH ROW
        WHEN (NEW.team_id = '${w.team}'::uuid) EXECUTE FUNCTION ${fn}()`);
    try {
      expect(await runConversion(deps(), w.team, id)).toBe("completed");
    } finally {
      await fx.admin.query(`DROP TRIGGER ${fn} ON notifications`);
      await fx.admin.query(`DROP FUNCTION ${fn}()`);
    }
    expect(await kind(w.team, p.id)).toBe("repo");
    const { rows } = await fx.admin.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM git_conversions WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({ status: "completed", attempts: 1 });
    expect(await bellRows(w.team)).toEqual([]);
  });
});

describe("a conversion that failed (KOBE-819 ac-1)", () => {
  it("tells the requester each time it fails, with the dialog's reason, then when it finishes", async () => {
    const w = await world();
    const p = await project(w, [{ by: w.owner, message: "one", files: { "a.txt": "1" } }]);
    hostRepo(p.slug);
    setWireHook((url) => {
      if (url.pathname.includes("/info/refs")) throw unreachable();
    });
    try {
      const id = await begin(w, p.id);
      expect(await runConversion(deps(), w.team, id)).toBe("failed");
      expect(await bellRows(w.team)).toMatchObject([
        { user_id: w.owner.id, kind: "git.conversion.failed", git_failure: "host_unreachable" },
      ]);
      const [note] = await gitNotes(w.owner);
      expect(note).toMatchObject({
        kind: "git.conversion.failed",
        project_id: p.id,
        git_repository: `acme/${p.slug}`,
        git_failure: "host_unreachable",
        git_failure_message: "The git host could not be reached. Retry shortly.",
      });
      // The failure as the dialog shows it: the same words.
      const view = await settled(w.owner, p.id);
      expect(note?.git_failure_message).toBe(view.error?.message);

      // A person's retry that fails again is another end: told again.
      const retry = await w.owner.browser.request(
        "POST",
        `/v1/projects/${p.id}/repo-conversion/retry`,
      );
      expect(retry.status, retry.text).toBe(202);
      expect((await settled(w.owner, p.id)).status).toBe("failed");
      setWireHook(undefined);
      await w.owner.browser.request("POST", `/v1/projects/${p.id}/repo-conversion/retry`);
      expect((await settled(w.owner, p.id)).status).toBe("completed");
      expect((await bellRows(w.team)).map((r) => [r.kind, r.git_attempt])).toEqual([
        ["git.conversion.failed", 1],
        ["git.conversion.failed", 2],
        ["git.conversion.completed", 3],
      ]);
      expect(await gitNotes(w.member)).toEqual([]);
    } finally {
      setWireHook(undefined);
    }
  });

  it("tells the requester when the poison guard stops it", async () => {
    const w = await world();
    const p = await project(w, [{ by: w.owner, message: "one", files: { "a.txt": "1" } }]);
    const id = await begin(w, p.id);
    const die = {
      ...deps(),
      beforeStep: () => {
        throw new LeaseLost();
      },
    };
    const lapse = () =>
      fx.admin.query(
        `UPDATE git_conversions SET progress_at = NULL, lease_until = now() - interval '1 second'
          WHERE id = $1`,
        [id],
      );
    expect(await runConversion(die, w.team, id)).toBe("lost");
    await lapse();
    expect(await runConversion(die, w.team, id)).toBe("lost");
    await lapse();
    expect(await sweepGitConversions(deps())).toBeGreaterThanOrEqual(1);
    expect((await settled(w.owner, p.id)).status).toBe("failed");
    expect(await bellRows(w.team)).toMatchObject([
      { user_id: w.owner.id, kind: "git.conversion.failed", git_failure: "interrupted" },
    ]);
  });
});
