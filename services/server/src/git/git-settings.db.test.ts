import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitTeamSettingsSchema } from "@kobe/protocol";
import { gitCommitEmailMode, gitNoReplyEmail } from "./sandbox-git.js";
import { EventStreamFixture, type Person } from "../testing/event-stream-fixture.js";

/**
 * KOBE-761: the Workspace's git settings (`/v1/team/git/settings`, `team.git.manage`): the commit
 * author email that KOBE-764 writes into sandbox commits. Permission matrix, cross-Workspace
 * isolation, the audit row with old and new value (once per change), validation, and that the
 * run-start reader sees what the route stored.
 */
const PATH = "/v1/team/git/settings";
const short = () => randomUUID().slice(0, 8);
const fx = new EventStreamFixture();

beforeAll(async () => {
  await fx.setup([{}]);
}, 120_000);
afterAll(async () => {
  await fx.teardown();
});

interface World {
  readonly team: string;
  readonly admin: Person;
  readonly member: Person;
  readonly contributor: Person;
}

async function world(): Promise<World> {
  const admin = await fx.person(`sa${short()}`);
  const member = await fx.person(`sm${short()}`);
  const contributor = await fx.person(`sc${short()}`);
  const team = await fx.team(`gs-${short()}`, admin, [member, contributor]);
  await fx.admin.query(
    `UPDATE team_members SET role = 'contributor' WHERE team_id = $1 AND user_id = $2`,
    [team, contributor.id],
  );
  return { team, admin, member, contributor };
}

async function stored(team: string): Promise<unknown> {
  const { rows } = await fx.admin.query<{ settings: unknown }>(
    `SELECT settings FROM teams WHERE id = $1`,
    [team],
  );
  return rows[0]?.settings;
}

async function audits(team: string) {
  const { rows } = await fx.admin.query<{ target: Record<string, unknown>; actor_id: string }>(
    `SELECT target, actor_id FROM audit_log WHERE team_id = $1 AND action = 'git.settings.updated'
      ORDER BY seq`,
    [team],
  );
  return rows;
}

describe("Workspace git settings (KOBE-761)", () => {
  it("defaults to the member's email and answers the caller's no-reply example", async () => {
    const w = await world();
    const res = await w.admin.browser.request("GET", PATH);
    expect(res.status, res.text).toBe(200);
    const body = gitTeamSettingsSchema.parse(res.json);
    expect(body.commit_email).toBe("member");
    const name = (
      await fx.admin.query<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [w.admin.id])
    ).rows[0]?.name;
    expect(body.noreply_example).toBe(
      gitNoReplyEmail({ id: w.admin.id, name: name ?? "" }, "kobe.test"),
    );
    expect(body.noreply_example).toMatch(/^[0-9a-f]{10}\+[a-z0-9-]+@users\.noreply\.kobe\.test$/);
    expect(body.noreply_example).not.toContain(w.admin.id);
  });

  it("stores the choice where run starts read it, audits old and new once, ignores a no-op", async () => {
    const w = await world();
    const set = await w.admin.browser.request("PATCH", PATH, { commit_email: "noreply" });
    expect(set.status, set.text).toBe(200);
    expect(set.json.commit_email).toBe("noreply");
    expect(gitCommitEmailMode(await stored(w.team))).toBe("noreply");
    await w.admin.browser.request("PATCH", PATH, { commit_email: "noreply" });
    await w.admin.browser.request("PATCH", PATH, { commit_email: "member" });
    expect(gitCommitEmailMode(await stored(w.team))).toBe("member");
    const rows = await audits(w.team);
    expect(rows.map((r) => r.target)).toEqual([
      { setting: "commit_email", value: "noreply", previous: "member" },
      { setting: "commit_email", value: "member", previous: "noreply" },
    ]);
    expect(rows.every((r) => r.actor_id === w.admin.id)).toBe(true);
  });

  it("keeps the Workspace's other settings", async () => {
    const w = await world();
    await fx.admin.query(
      `UPDATE teams SET settings = '{"sandbox_idle_minutes": 20}'::jsonb WHERE id = $1`,
      [w.team],
    );
    await w.admin.browser.request("PATCH", PATH, { commit_email: "noreply" });
    expect(await stored(w.team)).toEqual({ sandbox_idle_minutes: 20, git_commit_email: "noreply" });
  });

  it("refuses anything but member or noreply, without echoing", async () => {
    const w = await world();
    for (const body of [
      { commit_email: "x@evil.test" },
      {},
      { commit_email: "member", extra: 1 },
    ]) {
      const res = await w.admin.browser.request("PATCH", PATH, body);
      expect(res.status).toBe(400);
      expect(res.text).not.toContain("evil.test");
    }
    expect(await audits(w.team)).toEqual([]);
  });

  it("members and contributors can neither read nor change it", async () => {
    const w = await world();
    for (const p of [w.member, w.contributor]) {
      expect((await p.browser.request("GET", PATH)).status).toBe(403);
      expect((await p.browser.request("PATCH", PATH, { commit_email: "noreply" })).status).toBe(
        403,
      );
    }
    expect(gitCommitEmailMode(await stored(w.team))).toBe("member");
  });

  it("a Site admin without membership gets nothing; another Workspace's admin changes only theirs", async () => {
    const w = await world();
    const other = await world();
    const siteAdmin = await fx.person(`ss${short()}`);
    await fx.admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [
      siteAdmin.id,
    ]);
    siteAdmin.browser.team = w.team;
    expect((await siteAdmin.browser.request("GET", PATH)).status).toBeGreaterThanOrEqual(400);
    expect(
      (await siteAdmin.browser.request("PATCH", PATH, { commit_email: "noreply" })).status,
    ).toBeGreaterThanOrEqual(400);
    // The other admin naming this Workspace is refused; in their own, only theirs changes.
    other.admin.browser.team = w.team;
    expect(
      (await other.admin.browser.request("PATCH", PATH, { commit_email: "noreply" })).status,
    ).toBeGreaterThanOrEqual(400);
    other.admin.browser.team = other.team;
    expect(
      (await other.admin.browser.request("PATCH", PATH, { commit_email: "noreply" })).status,
    ).toBe(200);
    expect(gitCommitEmailMode(await stored(other.team))).toBe("noreply");
    expect(gitCommitEmailMode(await stored(w.team))).toBe("member");
    expect(await audits(w.team)).toEqual([]);
  });
});
