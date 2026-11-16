import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { ownMessages, ownThreads, quotesOf, type ExportedQuote } from "./items-export.js";
import { quoteFoundIn } from "./quote-normalise.js";

/**
 * The person's Learn from this chat records for the personal export (KOBE-651, SM28), as
 * `memory-learning.json`, all in the exported Workspace: their learning passes, the candidates
 * those passes found for them (every state), their dismissals and watermarks, and the Workspace
 * proposals and project suggestions they made. Other people's records never: every query names the
 * Workspace and the person. As for memories (KOBE-649): a conversation is named only when the
 * person owns it in this Workspace, and an evidence quote is kept only when it cites a message the
 * person wrote there (not a fork's copy) and is found in its text. Curators' and editors' ids are
 * left out; a decision's reason is kept (it was written to the person). Read page by page in short
 * transactions; legal holds change nothing here.
 */

const PAGE = 200;

type Timestamp = Date | string;
const iso = (t: Timestamp | null): string | null => (t === null ? null : new Date(t).toISOString());

interface Viewer {
  readonly teamId: string;
  readonly userId: string;
}

type Row = Record<string, unknown> & { readonly id: string };

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** Quotes of the person's own messages, per (thread, evidence) pair, checked in one batch. */
async function ownQuotes(
  tx: KobeTx,
  viewer: Viewer,
  rows: readonly { threadId: string | null; evidence: unknown }[],
): Promise<{ owned: Set<string>; quotes: (r: (typeof rows)[number]) => ExportedQuote[] }> {
  const threadIds = [...new Set(rows.flatMap((r) => (r.threadId === null ? [] : [r.threadId])))];
  const owned = await ownThreads(tx, viewer, threadIds);
  const cited = rows.flatMap((r) =>
    r.threadId !== null && owned.has(r.threadId)
      ? quotesOf(r.evidence, r.threadId).map((q) => ({
          threadId: r.threadId as string,
          entryId: q.entryId,
        }))
      : [],
  );
  const texts = await ownMessages(tx, viewer, cited);
  const quotes = (r: (typeof rows)[number]) =>
    r.threadId === null || !owned.has(r.threadId)
      ? []
      : quotesOf(r.evidence, r.threadId)
          .filter((q) => {
            const text = texts.get(`${r.threadId}/${q.entryId}`);
            return text !== undefined && quoteFoundIn(q.quote, text);
          })
          .map((q) => ({ entry_id: q.entryId, quote: q.quote }));
  return { owned, quotes };
}

const cursor = (after: string | null, column: string) =>
  after === null ? sql`` : sql`AND ${sql.raw(column)} > ${after}`;

async function passes(tx: KobeTx, v: Viewer, after: string | null): Promise<Row[]> {
  const { rows } = await tx.execute<{
    id: string;
    thread_id: string;
    status: string;
    model_alias: string;
    prompt_version: string;
    error: string | null;
    started_at: Timestamp | null;
    finished_at: Timestamp | null;
    created_at: Timestamp;
  }>(sql`
    SELECT id, thread_id, status, model_alias, prompt_version, error, started_at, finished_at,
           created_at
      FROM memory_learning_passes
     WHERE team_id = ${v.teamId} AND user_id = ${v.userId} ${cursor(after, "id")}
     ORDER BY id LIMIT ${PAGE}`);
  const owned = await ownThreads(
    tx,
    v,
    rows.map((r) => r.thread_id),
  );
  return rows.map((r) => ({
    id: r.id,
    thread_id: owned.has(r.thread_id) ? r.thread_id : null,
    status: r.status,
    model_alias: r.model_alias,
    prompt_version: r.prompt_version,
    error: r.error,
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
    created_at: iso(r.created_at),
  }));
}

