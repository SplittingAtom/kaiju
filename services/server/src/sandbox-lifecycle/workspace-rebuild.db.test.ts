import { randomUUID } from "node:crypto";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWithAuditContext } from "../audit/context.js";
import { createSandboxLifecycle, type LifecycleProvider } from "./index.js";
import { completeRebuild, type RebuildProvider } from "./rebuild.js";
import type { DiscardGuard, HibernateOutcome, WakeResult } from "../sandbox/provider.js";
import type { VolumeHealth } from "../sandbox/volume-loss.js";
import { createTeamWithAdmin } from "../teams/members.js";
import type { TestBrowser } from "../testing/browser.js";
import { openHarness, type Harness } from "../testing/harness.js";

/**
 * Rebuilding a workspace whose volume is lost (KOBE-739) against a real Postgres, through the
 * member and team admin routes: member-confirmed (status first: volume state and last sync); a
 * node that is down counts only after this server saw it down for the grace period; re-checked
 * at confirm time (a reachable volume is never destroyed); marked and audited before any cluster
 * delete, with a failed cleanup finished by a retry or the sweep; idempotent; recorded under a
 * legal hold; and the next wake starts a new sandbox.
 */

const LOST: VolumeHealth = {
  state: "lost",
  reason: "volume_failed",
  detail: "volume pvc-1 is Failed",
};
const NODE_DOWN: VolumeHealth = {
  state: "node_down",
  reason: "node_gone",
  node: "compute4",
  detail: "volume pvc-1 lives only on node compute4, which does not exist",
};

class Provider implements RebuildProvider, LifecycleProvider {
  health: VolumeHealth = LOST;
  failHealth = false;
  failDiscard = false;
  healthReads = 0;
  readonly calls: string[] = [];
  volumeGone = false;

  volumeHealth = async (): Promise<VolumeHealth> => {
    this.healthReads += 1;
    if (this.failHealth) throw new Error("Kubernetes API unavailable");
    return this.volumeGone ? { state: "missing" } : this.health;
  };

  readonly guards: (DiscardGuard | undefined)[] = [];
  /** While set, a discard waits for it (a slow cluster). */
  gate: Promise<void> | undefined;

  readonly signals: (AbortSignal | undefined)[] = [];
  /** The cluster shows another claim than the confirmed one (review g72-3). */
  refuse: "newer_claim" | "replaced" | undefined;

  discardLostVolume = async (
    _team: unknown,
    userId: string,
    guard?: DiscardGuard,
    signal?: AbortSignal,
  ) => {
    if (this.failDiscard) throw new Error("Kubernetes API unavailable");
    this.guards.push(guard);
    this.signals.push(signal);
    this.calls.push(`discard:${userId}`);
    if (this.refuse) return { pvc: `workspace-u-${userId}`, refused: this.refuse };
    await this.gate;
    this.volumeGone = true;
    return { sandboxId: SANDBOX, pvc: `workspace-u-${userId}` };
  };

  wakeSandbox = async (_team: unknown, userId: string): Promise<WakeResult> => {
    this.calls.push(`wake:${userId}`);
    this.volumeGone = false;
    this.health = { state: "present" };
    const sandboxId = randomUUID();
    return {
      resumed: false,
      handle: {
        sandboxId,
        namespace: "kobe-team-rebuild",
        claimName: `u-${userId}`,
        sandboxName: `u-${userId}`,
        state: "running",
        podName: `u-${userId}`,
      },
    };
  };

  hibernateSandbox = async (): Promise<HibernateOutcome> => "suspended";
}

const SANDBOX = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const CONN = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
let h: Harness;
let team = "";
let owner = "";
let member = "";
let other = "";
let siteAdmin = "";
/** Audit events of the current test only (the log is append-only). */
let since = 0;
let provider: Provider;
let asMember: TestBrowser;
let asOther: TestBrowser;
let asOwner: TestBrowser;

