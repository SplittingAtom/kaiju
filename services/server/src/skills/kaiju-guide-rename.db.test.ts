import { createHash, randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadKaijuPackages } from "./kaiju-packages.js";
import { catalogObjectKey, seedKaijuSkills } from "./kaiju-seed.js";
import { currentSkillNames, namesResolvingTo } from "./renamed-skills.js";
import type { Person } from "../testing/event-stream-fixture.js";
import { MemoryObjects } from "../testing/memory-objects.js";
import { RunFixture, type RunWorld } from "../testing/run-fixture.js";

/**
 * KOBE-833 (RN-20) after the upgrade: migration 0263 renamed Kaiju's `kobe-guide` catalog skill to
 * `kaiju-guide` in place, with its version 1.0.0 and the teams' installs. The seed then publishes
 * `kaiju-guide` 1.1.0 into that skill (ac-1): an install tracking within the major runs it, an
 * install a team admin pinned to 1.0.0 keeps 1.0.0 (the normal version rule), and an agent that
 * still names `kobe-guide` gets the skill (`currentSkillNames`), unless a catalog skill holds that
 * old name.
 */
const objects = new MemoryObjects();
const blobs = { objects, prefix: "kaiju/" };
const f = new RunFixture();
const ANY = { "if-match": "*" };
const quiet = { info() {}, warn() {}, error() {} };
const unique = () => randomUUID().slice(0, 8);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Version 1.0.0's runtime bytes as a pre-rename release published them (stand-in content). */
const OLD_RUNTIME = zipSync({
  "SKILL.md": strToU8(
    `---\nname: kobe-guide\ndescription: "The guide before the rename."\n---\n# Guide\n`,
  ),
});
const OLD_HASH = sha(OLD_RUNTIME);

let tracking: RunWorld;
let pinned: RunWorld;
let skillId = "";