async function candidates(tx: KobeTx, v: Viewer, after: string | null): Promise<Row[]> {
  const { rows } = await tx.execute<{
    id: string;
    pass_id: string;
    thread_id: string;
    state: string;
    expired: boolean;
    payload: Record<string, unknown>;
    expires_at: Timestamp;
    decided_at: Timestamp | null;
    created_at: Timestamp;
  }>(sql`
    SELECT c.id, c.pass_id, p.thread_id, c.state, (c.expires_at <= now()) AS expired, c.payload,
           c.expires_at, c.decided_at, c.created_at
      FROM memory_candidates c
      JOIN memory_learning_passes p ON p.team_id = c.team_id AND p.id = c.pass_id
     WHERE c.team_id = ${v.teamId} AND p.team_id = ${v.teamId} AND p.user_id = ${v.userId}
           ${cursor(after, "c.id")}
     ORDER BY c.id LIMIT ${PAGE}`);
  const { quotes } = await ownQuotes(
    tx,
    v,
    rows.map((r) => ({ threadId: r.thread_id, evidence: r.payload.evidence })),
  );
  return rows.map((r) => ({
    id: r.id,
    pass_id: r.pass_id,
    state: r.state === "open" && r.expired ? "expired" : r.state,
    statement: str(r.payload.statement),
    kind: str(r.payload.kind),
    destination: str(r.payload.destination),
    operation: str(r.payload.operation),
    confidence: num(r.payload.confidence),
    rationale: str(r.payload.rationale),
    evidence: quotes({ threadId: r.thread_id, evidence: r.payload.evidence }),
    expires_at: iso(r.expires_at),
    decided_at: iso(r.decided_at),
    created_at: iso(r.created_at),
  }));
}

/** Dismissals and watermarks are keyed by thread (and hash): the page cursor is their text key. */
async function dismissals(tx: KobeTx, v: Viewer, after: string | null): Promise<Row[]> {
  const { rows } = await tx.execute<{
    k: string;
    thread_id: string;
    statement_hash: string;
    created_at: Timestamp;
  }>(sql`
    SELECT thread_id::text || '/' || statement_hash AS k, thread_id, statement_hash, created_at
      FROM memory_dismissals
     WHERE team_id = ${v.teamId} AND user_id = ${v.userId}
           ${cursor(after, "thread_id::text || '/' || statement_hash")}
     ORDER BY 1 LIMIT ${PAGE}`);
  const owned = await ownThreads(
    tx,
    v,
    rows.map((r) => r.thread_id),
  );
  return rows.map((r) => ({
    id: r.k,
    thread_id: owned.has(r.thread_id) ? r.thread_id : null,
    statement_hash: r.statement_hash,
    created_at: iso(r.created_at),
  }));
}

async function watermarks(tx: KobeTx, v: Viewer, after: string | null): Promise<Row[]> {
  const { rows } = await tx.execute<{ k: string; entry_id: string; updated_at: Timestamp }>(sql`
    SELECT thread_id::text AS k, entry_id, updated_at
      FROM memory_learning_watermarks
     WHERE team_id = ${v.teamId} AND user_id = ${v.userId} ${cursor(after, "thread_id::text")}
     ORDER BY 1 LIMIT ${PAGE}`);
  const owned = await ownThreads(
    tx,
    v,
    rows.map((r) => r.k),
  );
  // A watermark of a conversation the person no longer owns says nothing of theirs: left out.
  return rows.map((r) =>
    owned.has(r.k)
      ? { id: r.k, thread_id: r.k, entry_id: r.entry_id, updated_at: iso(r.updated_at) }
      : { id: r.k, thread_id: null, entry_id: null, updated_at: iso(r.updated_at) },
  );
}