const row = async () =>
  (
    await h.admin.query(
      `SELECT state, sandbox_id, pvc FROM sandboxes WHERE team_id = $1 AND user_id = $2`,
      [team, member],
    )
  ).rows[0] as { state: string; sandbox_id: string | null; pvc: string | null };

/** A fresh status read (the service caches answers 30 s; a new provider clears that). */
const freshStatus = async () => {
  h.deps.workspaceRebuild.setProvider(provider, true);
  return asMember.get("/v1/workspace/rebuild");
};

const lostSince = async (): Promise<Date | null> =>
  (
    await h.admin.query(
      `SELECT volume_lost_since FROM sandboxes WHERE team_id = $1 AND user_id = $2`,
      [team, member],
    )
  ).rows[0]?.volume_lost_since ?? null;

const lifecycle = () =>
  createSandboxLifecycle({
    db: h.deps.database.db,
    provider,
    idleMinutes: 15,
    log: pino({ level: "silent" }),
  });

const audits = async () =>
  (
    await h.admin.query<{ actor_id: string; target: Record<string, unknown> }>(
      `SELECT actor_id, target FROM audit_log
        WHERE action = 'sandbox.volume_rebuilt' AND team_id = $1 AND seq > $2 ORDER BY seq`,
      [team, since],
    )
  ).rows;

beforeAll(async () => {
  h = await openHarness();
  owner = await h.createUser("owner@rebuild.test", "owner");
  member = await h.createUser("member@rebuild.test");
  other = await h.createUser("other@rebuild.test");
  siteAdmin = await h.createUser("admin@rebuild.test", "admin");
  team = (
    await runWithAuditContext(
      { actor: { kind: "user", id: owner }, ip: null, userAgent: null },
      () => createTeamWithAdmin(h.deps.database.db, { slug: "rebuild", name: "rebuild" }, owner),
    )
  ).id;
  for (const u of [member, other]) {
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [team, u],
    );
  }
  asMember = await h.signIn("member@rebuild.test");
  asOther = await h.signIn("other@rebuild.test");
  asOwner = await h.signIn("owner@rebuild.test");
  for (const b of [asMember, asOther, asOwner]) {
    expect((await b.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    b.team = team;
  }
}, 120_000);

afterAll(() => h?.close());

beforeEach(async () => {
  provider = new Provider();
  h.deps.workspaceRebuild.setProvider(provider, true);
  await h.admin.query(`DELETE FROM legal_holds`);
  await h.admin.query(`DELETE FROM sandboxes`);
  await h.admin.query(`DELETE FROM sandbox_connections`);
  await h.admin.query(`DELETE FROM workspace_sync`);
  since = Number(
    (await h.admin.query(`SELECT coalesce(max(seq), 0) AS s FROM audit_log`)).rows[0].s,
  );
  // A wake that failed on the lost volume left the row `running` with its old claim.
  await h.admin.query(
    `INSERT INTO sandboxes (team_id, user_id, sandbox_id, state, pvc)
     VALUES ($1, $2, $3, 'running', $4)`,
    [team, member, SANDBOX, `workspace-u-${member}`],
  );
  await h.admin.query(
    `INSERT INTO sandbox_connections (team_id, user_id, sandbox_id, connection_id, replica_id)
     VALUES ($1, $2, $3, $4, 'replica-a')`,
    [team, member, SANDBOX, CONN],
  );
  await h.admin.query(
    `INSERT INTO workspace_sync (team_id, user_id, last_push_at)
     VALUES ($1, $2, '2026-11-21T10:15:00Z')`,
    [team, member],
  );
});

describe("the member sees what happened before confirming (ac-3)", () => {
  it("answers the volume state and the last sync time", async () => {
    const res = await asMember.get("/v1/workspace/rebuild");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      volume: "lost",
      last_synced_at: "2026-11-21T10:15:00.000Z",
      rebuildable: true,
    });
  });

  it("never offers it for a reachable volume or when the cluster cannot be read", async () => {
    provider.health = { state: "present" };
    expect((await freshStatus()).json).toMatchObject({ volume: "present", rebuildable: false });
    provider.failHealth = true;
    expect((await freshStatus()).json).toMatchObject({ volume: "unknown", rebuildable: false });
  });

  it("answers 503 without workspace storage to restore from", async () => {
    h.deps.workspaceRebuild.setProvider(provider, false);
    expect((await asMember.get("/v1/workspace/rebuild")).status).toBe(503);
    const res = await asMember.post("/v1/workspace/rebuild", { confirm: true });
    expect(res).toMatchObject({ status: 503, json: { code: "rebuild_unavailable" } });
    expect(provider.calls).toEqual([]);
  });

  it("reuses a status answer for 30 s (the cluster is read once)", async () => {
    await asMember.get("/v1/workspace/rebuild");
    await asMember.get("/v1/workspace/rebuild");
    expect(provider.healthReads).toBe(1);
  });
});

