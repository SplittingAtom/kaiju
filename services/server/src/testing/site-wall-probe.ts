import { randomBytes } from "node:crypto";
import type pg from "pg";

/**
 * The Site wall probe (KOBE-406, SM20; cited by Gate C, docs/gates/gate-7c.md): nothing derived
 * from a thread may reach the Site beyond the confirmed statement and justification. A test seeds
 * a thread with distinctive canary strings (and canary ids), drives its candidates through every
 * Site entry point, then hands every Site read path (rows, console APIs, admin MCP tools,
 * exports, notifications, the Site audit view and its export, KOBE-666) to a {@link SiteWallProbe}, which reports each place a canary or a
 * forbidden field shows up. The detector is deliberately dumb and total: a case-insensitive
 * substring search over every string and key of every value, so a new column, serializer field or
 * read path that copies thread text fails without the probe knowing its shape.
 *
 * `site_memory_proposals` and the Site item tables have no RLS: the server's filters are the wall,
 * so the probe reads every path, not only the rows ({@link siteTableRows} reads every
 * `site_memory%` table, including ones added later).
 */

/** A distinctive, tokeniser-proof marker: lower-case letters and digits only (FTS keeps it whole). */
export const canary = (label: string): string =>
  `kwp${label.toLowerCase().replace(/[^a-z0-9]/g, "")}${randomBytes(5).toString("hex")}`;

/**
 * Field names that carry thread-derived data on the Workspace side and must never appear with a
 * value on a Site read path (a null or empty value is tolerated: e.g. `notifications.thread_id`
 * is a column of every notification and stays null for Site proposal kinds).
 */
export const FORBIDDEN_FIELDS: readonly string[] = [
  "evidence",
  "quote",
  "quotes",
  "rationale",
  "source_thread_id",
  "sourceThreadId",
  "source_entry_ids",
  "sourceEntryIds",
  "thread_id",
  "threadId",
  "entry_id",
  "entryId",
  "run_id",
  "runId",
  "pass_id",
  "passId",
  "candidate_id",
  "candidateId",
  // KOBE-666: the Site audit view (`/v1/site/audit`) is a read path too.
  "fromThreadId",
  "retryOfRunId",
  "suggestionId",
  "toolCallId",
  "approvalId",
];

export interface Leak {
  /** Which read path (e.g. `api:site.detail:<id>`, `db:site_memory_proposals`). */
  readonly surface: string;
  /** JSON-path-like location inside the value. */
  readonly path: string;
  /** The canary found, or `field:<name>` for a forbidden field with a value. */
  readonly found: string;
}

export interface FindOptions {
  /** Forbidden field names this surface may carry by design (documented at the call site). */
  readonly allowFields?: readonly string[];
}

const empty = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

/** Every canary (and forbidden field with a value) inside `value`, with where it was found. */
export function findLeaks(
  surface: string,
  value: unknown,
  canaries: readonly string[],
  options: FindOptions = {},
): Leak[] {
  const needles = canaries.map((c) => c.toLowerCase());
  const forbidden = new Set(FORBIDDEN_FIELDS.filter((f) => !options.allowFields?.includes(f)));
  const leaks: Leak[] = [];
  const scan = (text: string, path: string) => {
    const lower = text.toLowerCase();
    for (const n of needles) if (lower.includes(n)) leaks.push({ surface, path, found: n });
  };
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") return scan(v, path);
    if (v instanceof Uint8Array) return scan(Buffer.from(v).toString("utf8"), path);
    if (v instanceof Date || typeof v !== "object" || v === null) return;
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    for (const [k, x] of Object.entries(v)) {
      scan(k, `${path}{key}`);
      if (forbidden.has(k) && !empty(x))
        leaks.push({ surface, path: `${path}.${k}`, found: `field:${k}` });
      walk(x, `${path}.${k}`);
    }
  };
  walk(value, "$");
  return leaks;
}

/** Collects every Site read path's answer, then reports all leaks at once. */
export class SiteWallProbe {
  private readonly surfaces: { name: string; value: unknown; options: FindOptions }[] = [];

  constructor(readonly canaries: readonly string[]) {
    if (canaries.length === 0) throw new Error("site wall probe: no canaries");
  }

  add(name: string, value: unknown, options: FindOptions = {}): void {
    this.surfaces.push({ name, value, options });
  }

  /** The surface names collected (to assert coverage). */
  names(): string[] {
    return this.surfaces.map((s) => s.name);
  }

  leaks(): Leak[] {
    return this.surfaces.flatMap((s) => findLeaks(s.name, s.value, this.canaries, s.options));
  }

  /** Surfaces whose value contains `text` (positive controls: a path that shows nothing proves nothing). */
  containing(text: string): string[] {
    const needle = text.toLowerCase();
    return this.surfaces
      .filter((s) =>
        JSON.stringify(s.value ?? null)
          .toLowerCase()
          .includes(needle),
      )
      .map((s) => s.name);
  }
}

/** Every row of every `site_memory%` table (no RLS: the server is the only filter). */
export async function siteTableRows(admin: pg.Client): Promise<Record<string, unknown[]>> {
  const { rows: tables } = await admin.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'site\\_memory%' ORDER BY table_name`,
  );
  const out: Record<string, unknown[]> = {};
  for (const { table_name } of tables) {
    const { rows } = await admin.query<{ r: unknown }>(
      `SELECT row_to_json(t) AS r FROM public.${JSON.stringify(table_name)} t`,
    );
    out[table_name] = rows.map((x) => x.r);
  }
  return out;
}
