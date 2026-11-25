import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import {
  createTestDatabase,
  serverHasPgvector,
  testServerUrl,
  type TestDatabase,
} from "./test-support/database.js";

/**
 * KOBE-409 (v1.3 Semantic Memory SMD2, migration 0230): optional pgvector embedding columns on the
 * three memory item version tables. With pgvector the columns exist, the app role may write only
 * them, and versions stay otherwise immutable; without it the migration still succeeds, adds
 * nothing, and a later superuser `CREATE EXTENSION vector` is picked up by the next migration run.
 */
const VERSION_TABLES = [
  "semantic_memory_item_versions",
  "portable_memory_item_versions",
  "site_memory_item_versions",
];

const pgvector = await serverHasPgvector(testServerUrl());
if (!pgvector) {
  console.warn(
    "memory-vectors.db.test.ts: the test Postgres has no pgvector; only the no-pgvector path runs " +
      "(CI's server shards use a pgvector image, scripts/ci-postgres.sh)",
  );
}

async function query<T extends pg.QueryResultRow>(
  url: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

async function failure(url: string, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await query(url, sql, params);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

async function embeddingColumns(url: string): Promise<string[]> {
  const rows = await query<{ c: string }>(
    url,
    `SELECT table_name || '.' || column_name AS c FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name LIKE 'embedding%' ORDER BY 1`,
  );
  return rows.map((r) => r.c);
}

const ALL_COLUMNS = VERSION_TABLES.flatMap((t) =>
  ["embedding", "embedding_dims", "embedding_model"].map((c) => `${t}.${c}`),
).sort();

describe("without pgvector enabled in the database", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase(testServerUrl(), { vector: false });
  });
  afterAll(async () => {
    await db.drop();
  });

  it("migrates and adds no embedding columns", async () => {
    expect(await embeddingColumns(db.adminUrl)).toEqual([]);
  });

  it("keeps the ensure function away from the app role", async () => {
    expect(await failure(db.appUrl, `SELECT public.kobe_ensure_memory_vectors()`)).toBe("42501");
  });

  it.skipIf(!pgvector)(
    "adds the columns on the next migration run once a superuser enables pgvector",
    async () => {
      await query(db.adminUrl, `CREATE EXTENSION vector`);
      await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
      expect(await embeddingColumns(db.adminUrl)).toEqual(ALL_COLUMNS);
    },
  );
});

describe.skipIf(!pgvector)("with pgvector", () => {
  let db: TestDatabase;
  const user = randomUUID();
  let siteItem = "";

  beforeAll(async () => {
    db = await createTestDatabase(testServerUrl());
    await query(db.adminUrl, `INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
      user,
      `${user}@vec.test`,
    ]);
    const rows = await query<{ id: string }>(
      db.adminUrl,
      `WITH i AS (INSERT INTO site_memory_items (kind) VALUES ('fact') RETURNING id)
       INSERT INTO site_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id)
       SELECT id, 1, 'Fiscal year starts in April', 'user', $1 FROM i RETURNING item_id AS id`,
      [user],
    );
    siteItem = rows[0]?.id ?? "";
  });
  afterAll(async () => {
    await db.drop();
  });

  it("adds embedding, embedding_model and embedding_dims to the three version tables", async () => {
    expect(await embeddingColumns(db.adminUrl)).toEqual(ALL_COLUMNS);
  });

  it("lets the app role write the embedding of a Site version", async () => {
    await query(
      db.appUrl,
      `UPDATE site_memory_item_versions
       SET embedding = '[0.1,0.2,0.3]', embedding_model = 'kaiju-local/nomic', embedding_dims = 3
       WHERE item_id = $1 AND version = 1`,
      [siteItem],
    );
    const rows = await query<{ dims: number }>(
      db.appUrl,
      `SELECT vector_dims(embedding) AS dims FROM site_memory_item_versions WHERE item_id = $1`,
      [siteItem],
    );
    expect(rows[0]?.dims).toBe(3);
  });

  it("still refuses any other change to a version", async () => {
    // Column privilege first (42501), and the immutability trigger for the owner (55000).
    expect(await failure(db.appUrl, `UPDATE site_memory_item_versions SET statement = 'x'`)).toBe(
      "42501",
    );
    expect(
      await failure(
        db.ownerUrl,
        `UPDATE site_memory_item_versions SET statement = 'x', embedding = NULL,
         embedding_model = NULL, embedding_dims = NULL`,
      ),
    ).toBe("55000");
  });

  it("refuses an embedding whose dims or model are missing or wrong", async () => {
    const set = (v: string, model: string | null, dims: number | null): Promise<string | null> =>
      failure(
        db.appUrl,
        `UPDATE site_memory_item_versions SET embedding = $1, embedding_model = $2,
         embedding_dims = $3 WHERE item_id = $4`,
        [v, model, dims, siteItem],
      );
    expect(await set("[1,2]", "m", 3)).toBe("23514");
    expect(await set("[1,2]", null, 2)).toBe("23514");
    expect(await set("[1,2]", "m", 2)).toBeNull();
  });

  it("re-running the ensure step changes nothing", async () => {
    await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
    expect(await embeddingColumns(db.adminUrl)).toEqual(ALL_COLUMNS);
  });
});