async function threadNaming(p: Person, skills: string[]) {
  const b = f.on(0, p);
  const created = await b.post("/v1/agents", {
    scope: "team",
    frontmatter: { name: `A ${unique()}`, skills },
    prompt: "You use skills.",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  expect((await b.request("POST", `/v1/agents/${id}/publish`, {}, ANY)).status).toBe(201);
  const thread = await b.post("/v1/threads", { agent_id: id });
  expect(thread.status, JSON.stringify(thread.json)).toBe(201);
  return thread.json.thread_id as string;
}

async function startOf(w: RunWorld, thread: string) {
  const ws = await f.connect(w, 0);
  const run = await f.message(w.owner, thread, "hello");
  const start = await ws.started(run);
  ws.reply(start, "ok");
  await f.until(w.team, run, "completed");
  ws.kill();
  return start.config ?? {};
}

beforeAll(async () => {
  await f.setup({ blobs });
  tracking = await f.world();
  pinned = await f.world();
  // The site as migration 0263 leaves it: Kaiju's skill renamed, holding its old version, with a
  // Default install tracking the major and one a team admin pinned.
  const key = catalogObjectKey(blobs.prefix, OLD_HASH);
  objects.objects.set(key, Buffer.from(OLD_RUNTIME));
  const skill = await f.fx.admin.query<{ id: string }>(
    `INSERT INTO registry_skills (name, summary, publisher)
     VALUES ('kaiju-guide', 'The guide.', 'kaiju') RETURNING id`,
  );
  skillId = skill.rows[0]?.id as string;
  const version = await f.fx.admin.query<{ id: string }>(
    `INSERT INTO registry_versions (skill_id, publisher, semver, seq, runtime_hash, package_hash,
       runtime_storage_key, runtime_size_bytes, manifest, provenance, source, scan, verdict, state,
       submitted_at, approved_at)
     VALUES ($1, 'kaiju', '1.0.0', 1, $2, repeat('b', 64), $3, $4, '{"name":"kobe-guide"}', '{}',
             '{"publisher":"kaiju"}', '{}', 'pass', 'approved', now(), now()) RETURNING id`,
    [skillId, OLD_HASH, key, OLD_RUNTIME.length],
  );
  const versionId = version.rows[0]?.id as string;
  await f.fx.admin.query(
    `INSERT INTO registry_skill_tags (skill_id, tag_id, by_kobe)
     SELECT $1, id, true FROM registry_tags WHERE name = 'default'`,
    [skillId],
  );
  await f.fx.admin.query(
    `INSERT INTO team_skill_installs (team_id, skill_id, version_id, pin_mode, access, origin,
       installed_by, by_kobe, team_changed_at)
     VALUES ($1, $3, $4, 'within_major', 'default_on', 'default_tag', NULL, true, NULL),
            ($2, $3, $4, 'pinned', 'default_on', 'default_tag', $5, false, now())`,
    [tracking.team, pinned.team, skillId, versionId, pinned.owner.id],
  );
}, 120_000);

afterAll(async () => {
  await f.teardown();
});

describe("kaiju-guide after the rename (KOBE-833)", () => {
  it("the seed publishes 1.1.0 into the renamed skill, which keeps 1.0.0", async () => {
    const results = await seedKaijuSkills({ db: f.fx.db, blobs, log: quiet });
    expect(results.find((r) => r.name === "kaiju-guide")).toEqual({
      name: "kaiju-guide",
      semver: "1.1.0",
      action: "published",
    });
    const { rows } = await f.fx.admin.query(
      `SELECT s.id, v.semver FROM registry_skills s JOIN registry_versions v ON v.skill_id = s.id
        WHERE s.name IN ('kaiju-guide', 'kobe-guide') ORDER BY v.seq`,
    );
    expect(rows).toEqual([
      { id: skillId, semver: "1.0.0" },
      { id: skillId, semver: "1.1.0" },
    ]);
  });

  it("an agent naming kobe-guide gets kaiju-guide 1.1.0 where the install tracks the major", async () => {
    const guide = (await loadKaijuPackages()).find((p) => p.name === "kaiju-guide");
    const config = await startOf(tracking, await threadNaming(tracking.owner, ["kobe-guide"]));
    expect(config.skills).toContain("kaiju-guide");
    expect(config.skills).not.toContain("kobe-guide");
    expect(config.skill_bundles?.find((b) => b.name === "kaiju-guide")?.sha256).toBe(
      sha(guide?.bundle.zip ?? new Uint8Array()),
    );
  });

  it("an install pinned to 1.0.0 keeps 1.0.0, under either name", async () => {
    for (const name of ["kaiju-guide", "kobe-guide"]) {
      const config = await startOf(pinned, await threadNaming(pinned.owner, [name]));
      expect(config.skill_bundles?.filter((b) => b.name === "kaiju-guide")).toEqual([
        expect.objectContaining({ sha256: OLD_HASH }),
      ]);
    }
  });

  it("reads kobe-guide as kaiju-guide only while no catalog skill holds kobe-guide", async () => {
    const read = () =>
      f.fx.db.transaction(async (tx) => ({
        current: await currentSkillNames(tx, ["pdf", "kobe-guide", "kaiju-guide", "pdf"]),
        names: await namesResolvingTo(tx, "kaiju-guide"),
      }));
    expect(await read()).toEqual({
      current: ["pdf", "kaiju-guide"],
      names: ["kaiju-guide", "kobe-guide"],
    });
    // A maintainer's skill that held the name before Kaiju took it (KOBE-620) keeps it.
    await f.fx.admin.query(
      `INSERT INTO registry_skills (name, summary) VALUES ('kobe-guide', 'A maintainer''s.')`,
    );
    expect(await read()).toEqual({
      current: ["pdf", "kobe-guide", "kaiju-guide"],
      names: ["kaiju-guide"],
    });
    await f.fx.admin.query(`DELETE FROM registry_skills WHERE name = 'kobe-guide'`);
  });
});
