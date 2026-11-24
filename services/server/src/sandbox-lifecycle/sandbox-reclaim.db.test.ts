import { randomUUID } from "node:crypto";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWithAuditContext } from "../audit/context.js";
import { createSandboxLifecycle, type LifecycleProvider, type SandboxLifecycle } from "./index.js";
import { withTeam } from "@kaiju/db";
import { recordFlushProof, type ReclaimSettings } from "./reclaim.js";
import { lockWorkspace, reserveUpload, saveState } from "../workspace-sync/store.js";
import type { DestroyResult, HibernateOutcome, WakeResult } from "../sandbox/provider.js";
import type { SandboxTarget } from "../sandbox-wire/types.js";
import { createTeamWithAdmin } from "../teams/members.js";
import { openHarness, type Harness } from "../testing/harness.js";

/**
 * Dormant-volume reclaim (KOBE-733) against a real Postgres: off by default, the agent's shutdown
 * proof (bound to the connection the hibernation closed; cleared by later uploads, commits and
 * wakes), the reaper's refusals (unproven, unsynced uploads, lost content, legal hold, not
 * dormant yet), and the wake after a reclaim starting a new sandbox.
 */

class Provider implements LifecycleProvider {
  readonly calls: string[] = [];
  readonly ids = new Map<string, string>();

  idOf(userId: string): string {
    const id = this.ids.get(userId) ?? randomUUID();
    this.ids.set(userId, id);
    return id;
  }

  wakeSandbox = async (team: { id: string }, userId: string): Promise<WakeResult> => {
    this.calls.push(`wake:${userId}`);
    const existed = this.ids.has(userId);
    const sandboxId = this.idOf(userId);
    return {
      resumed: existed,
      handle: {
        sandboxId,
        namespace: `kaiju-team-${team.id.slice(0, 4)}`,
        claimName: `u-${userId}`,
        sandboxName: `u-${userId}`,
        state: "running",
        podName: `u-${userId}`,
      },
    };
  };

  hibernateSandbox = async (
    _team: unknown,
    userId: string,
    sandboxId: string,
  ): Promise<HibernateOutcome> => {
    this.calls.push(`hibernate:${userId}`);
    return this.ids.get(userId) === sandboxId ? "suspended" : "not_found";
  };

  destroySandbox = async (
    _team: unknown,
    userId: string,
    options: { readonly retainVolume: boolean },
  ): Promise<DestroyResult> => {
    this.calls.push(`destroy:${userId}:${options.retainVolume ? "retain" : "drop"}`);
    const sandboxId = this.ids.get(userId);
    this.ids.delete(userId);
    return sandboxId ? { sandboxId } : {};
  };

  deleteVolume = async (_team: unknown, pvc: string): Promise<void> => {
    this.calls.push(`deleteVolume:${pvc}`);
  };
}

let h: Harness;
let team = "";
let owner = "";
let member = "";
let admin = "";
const log = pino({ level: "silent" });
let provider: Provider;
const CONN = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const reclaim: ReclaimSettings = { dormantDays: 30 };

const lifecycle = (withReclaim: boolean): SandboxLifecycle =>
  createSandboxLifecycle({
    db: h.deps.database.db,
    provider,
    idleMinutes: 15,
    log,
    ...(withReclaim ? { reclaim } : {}),
  });

const target = (): SandboxTarget => ({ teamId: team, userId: member });

/** An awake sandbox row the provider knows, idle for an hour, connected on `CONN`. */
async function awake(): Promise<string> {
  const sandboxId = provider.idOf(member);
  await h.admin.query(
    `INSERT INTO sandboxes (team_id, user_id, sandbox_id, state, pvc, last_active_at, state_changed_at)
     VALUES ($1, $2, $3, 'running', $4, now() - interval '1 hour', now() - interval '1 hour')`,
    [team, member, sandboxId, `workspace-u-${member}`],
  );
  await h.admin.query(
    `INSERT INTO sandbox_connections (team_id, user_id, sandbox_id, connection_id, replica_id)
     VALUES ($1, $2, $3, $4, 'replica-a')`,
    [team, member, sandboxId, CONN],
  );
  return sandboxId;
}

/** The agent's `POST flushed` at the end of its shutdown, as the route records it. */
const flushed = async (sandboxId: string, connectionId = CONN) =>
  (
    await withTeam(h.deps.database.db, team, (tx) =>
      recordFlushProof(tx, { teamId: team, userId: member, sandboxId }, connectionId),
    )
  ).proven;
const flushedOutcome = (sandboxId: string) =>
  withTeam(h.deps.database.db, team, (tx) =>
    recordFlushProof(tx, { teamId: team, userId: member, sandboxId }, CONN),
  );