describe("a node that is down is lost only after the grace period (review g72 HIGH)", () => {
  it("records when this server first saw it down and offers nothing before 30 minutes", async () => {
    provider.health = NODE_DOWN;
    const res = await freshStatus();
    expect(res.json).toMatchObject({ volume: "unreachable", rebuildable: false });
    const first = await lostSince();
    expect(first).not.toBeNull();
    expect(Date.parse(res.json.offer_at) - Date.parse(res.json.down_since)).toBe(30 * 60_000);
    // A later observation keeps the first time.
    await freshStatus();
    expect((await lostSince())?.getTime()).toBe(first?.getTime());
    const confirm = await asMember.post("/v1/workspace/rebuild", { confirm: true });
    expect(confirm).toMatchObject({ status: 409, json: { code: "volume_not_yet_lost" } });
    expect(provider.calls).toEqual([]);
  });

  it("offers and rebuilds once the node stayed down for the grace period, with the evidence", async () => {
    provider.health = NODE_DOWN;
    await freshStatus();
    await h.admin.query(`UPDATE sandboxes SET volume_lost_since = now() - interval '31 minutes'`);
    expect((await freshStatus()).json).toMatchObject({ volume: "lost", rebuildable: true });
    const res = await asMember.post("/v1/workspace/rebuild", { confirm: true });
    expect(res.json.status).toBe("rebuilt");
    const [event] = await audits();
    expect(event?.target).toMatchObject({ reason: "node_gone", node: "compute4" });
    expect(event?.target["firstSeenAt"]).toEqual(expect.any(String));
  });

  it("starts over when the node is seen back", async () => {
    provider.health = NODE_DOWN;
    await freshStatus();
    await h.admin.query(`UPDATE sandboxes SET volume_lost_since = now() - interval '31 minutes'`);
    provider.health = { state: "present" };
    await freshStatus();
    expect(await lostSince()).toBeNull();
    provider.health = NODE_DOWN;
    expect((await freshStatus()).json).toMatchObject({ volume: "unreachable" });
  });
});

