import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE,
  MAX_GENERATED_NAME,
  alreadyOnBase,
  branchOnlyEntries,
  handWrittenBaseProblem,
  parseRebaseArgs,
  isHandWritten,
  rechainSnapshot,
  regenerationSteps,
} from "./migration-plan.mjs";

const schema = (tables) => ({ version: "7", dialect: "postgresql", tables, enums: {} });
const snap = (id, prevId, tables) => ({ id, prevId, ...schema(tables) });

describe("db:rebase plan for hand-written migrations (KOBE-256)", () => {
  it("recognises the first-line marker only", () => {
    expect(isHandWritten("-- kobe:hand-written\nALTER TABLE a RENAME TO b;")).toBe(true);
    expect(isHandWritten("ALTER TABLE a RENAME TO b;\n-- kobe:hand-written")).toBe(false);
    expect(isHandWritten("-- Custom SQL migration file")).toBe(false);
  });

  it("re-creates hand-written and custom migrations in order with their SQL; keeps the snapshot", () => {
    const kept = snap("old", "older", { site_settings: {} });
    const steps = regenerationSteps([
      {
        name: "site_rename",
        sql: "-- kobe:hand-written\n...",
        handWritten: true,
        custom: false,
        snapshot: kept,
      },
      { name: "site_rls", sql: "CREATE POLICY ...", handWritten: false, custom: true },
    ]);
    expect(steps).toEqual([
      {
        kind: "hand-written",
        name: "site_rename",
        sql: "-- kobe:hand-written\n...",
        snapshot: kept,
      },
      { kind: "custom", name: "site_rls", sql: "CREATE POLICY ..." },
    ]);
  });

  it("generates the generated ones first when there is no hand-written one", () => {
    const steps = regenerationSteps([
      { name: "a", sql: "CREATE TABLE a", handWritten: false, custom: false },
      { name: "a_rls", sql: "ALTER TABLE a ENABLE", handWritten: false, custom: true },
      { name: "b", sql: "CREATE TABLE b", handWritten: false, custom: false },
    ]);
    expect(steps.map((s) => [s.kind, s.name])).toEqual([
      ["generate", "a_b"],
      ["custom", "a_rls"],
    ]);
  });

  it("refuses hand-written together with generated migrations (drizzle-kit would diff the renames)", () => {
    expect(() =>
      regenerationSteps([
        { name: "site_rename", sql: "-- kobe:hand-written", handWritten: true, custom: false },
        { name: "b", sql: "CREATE TABLE b", handWritten: false, custom: false },
      ]),
    ).toThrow(/cannot be regenerated together/);
  });

  it("keeps a snapshot only when the base did not change the schema since the fork", () => {
    const hand = [{ name: "site_rename", handWritten: true, custom: false, sql: "" }];
    const fork = snap("f", "e", { old_settings: {} });
    expect(handWrittenBaseProblem(hand, fork, { ...fork, id: "g", prevId: "f" })).toBeNull();
    expect(handWrittenBaseProblem(hand, fork, snap("g", "f", { old_settings: {}, x: {} }))).toMatch(
      /renumber it by hand/,
    );
    expect(handWrittenBaseProblem([], fork, snap("g", "f", { x: {} }))).toBeNull();
  });

  it("re-chains a kept snapshot without touching its schema", () => {
    const kept = snap("old", "older", { site_settings: { columns: {} } });
    expect(rechainSnapshot(kept, { id: "new", prevId: "base-last" })).toEqual({
      ...kept,
      id: "new",
      prevId: "base-last",
    });
  });
});

describe("db:rebase names the regenerated migration", () => {
  it("joins a few names, and keeps a long list's name short enough for a file name", () => {
    const gen = (name) => ({ name, sql: "", handWritten: false, custom: false });
    expect(regenerationSteps([gen("a"), gen("b")])).toEqual([{ kind: "generate", name: "a_b" }]);
    const many = Array.from({ length: 20 }, (_, i) => gen(`a_rather_long_migration_name_${i}`));
    const [step] = regenerationSteps(many);
    expect(step.name.length).toBeLessThanOrEqual(MAX_GENERATED_NAME);
    expect(step.name).toBe("a_rather_long_migration_name_0_and_19_more");
  });
});

