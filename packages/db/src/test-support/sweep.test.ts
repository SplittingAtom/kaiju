import { mkdirSync, mkdtempSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STALE_TEST_DATABASE_AGE_MS,
  selectStaleTestDatabases,
  sweepStaleTempDirs,
  type TestDatabaseCandidate,
} from "./sweep.js";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const DAY = STALE_TEST_DATABASE_AGE_MS;
const at = (msAgo: number) => new Date(NOW - msAgo);
const db = (name: string, msAgo: number | null, connections = 0): TestDatabaseCandidate => ({
  name,
  createdAt: msAgo === null ? null : at(msAgo),
  connections,
});

describe("selectStaleTestDatabases (KOBE-743)", () => {
  it("selects throwaway databases older than a day with no sessions, oldest first", () => {
    expect(
      selectStaleTestDatabases(
        [
          db("kaiju_test_0a1b2c3d", DAY + 1),
          db("kaiju_up_0a1b2c3d_wt7", 3 * DAY),
          db("kaiju_test_ffffffff_g60", 2 * DAY),
        ],
        { now: NOW },
      ),
    ).toEqual(["kaiju_up_0a1b2c3d_wt7", "kaiju_test_ffffffff_g60", "kaiju_test_0a1b2c3d"]);
  });

  it("also selects the names used before the repository rename (KOBE-752)", () => {
    expect(
      selectStaleTestDatabases(
        [
          db("kobe_test_0a1b2c3d", DAY + 1),
          db("kobe_up_0a1b2c3d_wt7", 3 * DAY),
          db("kaiju_test_ffffffff_g60", 2 * DAY),
        ],
        { now: NOW },
      ),
    ).toEqual(["kobe_up_0a1b2c3d_wt7", "kaiju_test_ffffffff_g60", "kobe_test_0a1b2c3d"]);
  });

  it("never selects a database that is young, in use, or of unknown age", () => {
    expect(
      selectStaleTestDatabases(
        [
          db("kaiju_test_0a1b2c3d", DAY - 1),
          db("kaiju_test_0a1b2c3e", DAY),
          db("kaiju_test_0a1b2c3f", 10 * DAY, 1),
          db("kobe_test_0a1b2c30", null),
        ],
        { now: NOW },
      ),
    ).toEqual([]);
  });

  it("never selects another name, however old and idle", () => {
    const names = [
      "postgres",
      "kaiju",
      "kobe",
      "kaiju_lane_wt7",
      "kobe_lane_wt7",
      "kaiju_proto33",
      "rev33",
      "kaiju_test_",
      "kaiju_test_0a1b2c3",
      "kaiju_test_0A1B2C3D",
      "kaiju_test_0a1b2c3d_",
      "kaiju_test_0a1b2c3d_WT7",
      "kaiju_test_0a1b2c3d_wt7_x",
      "kaiju_test_0a1b2c3d; DROP DATABASE postgres",
      "kaiju_owner_0a1b2c3d",
      "kaiju_up_owner_0a1b2c3d",
      "kobe_owner_0a1b2c3d",
      "xkaiju_test_0a1b2c3d",
      "xkobe_test_0a1b2c3d",
      "kaijukobe_test_0a1b2c3d",
      "kaiju_test_0a1b2c3d_aaaaaaaaaaaaaaaaaaaaa",
    ];
    expect(
      selectStaleTestDatabases(
        names.map((n) => db(n, 100 * DAY)),
        { now: NOW },
      ),
    ).toEqual([]);
  });

  it("caps the drops per sweep", () => {
    const many = Array.from({ length: 5 }, (_, i) => db(`kaiju_test_0000000${i}`, (10 - i) * DAY));
    expect(selectStaleTestDatabases(many, { now: NOW, limit: 2 })).toEqual([
      "kaiju_test_00000000",
      "kaiju_test_00000001",
    ]);
  });
});

describe("sweepStaleTempDirs (KOBE-743)", () => {
  it("removes only prefixed directories older than the age", () => {
    const root = mkdtempSync(join(tmpdir(), "kaiju-sweep-test-"));
    const old = join(root, "kaiju-upgrade-old");
    const fresh = join(root, "kaiju-upgrade-fresh");
    const other = join(root, "kaiju-runner-old");
    const file = join(root, "kaiju-upgrade-file");
    for (const d of [old, fresh, other]) mkdirSync(d);
    writeFileSync(join(old, "x.sql"), "SELECT 1;");
    writeFileSync(file, "");
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    for (const p of [old, other, file]) utimesSync(p, twoHoursAgo, twoHoursAgo);

    expect(sweepStaleTempDirs({ dir: root })).toEqual([old]);
    expect(existsSync(old)).toBe(false);
    expect([fresh, other, file].every((p) => existsSync(p))).toBe(true);
    expect(sweepStaleTempDirs({ dir: join(root, "missing") })).toEqual([]);
  });
});
