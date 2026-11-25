import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KAIJU_PACKAGES_DIR, readKaijuPackage } from "./kaiju-packages.js";
import { seedKaijuSkills } from "./kaiju-seed.js";
import { MemoryObjects } from "../testing/memory-objects.js";
import { RunFixture } from "../testing/run-fixture.js";

/**
 * KOBE-620: a Site whose catalog already has a non-Kaiju skill named `kobe-guide` (migration 0208
 * lets it keep the name) gets no Kaiju `kobe-guide`: the seed skips it with a warning, never fails
 * (so server starts don't retry it), and the other Kaiju skills publish as usual.
 */
const objects = new MemoryObjects();
const blobs = { objects, prefix: "kaiju/" };
const f = new RunFixture();
const warnings: string[] = [];
const log = {
  info() {},
  error() {},
  warn: ((_o: unknown, msg?: string) => {
    warnings.push(msg ?? "");
  }) as never,
};

beforeAll(async () => {
  await f.setup({ blobs });
  await f.fx.admin.query(
    `INSERT INTO registry_skills (name, summary) VALUES ('kobe-guide', 'A maintainer''s guide.')`,
  );
});

afterAll(async () => {
  await f.teardown();
});

describe("kobe-guide name already taken (KOBE-620)", () => {
  it("skips Kaiju's kobe-guide with a warning and publishes the others", async () => {
    const packages = [
      await readKaijuPackage(KAIJU_PACKAGES_DIR, "kobe-guide"),
      await readKaijuPackage(KAIJU_PACKAGES_DIR, "charts"),
    ];
    const results = await seedKaijuSkills({ db: f.fx.db, blobs, log, packages });
    expect(results.map((r) => [r.name, r.action])).toEqual([
      ["kobe-guide", "skipped_name_taken"],
      ["charts", "created"],
    ]);
    expect(warnings.some((w) => /kobe-guide|name is taken/.test(w))).toBe(true);
    const again = await seedKaijuSkills({ db: f.fx.db, blobs, log, packages });
    expect(again.map((r) => r.action)).toEqual(["skipped_name_taken", "unchanged"]);
    const rows = await f.fx.admin.query<{ name: string; publisher: string; versions: number }>(
      `SELECT s.name, s.publisher::text,
              (SELECT count(*)::int FROM registry_versions v WHERE v.skill_id = s.id) AS versions
         FROM registry_skills s WHERE s.name IN ('kobe-guide', 'charts') ORDER BY s.name`,
    );
    expect(rows.rows).toEqual([
      { name: "charts", publisher: "kaiju", versions: 1 },
      { name: "kobe-guide", publisher: "maintainer", versions: 0 },
    ]);
  });
});