describe("confirming the rebuild (ac-2)", () => {
  it("discards the lost volume, resets the row, closes the dead connection, and audits", async () => {
    expect((await asMember.post("/v1/workspace/rebuild", {})).status).toBe(400);
    const res = await asMember.post("/v1/workspace/rebuild", { confirm: true });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "rebuilt", last_synced_at: "2026-11-21T10:15:00.000Z" });
    expect(provider.calls).toEqual([`discard:${member}`]);
    expect(await row()).toEqual({ state: "hibernated", sandbox_id: null, pvc: null });
    const conn = await h.admin.query(
      `SELECT closed_at FROM sandbox_connections WHERE connection_id = $1`,
      [CONN],
    );
    expect(conn.rows[0].closed_at).not.toBeNull();
    const [event, ...more] = await audits();
    expect(more).toEqual([]);
    expect(event).toMatchObject({
      actor_id: member,
      target: {
        sandboxId: SANDBOX,
        userId: member,
        reason: "volume_failed",
        firstSeenAt: null,
        lastSyncedAt: "2026-11-21T10:15:00.000Z",
        legalHold: false,
        byAdmin: false,
      },
    });
  });

  it("is refused when the volume is reachable at confirm time (re-checked; nothing deleted)", async () => {
    provider.health = { state: "present" };
    const res = await asMember.post("/v1/workspace/rebuild", { confirm: true });
    expect(res).toMatchObject({ status: 409, json: { code: "volume_reachable" } });
    provider.failHealth = true;
    expect((await asMember.post("/v1/workspace/rebuild", { confirm: true })).status).toBe(409);
    expect(provider.calls).toEqual([]);
    expect((await row()).sandbox_id).toBe(SANDBOX);
    expect(await audits()).toEqual([]);
  });

  it("audits before the cluster work; a failed cleanup is pending, wakes wait, a retry finishes it", async () => {
    provider.failDiscard = true;
    const res = await asMember.post("/v1/workspace/rebuild", { confirm: true });
    expect(res).toMatchObject({ status: 503, json: { code: "rebuild_pending" } });
    expect(await audits()).toHaveLength(1);
    const wake = await lifecycle()
      .waker.wake({ teamId: team, userId: member })
      .catch((e: unknown) => e);
    expect(wake).toMatchObject({ code: "workspace_rebuilding" });
    expect((await freshStatus()).json).toMatchObject({ volume: "rebuilding", rebuildable: true });

    provider.failDiscard = false;
    const retry = await asMember.post("/v1/workspace/rebuild", { confirm: true });
    expect(retry.json.status).toBe("rebuilt");
    expect(await audits()).toHaveLength(1);
    expect(await row()).toEqual({ state: "hibernated", sandbox_id: null, pvc: null });
  });

  it("the hibernation sweep finishes a rebuild left unfinished", async () => {
    provider.failDiscard = true;
    await asMember.post("/v1/workspace/rebuild", { confirm: true });
    await h.admin.query(`UPDATE sandboxes SET rebuild_started_at = now() - interval '2 minutes'`);
    provider.failDiscard = false;
    await lifecycle().sweep();
    expect(provider.calls).toEqual([`discard:${member}`]);
    expect(await row()).toEqual({ state: "hibernated", sandbox_id: null, pvc: null });
  });

  it("is idempotent: a double click rebuilds once and audits once", async () => {
    const [a, b] = await Promise.all([
      asMember.post("/v1/workspace/rebuild", { confirm: true }),
      asMember.post("/v1/workspace/rebuild", { confirm: true }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.json.status, b.json.status].sort()).toEqual(["already", "rebuilt"]);
    expect(await audits()).toHaveLength(1);
  });

  it("is allowed under a legal hold (nothing in object storage is deleted), and audited so", async () => {
    const { rows } = await h.admin.query<{ id: string }>(
      `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3)
       RETURNING id`,
      [team, member, siteAdmin],
    );
    await h.admin.query(
      `UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
      [rows[0]?.id, owner],
    );
    const res = await asMember.post("/v1/workspace/rebuild", { confirm: true });
    expect(res.status).toBe(200);
    const [event] = await audits();
    expect(event?.target).toMatchObject({ legalHold: true });
    const sync = await h.admin.query(`SELECT count(*)::int AS n FROM workspace_sync`);
    expect(sync.rows[0].n).toBe(1);
  });

  it("refuses an offboarded member's sandbox and a member without one", async () => {
    await h.admin.query(
      `UPDATE sandboxes SET state = 'destroyed', retain_until = now() + interval '30 days'`,
    );
    expect((await asMember.post("/v1/workspace/rebuild", { confirm: true })).json.code).toBe(
      "workspace_offboarded",
    );
    expect((await asOther.post("/v1/workspace/rebuild", { confirm: true })).status).toBe(404);
    expect(provider.calls).toEqual([]);
  });

  it("then the next wake starts a new sandbox on a fresh volume", async () => {
    await asMember.post("/v1/workspace/rebuild", { confirm: true });
    await lifecycle().waker.wake({ teamId: team, userId: member });
    expect(provider.calls).toEqual([`discard:${member}`, `wake:${member}`]);
    const after = await row();
    expect(after.state).toBe("running");
    expect(after.sandbox_id).not.toBe(SANDBOX);
  });
});

describe("a finished rebuild can never be discarded again (review g72-2 HIGH)", () => {
  const teamRef = () => ({ id: team, slug: "rebuild" });
  const quiet = pino({ level: "silent" });

  it("passes the discard the recorded claim and the mark time", async () => {
    await asMember.post("/v1/workspace/rebuild", { confirm: true });
    expect(provider.guards[0]).toMatchObject({ claimUid: SANDBOX });
    expect(provider.guards[0]?.notCreatedAfter).toBeInstanceOf(Date);
  });

  it("a late sweep or replica after the reset and a wake deletes nothing", async () => {
    await asMember.post("/v1/workspace/rebuild", { confirm: true });
    await lifecycle().waker.wake({ teamId: team, userId: member });
    const fresh = (await row()).sandbox_id;
    // A sweep that listed the row before the reset now runs: it re-checks under the lock.
    const late = await completeRebuild(h.deps.database.db, provider, teamRef(), member, quiet);
    expect(late).toBe("already");
    expect(provider.calls).toEqual([`discard:${member}`, `wake:${member}`]);
    expect((await row()).sandbox_id).toBe(fresh);
  });

  it("two replicas finishing at once: the second waits for the lock, then finds it done", async () => {
    provider.failDiscard = true;
    await asMember.post("/v1/workspace/rebuild", { confirm: true });
    provider.failDiscard = false;
    let open: () => void = () => undefined;
    provider.gate = new Promise((r) => (open = r));
    const a = completeRebuild(h.deps.database.db, provider, teamRef(), member, quiet);
    await new Promise((r) => setTimeout(r, 100));
    const b = completeRebuild(h.deps.database.db, provider, teamRef(), member, quiet);
    await new Promise((r) => setTimeout(r, 100));
    open();
    expect([await a, await b]).toEqual(["rebuilt", "already"]);
    expect(provider.calls).toEqual([`discard:${member}`]);
  });

  it("a slow cluster times out, releases the lock and leaves the rebuild to retry", async () => {
    provider.failDiscard = true;
    await asMember.post("/v1/workspace/rebuild", { confirm: true });
    provider.failDiscard = false;
    provider.gate = new Promise(() => undefined);
    const out = await completeRebuild(h.deps.database.db, provider, teamRef(), member, quiet, 50);
    expect(out).toBe("pending");
    const marked = await h.admin.query(
      `SELECT rebuild_started_at FROM sandboxes WHERE team_id = $1 AND user_id = $2`,
      [team, member],
    );
    expect(marked.rows[0].rebuild_started_at).not.toBeNull();
  });
});

describe("a discard aims only at the confirmed claim (review g72-3 HIGH)", () => {
  it("a timed-out discard is aborted, so its remaining deletes and retries stop", async () => {
    provider.failDiscard = true;
    await asMember.post("/v1/workspace/rebuild", { confirm: true });
    provider.failDiscard = false;
    provider.gate = new Promise(() => undefined);
    const quiet = pino({ level: "silent" });
    const team_ = { id: team, slug: "rebuild" };
    expect(await completeRebuild(h.deps.database.db, provider, team_, member, quiet, 50)).toBe(
      "pending",
    );
    expect(provider.signals.at(-1)?.aborted).toBe(true);
  });

  it("tells the member the truth when the claim there is not the confirmed one, and audits it", async () => {
    provider.refuse = "replaced";
    const res = await asMember.post("/v1/workspace/rebuild", { confirm: true });
    expect(res).toMatchObject({ status: 409, json: { code: "rebuild_superseded" } });
    expect(res.json.message).toMatch(/Reload/);
    const refused = await h.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log
        WHERE action = 'sandbox.volume_rebuild_refused' AND team_id = $1 AND seq > $2`,
      [team, since],
    );
    expect(refused.rows.map((r) => r.target)).toEqual([{ userId: member, reason: "replaced" }]);
    // Nothing reset: the row keeps the sandbox it has; the mark is gone.
    const r = await h.admin.query(
      `SELECT sandbox_id, rebuild_started_at FROM sandboxes WHERE team_id = $1 AND user_id = $2`,
      [team, member],
    );
    expect(r.rows[0]).toEqual({ sandbox_id: SANDBOX, rebuild_started_at: null });
  });
});