/** A hibernated row, `days` ago, with or without a proof taken at its hibernation. */
async function dormant(days: number, proven: boolean): Promise<string> {
  const sandboxId = provider.idOf(member);
  await h.admin.query(
    `INSERT INTO sandboxes (team_id, user_id, sandbox_id, state, pvc, last_active_at,
       state_changed_at, volume_synced_at)
     VALUES ($1, $2, $3, 'hibernated', $4, now() - make_interval(days => $5::int + 1),
       now() - make_interval(days => $5::int),
       ${proven ? "now() - make_interval(days => $5::int) + interval '1 minute'" : "NULL"})`,
    [team, member, sandboxId, `workspace-u-${member}`, days],
  );
  return sandboxId;
}

async function row(): Promise<{
  state: string;
  sandbox_id: string | null;
  pvc: string | null;
  volume_synced_at: Date | null;
}> {
  const { rows } = await h.admin.query(
    `SELECT state, sandbox_id, pvc, volume_synced_at FROM sandboxes WHERE team_id = $1 AND user_id = $2`,
    [team, member],
  );
  return rows[0];
}

async function reclaimedAudits(): Promise<unknown[]> {
  const { rows } = await h.admin.query<{ target: unknown }>(
    `SELECT target FROM audit_log WHERE action = 'sandbox.volume_reclaimed' AND team_id = $1`,
    [team],
  );
  return rows.map((r) => r.target);
}

beforeAll(async () => {
  h = await openHarness();
  owner = await h.createUser("owner@reclaim.test", "owner");
  admin = await h.createUser("admin@reclaim.test", "admin");
  member = await h.createUser("member@reclaim.test");
  team = (
    await runWithAuditContext(
      { actor: { kind: "user", id: owner }, ip: null, userAgent: null },
      () => createTeamWithAdmin(h.deps.database.db, { slug: "reclaim", name: "reclaim" }, owner),
    )
  ).id;
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
    [team, member],
  );
}, 120_000);

afterAll(() => h?.close());

beforeEach(async () => {
  provider = new Provider();
  await h.admin.query(`DELETE FROM legal_holds`);
  await h.admin.query(`DELETE FROM sandboxes`);
  await h.admin.query(`DELETE FROM sandbox_connections`);
  await h.admin.query(`DELETE FROM workspace_blobs`);
  await h.admin.query(`DELETE FROM workspace_sync`);
  await h.admin.query(`INSERT INTO workspace_sync (team_id, user_id) VALUES ($1, $2)`, [
    team,
    member,
  ]);
});

describe("off by default", () => {
  it("reclaims nothing without the reclaim setting, even a dormant, proven volume", async () => {
    await dormant(90, true);
    const result = await lifecycle(false).sweep();
    expect(result.reclaimed).toEqual([]);
    expect(provider.calls.filter((c) => c.startsWith("destroy"))).toEqual([]);
    expect((await row()).sandbox_id).not.toBeNull();
  });
});

describe("the agent's shutdown proof", () => {
  it("starts empty at hibernation and is recorded from the connection the hibernation closed", async () => {
    const sandboxId = await awake();
    expect(await lifecycle(true).hibernate(target())).toBe(true);
    expect((await row()).volume_synced_at).toBeNull();
    expect(await flushed(sandboxId)).toBe(true);
    expect((await row()).volume_synced_at).not.toBeNull();
  });

  it("is refused before the hibernation, from another sandbox, or from an earlier connection", async () => {
    const sandboxId = await awake();
    // Still running: a shutdown that is not a hibernation proves nothing (the agent retries once).
    expect(await flushedOutcome(sandboxId)).toEqual({ proven: false, reason: "not_hibernated" });
    await lifecycle(true).hibernate(target());
    expect(await flushed(randomUUID())).toBe(false);
    expect(await flushed(sandboxId, randomUUID())).toBe(false);
    expect((await row()).volume_synced_at).toBeNull();
    // A connection that had already closed before the hibernation (the hibernation closed none).
    await h.admin.query(`DELETE FROM sandboxes`);
    await h.admin.query(`DELETE FROM sandbox_connections`);
    const again = await awake();
    await h.admin.query(`UPDATE sandbox_connections SET closed_at = now() - interval '1 minute'`);
    await lifecycle(true).hibernate(target());
    expect(await flushed(again)).toBe(false);
  });

  it("is refused while an upload is reserved (the shutdown upload did not finish)", async () => {
    const sandboxId = await awake();
    await lifecycle(true).hibernate(target());
    await h.admin.query(
      `UPDATE workspace_sync SET pending_blobs = 1, pending_bytes = 5, pending_since = now()
        WHERE team_id = $1`,
      [team],
    );
    expect(await flushed(sandboxId)).toBe(false);
  });

  it("is cleared by an upload or a manifest change after it, so the volume is kept", async () => {
    const sandboxId = await awake();
    const lc = lifecycle(true);
    await lc.hibernate(target());
    expect(await flushed(sandboxId)).toBe(true);
    const owner = { teamId: team, userId: member };
    await withTeam(h.deps.database.db, team, (tx) =>
      reserveUpload(tx, owner, 1, { maxBlobBytes: 1e9, maxUncommittedBlobs: 100 }),
    );
    expect((await row()).volume_synced_at).toBeNull();
    await h.admin.query(`UPDATE workspace_sync SET pending_blobs = 0, pending_bytes = 0`);
    expect(await flushed(sandboxId)).toBe(true);
    await withTeam(h.deps.database.db, team, async (tx) =>
      saveState(tx, owner, await lockWorkspace(tx, owner), true),
    );
    expect((await row()).volume_synced_at).toBeNull();
    // Dormant now, but unproven: kept.
    await h.admin.query(`UPDATE sandboxes SET state_changed_at = now() - interval '40 days'`);
    expect((await lc.sweep()).reclaimed).toEqual([]);
  });

  it("is cleared by a wake", async () => {
    const sandboxId = await awake();
    const lc = lifecycle(true);
    await lc.hibernate(target());
    await flushed(sandboxId);
    await lc.waker.wake(target());
    const r = await row();
    expect(r.state).toBe("running");
    expect(r.volume_synced_at).toBeNull();
  });
});

