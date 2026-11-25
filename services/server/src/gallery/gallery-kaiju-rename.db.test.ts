import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GALLERY_DEFINITIONS, KAIJU_GALLERY_KEY, type GalleryDefinition } from "./definitions.js";
import { seedGalleryAgents } from "./seed.js";
import type { TestBrowser, TestResponse } from "../testing/browser.js";
import { openHarness, type Harness } from "../testing/harness.js";

/**
 * KOBE-831 (rename step RN-18, owner decision A13): the gallery agent "Kobe" becomes "Kaiju" by
 * raising its generation to 5. Migration 0262 has already moved its key to `kaiju` (same row), so
 * this starts from that state: the generation-4 definition under the new key. The seed renames it
 * only where a site admin has not customized it (ac-2); its id, earlier versions, forks
 * (`forkedFrom`), threads and the team default that point at it keep working (ac-3: every reference
 * to an agent is by id, so nothing a member bookmarked or a schedule stored changes).
 */
type Person = "admin" | "bob";
const ids = {} as Record<Person, string>;
const as = {} as Record<Person, TestBrowser>;
const team = randomUUID();
let h: Harness;

const BASE = "/v1/site/gallery/agents";
const ANY = { "if-match": "*" };
const json = (res: TestResponse) => JSON.stringify(res.json);

/** The shipped generation-4 definition as far as these checks read it (name and prompt). */
const KOBE_GEN4: GalleryDefinition = {
  key: KAIJU_GALLERY_KEY,
  generation: 4,
  file: "---\nname: Kobe\ndescription: One agent for everyday work.\nconnectors: all\n---\nYou are Kobe, the team's general-purpose assistant.\n",
};

const seed = (definitions: readonly GalleryDefinition[] = GALLERY_DEFINITIONS) =>
  seedGalleryAgents(h.deps.database.db, definitions);

const versions = async (agentId: string) =>
  (
    await h.admin.query<{ version: number; name: string; prompt: string }>(
      `SELECT version, frontmatter->>'name' AS name, prompt FROM site_agent_versions
        WHERE agent_id = $1 ORDER BY version`,
      [agentId],
    )
  ).rows;

let agentId = "";

beforeAll(async () => {
  h = await openHarness();
  ids.admin = await h.createUser("admin@gallery-rename.test", "admin");
  ids.bob = await h.createUser("bob@gallery-rename.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'gr-team', 'GR Team')`, [
    team,
  ]);
  for (const [who, role] of [
    ["admin", "team_admin"],
    ["bob", "contributor"],
  ] as const) {
    await h.admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      team,
      ids[who],
      role,
    ]);
    as[who] = await h.signIn(`${who}@gallery-rename.test`);
    expect((await as[who].put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    as[who].team = team;
  }
  const [seeded] = await seed([KOBE_GEN4]);
  agentId = seeded?.agentId ?? "";
  expect(agentId).not.toBe("");
});

afterAll(async () => {
  await h?.close();
});

