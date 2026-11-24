import { describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_FOLDER } from "./migrate.js";
import {
  concurrentIndexName,
  isNoTransaction,
  noTransactionProblem,
  readMigrations,
} from "./migration-runner.js";

describe("-- kobe:no-transaction migrations (KOBE-734)", () => {
  it("reads the marker from the leading comment lines only", () => {
    expect(isNoTransaction("-- kobe:no-transaction\nCREATE INDEX ...")).toBe(true);
    expect(isNoTransaction("-- kobe:hand-written\n-- note\n\n-- kobe:no-transaction\nX")).toBe(
      true,
    );
    expect(isNoTransaction("CREATE TABLE a ();\n-- kobe:no-transaction")).toBe(false);
    expect(isNoTransaction("-- kaiju:no-transactions\nX")).toBe(false);
  });

  it("names the index a concurrent build creates", () => {
    expect(
      concurrentIndexName(
        '-- why\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "files_run_idx" ON "files" (a);',
      ),
    ).toBe("files_run_idx");
    expect(concurrentIndexName("create index concurrently if not exists Abc on t (a)")).toBe("abc");
    expect(concurrentIndexName("CREATE INDEX CONCURRENTLY x ON t (a)")).toBeUndefined();
  });

  it("allows only idempotent concurrent index builds and drops", () => {
    expect(
      noTransactionProblem("CREATE INDEX CONCURRENTLY IF NOT EXISTS x ON t (a);"),
    ).toBeUndefined();
    expect(noTransactionProblem('DROP INDEX CONCURRENTLY IF EXISTS "public"."x";')).toBeUndefined();
    expect(noTransactionProblem("-- only a comment\n")).toBeUndefined();
    expect(noTransactionProblem("CREATE INDEX CONCURRENTLY x ON t (a);")).toMatch(/IF NOT EXISTS/);
    expect(noTransactionProblem("DROP INDEX CONCURRENTLY x;")).toMatch(/IF EXISTS/);
    expect(noTransactionProblem("ALTER TABLE t ADD COLUMN c int;")).toMatch(/may only/);
    expect(
      noTransactionProblem(
        "DROP INDEX CONCURRENTLY IF EXISTS a; DROP INDEX CONCURRENTLY IF EXISTS b;",
      ),
    ).toMatch(/one per breakpoint/);
  });

  it("every shipped no-transaction migration passes the check", () => {
    for (const m of readMigrations(DEFAULT_MIGRATIONS_FOLDER).filter((x) => x.noTransaction)) {
      expect(m.statements.map(noTransactionProblem).filter(Boolean), m.tag).toEqual([]);
    }
  });
});