describe("db:rebase base ref (KOBE-815)", () => {
  it("defaults to origin/main, as before", () => {
    expect(DEFAULT_BASE).toBe("origin/main");
    expect(parseRebaseArgs([], {})).toEqual({ apply: false, base: "origin/main" });
  });

  it("takes the base from --base, --base=, a positional ref or KAIJU_DB_REBASE_BASE, in that order", () => {
    const env = { KAIJU_DB_REBASE_BASE: "origin/from-env" };
    expect(parseRebaseArgs(["--base", "origin/stack"], env).base).toBe("origin/stack");
    expect(parseRebaseArgs(["--base=group-88"], env).base).toBe("group-88");
    expect(parseRebaseArgs(["origin/positional"], env).base).toBe("origin/positional");
    expect(parseRebaseArgs([], env).base).toBe("origin/from-env");
    expect(parseRebaseArgs([], { KAIJU_DB_REBASE_BASE: "" }).base).toBe("origin/main");
  });

  it("--apply takes no base (the stash names it) and unknown or empty arguments are refused", () => {
    expect(parseRebaseArgs(["--apply"], { KAIJU_DB_REBASE_BASE: "x" })).toEqual({
      apply: true,
      base: null,
    });
    expect(() => parseRebaseArgs(["--apply", "--base", "x"], {})).toThrow(/--apply/);
    expect(() => parseRebaseArgs(["--base"], {})).toThrow(/--base/);
    expect(() => parseRebaseArgs(["--base="], {})).toThrow(/--base/);
    expect(() => parseRebaseArgs(["--bogus"], {})).toThrow(/unknown/);
    expect(() => parseRebaseArgs(["a", "b"], {})).toThrow(/one base/);
  });
});

describe("db:rebase picks the branch's own migrations (KOBE-815)", () => {
  const e = (...tags) => tags.map((tag, idx) => ({ idx, tag }));

  it("on a branch off main: the entries main does not have (unchanged behaviour)", () => {
    const fork = e("0000_a", "0001_b");
    const main = e("0000_a", "0001_b", "0002_main");
    const head = e("0000_a", "0001_b", "0002_mine");
    expect(branchOnlyEntries(head, main, fork).map((x) => x.tag)).toEqual(["0002_mine"]);
  });

  it("stacked on a branch that was regenerated since: the old copies of its migrations are not ours", () => {
    // C forked from B when B had 0002_b; B was then brought onto main and regenerated as 0003_b.
    const fork = e("0000_a", "0001_b0", "0002_b");
    const base = e("0000_a", "0001_b0", "0002_main", "0003_b");
    const head = e("0000_a", "0001_b0", "0002_b", "0003_c");
    expect(branchOnlyEntries(head, base, fork).map((x) => x.tag)).toEqual(["0003_c"]);
  });

  it("nothing of our own: an empty list", () => {
    const base = e("0000_a", "0001_b");
    expect(branchOnlyEntries(e("0000_a"), base, e("0000_a"))).toEqual([]);
  });
});

describe("db:rebase refuses migrations the base already has (KOBE-815, stacking after a squash)", () => {
  it("names an own migration whose name and SQL the base has under another number", () => {
    const own = [
      { tag: "0003_b_rls", sql: "CREATE POLICY b ..." },
      { tag: "0004_c", sql: "CREATE TABLE c ..." },
    ];
    const base = [
      { tag: "0002_main", sql: "CREATE TABLE m ..." },
      { tag: "0005_b_rls", sql: "CREATE POLICY b ..." },
    ];
    expect(alreadyOnBase(own, base)).toEqual([{ tag: "0003_b_rls", baseTag: "0005_b_rls" }]);
  });

  it("a same-named migration with other SQL is not a duplicate", () => {
    expect(alreadyOnBase([{ tag: "0003_x", sql: "A" }], [{ tag: "0004_x", sql: "B" }])).toEqual([]);
  });
});