describe("the down-since clock needs continuous observation (review g72-2 MEDIUM)", () => {
  it("ignores a leftover from an old outage: the clock restarts", async () => {
    await h.admin.query(
      `UPDATE sandboxes SET volume_lost_since = now() - interval '2 hours',
                            volume_lost_seen_at = now() - interval '1 hour'`,
    );
    provider.health = NODE_DOWN;
    expect((await freshStatus()).json).toMatchObject({ volume: "unreachable", rebuildable: false });
    const since = await lostSince();
    expect(Date.now() - (since?.getTime() ?? 0)).toBeLessThan(60_000);
  });

  it("the sweep clears it when the node is back (a flap starts over)", async () => {
    await h.admin.query(
      `UPDATE sandboxes SET volume_lost_since = now() - interval '31 minutes',
                            volume_lost_seen_at = now()`,
    );
    provider.health = { state: "present" };
    await lifecycle().sweep();
    expect(await lostSince()).toBeNull();
    provider.health = NODE_DOWN;
    expect((await freshStatus()).json).toMatchObject({ volume: "unreachable" });
  });

  it("the sweep keeps a node that stays down continuous, so it counts after the grace", async () => {
    await h.admin.query(
      `UPDATE sandboxes SET volume_lost_since = now() - interval '31 minutes',
                            volume_lost_seen_at = now() - interval '9 minutes'`,
    );
    provider.health = NODE_DOWN;
    await lifecycle().sweep();
    expect((await freshStatus()).json).toMatchObject({ volume: "lost", rebuildable: true });
  });
});