describe("the gallery agent renamed where an install has not changed it (KOBE-831)", () => {
  let forkId = "";
  let threadId = "";

  it("ac-2: an unchanged agent is republished as Kaiju; history, forks and links stay", async () => {
    // Before the upgrade: a member's fork, a thread with the agent and the team default.
    const fork = await as.bob.post(`/v1/agents/${agentId}/fork`, {});
    expect(fork.status, json(fork)).toBe(201);
    forkId = fork.json.agent.id as string;
    expect(fork.json.agent).toMatchObject({ forkedFrom: { agentId, version: 1 } });
    const thread = await as.bob.post("/v1/threads", { agent_id: agentId });
    expect(thread.status, json(thread)).toBe(201);
    threadId = thread.json.thread_id as string;
    const def = await as.admin.put("/v1/team/default-agent", { agentId });
    expect(def.status, json(def)).toBe(200);

    expect(await seed()).toEqual([
      expect.objectContaining({ key: KAIJU_GALLERY_KEY, agentId, action: "updated" }),
    ]);
    const all = await versions(agentId);
    expect(all.map((v) => [v.version, v.name])).toEqual([
      [1, "Kobe"],
      [2, "Kaiju"],
    ]);
    expect(all[0]?.prompt).toBe("You are Kobe, the team's general-purpose assistant.");
    expect(all[1]?.prompt).toMatch(/^You are Kaiju, the team's general-purpose assistant\./);

    // ac-3: the same id everywhere; the old version is still there for whatever pinned it.
    const one = await as.admin.get(`${BASE}/${agentId}`);
    expect(one.status, json(one)).toBe(200);
    expect(one.json.agent).toMatchObject({
      name: "Kaiju",
      slug: KAIJU_GALLERY_KEY,
      currentVersion: 2,
      gallery: { customized: false, generation: 5, updateAvailable: false },
    });
    const history = await as.admin.get(`${BASE}/${agentId}/versions`);
    expect(history.json.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const forked = await as.bob.get(`/v1/agents/${forkId}`);
    expect(forked.status, json(forked)).toBe(200);
    // The member's copy is theirs: its own name, and its lineage to the gallery agent kept.
    expect(forked.json.agent).toMatchObject({
      name: "Kobe",
      forkedFrom: { agentId, version: 1 },
    });
    const read = await as.bob.get(`/v1/threads/${threadId}`);
    expect(read.json).toMatchObject({ agent_id: agentId, agent_name: "Kaiju" });
    expect((await as.bob.get("/v1/team/default-agent")).json).toMatchObject({ agentId });
    const runnable = await as.bob.get("/v1/agents/runnable");
    const listed = (runnable.json.agents as { id: string; name: string; default?: boolean }[]).find(
      (a) => a.id === agentId,
    );
    expect(listed).toMatchObject({ name: "Kaiju" });

    // A restart (or an older replica) changes nothing more.
    expect((await seed())[0]?.action).toBe("unchanged");
    expect((await seed([KOBE_GEN4]))[0]?.action).toBe("unchanged");
    expect((await versions(agentId)).length).toBe(2);
  });

  it("ac-2: a customized agent keeps its name; the update is offered, never applied", async () => {
    // A site admin's edit, as on an install still on generation 4 (the seed has not run yet).
    const edit = {
      frontmatter: { name: "Kobe", description: "Our own" },
      prompt: "You are Kobe, edited for us.",
    };
    const saved = await as.admin.put(`${BASE}/${agentId}`, edit, ANY);
    expect(saved.status, json(saved)).toBe(200);
    const published = await as.admin.request("POST", `${BASE}/${agentId}/publish`, {}, ANY);
    expect(published.status, json(published)).toBe(201);
    await h.admin.query(
      `UPDATE site_agents SET gallery_generation = 4, customized_from_generation = 4 WHERE id = $1`,
      [agentId],
    );

    expect((await seed())[0]).toMatchObject({ agentId, action: "skipped_customized" });
    expect((await versions(agentId)).map((v) => [v.version, v.name])).toEqual([
      [1, "Kobe"],
      [2, "Kaiju"],
      [3, "Kobe"],
    ]);
    const one = await as.admin.get(`${BASE}/${agentId}`);
    expect(one.json.agent).toMatchObject({
      name: "Kobe",
      prompt: "You are Kobe, edited for us.",
      gallery: { customized: true, generation: 5, customizedFromGeneration: 4 },
    });
    expect(one.json.agent.gallery.updateAvailable).toBe(true);
    // The fork still names the version it came from.
    expect((await as.bob.get(`/v1/agents/${forkId}`)).json.agent).toMatchObject({
      forkedFrom: { agentId, version: 1 },
    });

    // Reset to repository is the admin's choice: then it is Kaiju.
    const reset = await as.admin.post(`${BASE}/${agentId}/reset`);
    expect(reset.status, json(reset)).toBe(200);
    expect(reset.json.agent).toMatchObject({ name: "Kaiju", gallery: { customized: false } });
  });

  it("refuses the pre-rename key, so an older pod cannot seed a second gallery agent", async () => {
    const older = await seed([{ ...KOBE_GEN4, key: "kobe" }]);
    expect(older.find((r) => r.key === "kobe")?.action).toBe("failed");
    const keys = await h.admin.query<{ gallery_key: string }>(
      `SELECT gallery_key FROM site_agents WHERE scope = 'gallery' AND archived_at IS NULL`,
    );
    expect(keys.rows).toEqual([{ gallery_key: KAIJU_GALLERY_KEY }]);
  });
});