async function proposals(tx: KobeTx, v: Viewer, after: string | null): Promise<Row[]> {
  const { rows } = await tx.execute<{
    id: string;
    statement: string;
    kind: string;
    rationale: string | null;
    state: string;
    expired: boolean;
    reason: string | null;
    expires_at: Timestamp;
    decided_at: Timestamp | null;
    created_at: Timestamp;
  }>(sql`
    SELECT id, statement, kind, rationale, state, (expires_at <= now()) AS expired, reason,
           expires_at, decided_at, created_at
      FROM memory_proposals
     WHERE team_id = ${v.teamId} AND proposer_id = ${v.userId} ${cursor(after, "id")}
     ORDER BY id LIMIT ${PAGE}`);
  return rows.map((r) => ({
    id: r.id,
    statement: r.statement,
    kind: r.kind,
    rationale: r.rationale,
    state: r.state === "pending" && r.expired ? "expired" : r.state,
    reason: r.reason,
    expires_at: iso(r.expires_at),
    decided_at: iso(r.decided_at),
    created_at: iso(r.created_at),
  }));
}

async function suggestions(tx: KobeTx, v: Viewer, after: string | null): Promise<Row[]> {
  const { rows } = await tx.execute<{
    id: string;
    project_id: string;
    thread_id: string;
    statement: string;
    kind: string;
    evidence: unknown;
    state: string;
    expired: boolean;
    reason: string | null;
    expires_at: Timestamp;
    decided_at: Timestamp | null;
    created_at: Timestamp;
  }>(sql`
    SELECT id, project_id, thread_id, statement, kind, evidence, state,
           (expires_at <= now()) AS expired, reason, expires_at, decided_at, created_at
      FROM memory_project_suggestions
     WHERE team_id = ${v.teamId} AND suggested_by = ${v.userId} ${cursor(after, "id")}
     ORDER BY id LIMIT ${PAGE}`);
  const { owned, quotes } = await ownQuotes(
    tx,
    v,
    rows.map((r) => ({ threadId: r.thread_id, evidence: r.evidence })),
  );
  return rows.map((r) => ({
    id: r.id,
    project_id: r.project_id,
    thread_id: owned.has(r.thread_id) ? r.thread_id : null,
    statement: r.statement,
    kind: r.kind,
    evidence: quotes({ threadId: r.thread_id, evidence: r.evidence }),
    state: r.state === "pending" && r.expired ? "expired" : r.state,
    reason: r.reason,
    expires_at: iso(r.expires_at),
    decided_at: iso(r.decided_at),
    created_at: iso(r.created_at),
  }));
}

/** Sections of `memory-learning.json`, in order. Dismissal/watermark `id`s are page keys only. */
const SECTIONS: readonly {
  readonly name: string;
  readonly page: (tx: KobeTx, v: Viewer, after: string | null) => Promise<Row[]>;
  readonly keyOnly?: boolean;
}[] = [
  { name: "passes", page: passes },
  { name: "candidates", page: candidates },
  { name: "dismissals", page: dismissals, keyOnly: true },
  { name: "watermarks", page: watermarks, keyOnly: true },
  { name: "proposals", page: proposals },
  { name: "suggestions", page: suggestions },
];

/** `memory-learning.json` as text chunks, one page at a time. */
export async function* learningExportJson(db: KobeDb, viewer: Viewer): AsyncGenerator<string> {
  yield "{";
  for (const [i, section] of SECTIONS.entries()) {
    yield `${i === 0 ? "" : ","}\n  "${section.name}": [`;
    let first = true;
    let after: string | null = null;
    for (;;) {
      const from: string | null = after;
      const rows: Row[] = await withTeam(db, viewer.teamId, (tx) => section.page(tx, viewer, from));
      const out = rows.map((r) => {
        const { id, ...rest } = r;
        return JSON.stringify(section.keyOnly ? rest : { id, ...rest });
      });
      for (const line of out) {
        yield `${first ? "" : ","}\n    ${line}`;
        first = false;
      }
      if (rows.length < PAGE) break;
      after = rows.at(-1)?.id ?? null;
    }
    yield `${first ? "" : "\n  "}]`;
  }
  yield "\n}\n";
}