describe("a team admin for a member", () => {
  it("sees the same status and rebuilds, audited with the admin as actor", async () => {
    const status = await asOwner.get(`/v1/team/workspaces/${member}/rebuild`);
    expect(status.json).toMatchObject({ volume: "lost", rebuildable: true });
    const res = await asOwner.post(`/v1/team/workspaces/${member}/rebuild`, { confirm: true });
    expect(res.json.status).toBe("rebuilt");
    const [event] = await audits();
    expect(event).toMatchObject({ actor_id: owner, target: { userId: member, byAdmin: true } });
  });

  it("is for team admins only", async () => {
    expect((await asOther.get(`/v1/team/workspaces/${member}/rebuild`)).status).toBe(403);
    const res = await asOther.post(`/v1/team/workspaces/${member}/rebuild`, { confirm: true });
    expect(res.status).toBe(403);
    expect((await asOwner.get(`/v1/team/workspaces/not-a-uuid/rebuild`)).status).toBe(400);
    expect(provider.calls).toEqual([]);
  });
});

describe("status reads are rate limited per caller", () => {
  it("answers 429 after a burst", async () => {
    const answers = [];
    for (let i = 0; i < 30; i++) answers.push((await asOther.get("/v1/workspace/rebuild")).status);
    expect(answers).toContain(429);
  });
});