describe("the dormant-volume reaper", () => {
  it("reclaims a proven volume hibernated past the period, audited; the wake starts a new sandbox", async () => {
    const old = await dormant(40, true);
    const lc = lifecycle(true);
    const result = await lc.sweep();
    expect(result.reclaimed).toEqual([target()]);
    expect(provider.calls).toEqual([
      `destroy:${member}:drop`,
      `deleteVolume:workspace-u-${member}`,
    ]);
    expect(await row()).toMatchObject({
      state: "hibernated",
      sandbox_id: null,
      pvc: null,
      volume_synced_at: null,
    });
    expect(await reclaimedAudits()).toContainEqual({
      sandboxId: old,
      userId: member,
      dormantDays: 30,
    });
    // Nothing left to reclaim on the next sweep.
    expect((await lc.sweep()).reclaimed).toEqual([]);
    // The next message wakes a new sandbox (its agent restores /workspace from the copy).
    await lc.waker.wake(target());
    const woken = await row();
    expect(woken.state).toBe("running");
    expect(woken.sandbox_id).not.toBeNull();
    expect(woken.sandbox_id).not.toBe(old);
    expect(provider.calls.at(-1)).toBe(`wake:${member}`);
  });

  it("never reclaims a volume without a proof", async () => {
    await dormant(40, false);
    expect((await lifecycle(true).sweep()).reclaimed).toEqual([]);
    expect(provider.calls).toEqual([]);
  });

  it("never reclaims before the dormancy period", async () => {
    await dormant(10, true);
    expect((await lifecycle(true).sweep()).reclaimed).toEqual([]);
  });

  it("never reclaims with an upload in flight or content lost from storage", async () => {
    await dormant(40, true);
    await h.admin.query(
      `UPDATE workspace_sync SET pending_blobs = 1, pending_bytes = 10, pending_since = now()
        WHERE team_id = $1`,
      [team],
    );
    expect((await lifecycle(true).sweep()).reclaimed).toEqual([]);
    await h.admin.query(
      `UPDATE workspace_sync SET pending_blobs = 0, pending_bytes = 0, pending_since = NULL,
          blob_count = 1, blob_bytes = 1 WHERE team_id = $1`,
      [team],
    );
    await h.admin.query(
      `INSERT INTO workspace_blobs (team_id, user_id, sha256, size, lost_at)
       VALUES ($1, $2, repeat('a', 64), 1, now())`,
      [team, member],
    );
    expect((await lifecycle(true).sweep()).reclaimed).toEqual([]);
    expect(provider.calls).toEqual([]);
  });

  it("never reclaims without a workspace copy at all", async () => {
    await dormant(40, true);
    await h.admin.query(`DELETE FROM workspace_sync`);
    expect((await lifecycle(true).sweep()).reclaimed).toEqual([]);
  });

  it("never reclaims under a legal hold on the member", async () => {
    await dormant(40, true);
    const { rows } = await h.admin.query<{ id: string }>(
      `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3)
       RETURNING id`,
      [team, member, admin],
    );
    await h.admin.query(
      `UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
      [rows[0]?.id, owner],
    );
    expect((await lifecycle(true).sweep()).reclaimed).toEqual([]);
    expect(provider.calls).toEqual([]);
  });

  it("leaves the row as it was when the Kubernetes delete fails (the next sweep retries)", async () => {
    await dormant(40, true);
    const before = (await reclaimedAudits()).length;
    provider.destroySandbox = async () => {
      throw new Error("API down");
    };
    const result = await lifecycle(true).sweep();
    expect(result.reclaimed).toEqual([]);
    expect(result.failedTeams).toBeGreaterThanOrEqual(1);
    expect((await row()).sandbox_id).not.toBeNull();
    expect(await reclaimedAudits()).toHaveLength(before);
  });
});
