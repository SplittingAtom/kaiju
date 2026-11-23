import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam, type AuditEntry } from "@kobe/db";
import { generateSessionKeyPair } from "@kobe/session-token";
import { AUDIT_FORWARD_LOCK, AuditForwarder } from "./forward/forwarder.js";
import { exportLogsRequest } from "./forward/otlp.js";
import { initialState, writeState } from "./forward/state.js";
import { formatSyslogMessage } from "./forward/syslog.js";
import { appendRunEvents } from "../event-stream/append.js";
import { routeCaller } from "../kobe-mcp/execute.js";
import { siteMemoryItemGet, siteMemoryItemsList } from "../kobe-mcp/tools/memory-items.js";
import type { KobeTool } from "../kobe-mcp/catalog.js";
import { buildRunSemantic, queryWords, readRecallRows } from "../memory/items/run-memory.js";
import { sweepMemoryReminders } from "../notifications/memory.js";
import { createPgReconcileLock } from "../sandbox/reconcile-lock.js";
import type { TestBrowser } from "../testing/browser.js";
import { must } from "../testing/event-stream-fixture.js";
import { openHarness, type Harness } from "../testing/harness.js";
import {
  canary,
  findLeaks,
  siteTableRows,
  SiteWallProbe,
  type Leak,
} from "../testing/site-wall-probe.js";

/**
 * KOBE-406 (SMC5; SM20): the Site wall probe. Two threads carry canaries in the person's message,
 * the evidence quote, the assistant's answer, a tool's output and (via a scripted extractor) the
 * candidates' rationale, plus canary thread, entry and run ids. Real learning passes turn them
 * into candidates, which go through every Site entry point: Propose → Site from a candidate,
 * Propose to Site from a Workspace memory saved from one, confirm with edit, request changes and
 * confirm again, approve (edited), merge and reject. Then every Site read path is collected and
 * must hold no canary and no thread-derived field: the `site_memory%` rows, the Site console and
 * Workspace proposal APIs, provenance, item detail and run context for non-curators, the admin MCP
 * Site memory tools (KOBE-650), the Site export, notifications (rows, digest, reminders, bell API,
 * mail), the audit entries of these flows, the Site audit view and SIEM forwarding (KOBE-676). Only the confirmed statements and justifications
 * (canary-free) cross. ac-2: a corrupted row and an injected field are caught.
 */
let h: Harness;
const PAIR = generateSessionKeyPair();
const team = randomUUID();
const otherTeam = randomUUID();
const LEARNER = `wp-${randomUUID().slice(0, 6)}`;
const WS = "/v1/memory/site-proposals";
const SITE = "/v1/site/memory/proposals";
const ITEMS = "/v1/memory/semantic/items";
const LINT_OK = { overrides: { lint: true } };

const C = {
  user: canary("user"),
  quote: canary("quote"),
  assistant: canary("assistant"),
  tool: canary("tool"),
  rationale: canary("rationale"),
  entryUser: canary("entryuser"),
  entryAssistant: canary("entryassistant"),
  entryTool: canary("entrytool"),
  entryFinal: canary("entryfinal"),
};
const QUOTE = `${C.quote} the finance team set these dates`;

const ids = { admin: "", member: "", siteAdmin: "", siteSteward: "", outsider: "" };
type Who = keyof typeof ids;
const as = {} as Record<Who, TestBrowser>;

/** Thread-derived ids found once the passes ran (candidate ids and pass ids included). */
const derivedIds: string[] = [];
/** Candidate ids: also canaries, except in the Workspace's own `created` audit entry (below). */
const candidateIds: string[] = [];

/** What the scripted extractor answers next (one call per pass). */
let nextReply: { statements: string[]; threadId: string } = { statements: [], threadId: "" };

const gatewayFetch: typeof fetch = async () => {
  const { statements, threadId } = nextReply;
  const candidates = statements.map((statement) => ({
    statement,
    kind: "fact",
    suggested_scope: "team",
    portable: false,
    project_specific: false,
    source: "stated",
    operation: "add",
    target_id: null,
    confidence: 0.9,
    // A model echoing everything it read: the answer, the tool's output and the thread's id.
    rationale: `${C.rationale} ${C.assistant} ${C.tool} thread ${threadId}`,
    evidence: [{ entry_id: C.entryUser, quote: QUOTE }],
  }));
  const content = JSON.stringify({ candidates, skill_hints: [] });
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

const STATEMENTS = [
  "Invoices go out on the third business day.",
  "Expense reports close on the twenty fifth.",
  "Quarterly reviews start in the second week.",
  "Vendor contracts renew every April.",
  "Payroll runs every second Friday.",
  "Travel bookings need two days of notice.",
];
const ADMIN_STATEMENT = "Customer refunds are approved by the finance lead.";
/** Confirmed (canary-free) wording: the only text allowed across. */
const EDITED = "Invoices are sent on the third business day of each month.";
const APPROVED = "Every workspace sends invoices on the third business day.";
const MERGED = "Invoices and expense reports follow the finance calendar.";
const JUSTIFICATION = "Every workspace invoices the same way.";

beforeAll(async () => {
  h = await openHarness({
    serverCalls: { gatewayUrl: "http://gateway.invalid", key: PAIR.signing, fetch: gatewayFetch },
  });
  for (const who of Object.keys(ids) as Who[])
    ids[who] = await h.createUser(`${who}@wp.test`, who === "siteAdmin" ? "admin" : undefined);
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'wp-a', 'Workspace A'), ($2, 'wp-b', 'B')`,
    [team, otherTeam],
  );
  // siteAdmin is also a plain member (bell notices, an admin MCP delegation from a run).
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       ($1, $2, 'team_admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($5, $6, 'team_admin')`,
    [team, ids.admin, ids.member, ids.siteAdmin, otherTeam, ids.outsider],
  );
  await h.admin.query(
    `INSERT INTO site_grants (user_id, "grant", granted_by) VALUES ($1, 'memory_steward', $2)`,
    [ids.siteSteward, ids.siteAdmin],
  );
  await h.admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('openai', 'openai', 'openai', 'v2.test.sealed-provider-key', $1)
     ON CONFLICT (id) DO NOTHING`,
    [ids.admin],
  );
  await h.admin.query(
    `INSERT INTO model_catalog (alias, provider_id, model, created_by) VALUES ($1, 'openai', $1, $2)`,
    [LEARNER, ids.admin],
  );
  await h.admin.query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, $2, true, $3)`,
    [team, LEARNER, ids.admin],
  );
  await h.admin.query(
    `INSERT INTO site_settings (key, value) VALUES ('memory.settings', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ learning_model_alias: LEARNER })],
  );
  for (const who of Object.keys(ids) as Who[]) {
    as[who] = await h.signIn(`${who}@wp.test`);
    if (who === "siteSteward") continue; // no Workspace
    const active = who === "outsider" ? otherTeam : team;
    await as[who].put("/v1/me/teams/active", { teamId: active });
    as[who].team = active;
  }
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const msg = (role: string, content: unknown[], extra: object = {}) =>
  JSON.stringify({ message: { role, content, ...extra } });
const text = (t: string) => ({ type: "text", text: t });

/** A thread of `owner`: the person, the assistant calling a tool, its output, the answer. */
async function seedThread(owner: string): Promise<{ threadId: string; runId: string }> {
  const threadId = randomUUID();
  const runId = randomUUID();
  derivedIds.push(threadId, runId);
  await h.admin.query(`INSERT INTO threads (team_id, id, owner_user_id) VALUES ($1, $2, $3)`, [
    team,
    threadId,
    owner,
  ]);
  const entries: [string, string | null, string][] = [
    [C.entryUser, null, msg("user", [text(`${C.user} asked. ${QUOTE}.`)])],
    [
      C.entryAssistant,
      C.entryUser,
      msg("assistant", [
        text(`${C.assistant} let me check.`),
        { type: "toolCall", id: "call1", name: "lookup", arguments: { q: "dates" } },
      ]),
    ],
    [
      C.entryTool,
      C.entryAssistant,
      msg("toolResult", [text(`${C.tool} calendar rows`)], {
        toolCallId: "call1",
        toolName: "lookup",
      }),
    ],
    [C.entryFinal, C.entryTool, msg("assistant", [text(`${C.assistant} noted.`)])],
  ];
  for (const [id, parent, payload] of entries)
    await h.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
       VALUES ($1, $2, $3, $4, 'message', $5)`,
      [team, threadId, id, parent, payload],
    );
  await h.admin.query(`UPDATE threads SET leaf_entry_id = $3 WHERE team_id = $1 AND id = $2`, [
    team,
    threadId,
    C.entryFinal,
  ]);
  await h.admin.query(
    `INSERT INTO runs (team_id, id, thread_id, trigger, status, started_at, ended_at, user_entry_id)
     VALUES ($1, $2, $3, 'user', 'completed', now(), now(), $4)`,
    [team, runId, threadId, C.entryUser],
  );
  await h.admin.query(
    `INSERT INTO sandbox_run_leases (team_id, run_id, user_id, thread_id, sandbox_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [team, runId, owner, threadId, randomUUID()],
  );
  await appendRunEvents(h.deps.database.db, team, runId, [
    { type: "run.completed", payload: { leaf_entry_id: null } },
  ]);
  return { threadId, runId };
}

/** A real learning pass over the thread; returns its candidates' ids in order. */
async function learn(who: Who, threadId: string, statements: string[]): Promise<string[]> {
  nextReply = { statements, threadId };
  const res = await as[who].post(`/v1/threads/${threadId}/learn`, { mode: "all" });
  expect(res.status, JSON.stringify(res.json)).toBe(202);
  const passId = (res.json as { pass_id: string }).pass_id;
  await h.deps.background.idle();
  const { rows } = await h.admin.query<{ id: string; payload: Record<string, unknown> }>(
    `SELECT id, payload FROM memory_candidates WHERE pass_id = $1 ORDER BY ord`,
    [passId],
  );
  expect(rows).toHaveLength(statements.length);
  // The candidates really carry the canaries (else the probe proves nothing).
  expect(JSON.stringify(rows[0]?.payload)).toContain(C.rationale);
  expect(JSON.stringify(rows[0]?.payload)).toContain(C.quote);
  derivedIds.push(passId, ...rows.map((r) => r.id));
  candidateIds.push(...rows.map((r) => r.id));
  return rows.map((r) => r.id);
}

const ok = async (p: Promise<{ status: number; json: unknown }>, status = 200) => {
  const r = await p;
  expect(r.status, JSON.stringify(r.json)).toBe(status);
  return r.json as Record<string, unknown>;
};
const proposalId = (j: Record<string, unknown>) => (j.proposal as { id: string }).id;
const itemId = (j: Record<string, unknown>) => (j.item as { id: string }).id;

interface World {
  readonly proposals: string[];
  readonly siteItems: string[];
  readonly memberThread: string;
  readonly mcpDelegation: { threadId: string; runId: string };
}
let world: World;

/** Every Site read path into a probe. Call again after a mutation to re-read everything. */
async function collect(w: World): Promise<SiteWallProbe> {
  const textCanaries = Object.values(C);
  const probe = new SiteWallProbe([...textCanaries, ...derivedIds]);
  const get = async (who: Who, path: string) => (await as[who].get(path)).json as unknown;

  // Rows: every site_memory% table (no RLS).
  for (const [table, rows] of Object.entries(await siteTableRows(h.admin)))
    probe.add(`db:${table}`, rows);

  // Site console (Site curators) and the Workspace side (its curators, the proposer).
  for (const who of ["siteAdmin", "siteSteward"] as const) {
    probe.add(`api:${who}:site.queue`, await get(who, SITE));
    for (const state of ["awaiting_team", "awaiting_site", "approved", "merged", "rejected"])
      probe.add(`api:${who}:site.queue.${state}`, await get(who, `${SITE}?state=${state}`));
    for (const id of w.proposals)
      probe.add(`api:${who}:site.detail`, await get(who, `${SITE}/${id}`));
  }
  for (const who of ["admin", "member"] as const) {
    probe.add(`api:${who}:workspace.list`, await get(who, WS));
    for (const id of w.proposals)
      probe.add(`api:${who}:workspace.detail`, await get(who, `${WS}/${id}`));
  }

  // Site items: curators and non-curators (a member, another Workspace's Team admin).
  for (const who of ["siteAdmin", "siteSteward", "member", "admin", "outsider"] as const) {
    probe.add(`api:${who}:items.list`, await get(who, `${ITEMS}?scope=site&status=active`));
    for (const id of w.siteItems) {
      probe.add(`api:${who}:item.detail`, await get(who, `${ITEMS}/site/${id}`));
      probe.add(`api:${who}:provenance`, await get(who, `${SITE}/items/${id}/provenance`));
    }
  }

  // Run context of a non-curator's run (the selector and recall): Site lane only.
  const db = h.deps.database.db;
  const message = "When are invoices sent, expense reports closed and customer refunds approved?";
  const semantic = await withTeam(db, team, (tx) =>
    buildRunSemantic(tx, {
      teamId: team,
      userId: ids.member,
      threadId: w.memberThread,
      runId: randomUUID(),
      message,
    }),
  );
  probe.add(
    "run:semantic",
    semantic?.semantic.items.filter((i) => i.scope === "site" || i.policy) ?? [],
  );
  const recall = await withTeam(db, team, (tx) =>
    readRecallRows(tx, { teamId: team, userId: ids.member }, queryWords(message), true, ["site"]),
  );
  probe.add(
    "run:recall",
    recall.map((r) => r.item),
  );

  // Admin MCP read-only Site memory tools (KOBE-650), as the executor calls them.
  const call = routeCaller(h.app, {
    userId: ids.siteAdmin,
    teamId: team,
    ...w.mcpDelegation,
    toolCallId: "wall-probe",
  });
  const tool = async (t: KobeTool, input: unknown) => {
    const route = t.route(input as never);
    const answer = await call(route);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return t.reduce(answer.body, input as never);
  };
  probe.add("mcp:site_memory_items_list", await tool(siteMemoryItemsList, {}));
  for (const id of w.siteItems)
    probe.add("mcp:site_memory_item_get", await tool(siteMemoryItemGet, { id }));

  // Exports that include Site items: the Site memory export (JSON and CSV, inactive too).
  for (const format of ["json", "csv"] as const) {
    const r = await as.siteAdmin.post("/v1/memory/semantic/export", {
      scope: "site",
      format,
      include_inactive: true,
    });
    expect(r.status, r.text).toBe(200);
    probe.add(`export:site.${format}`, r.text);
  }

  // Notifications: rows (incl. digests), reminders, email rows, the bell API, mail sent.
  const notif = await h.admin.query(
    `SELECT * FROM notifications WHERE team_id = $1
      AND (kind LIKE 'memory.site_proposal.%' OR related_kind LIKE 'memory.site_proposal.%')`,
    [team],
  );
  probe.add("db:notifications", notif.rows);
  const reminders = await h.admin.query(
    `SELECT * FROM memory_reminders WHERE team_id = $1 AND related_kind LIKE 'memory.site_proposal.%'`,
    [team],
  );
  probe.add("db:memory_reminders", reminders.rows);
  const emails = await h.admin.query(
    `SELECT e.* FROM notification_emails e JOIN notifications n ON n.id = e.notification_id
      WHERE n.team_id = $1`,
    [team],
  );
  probe.add("db:notification_emails", emails.rows);
  // The bell API also lists the person's own Workspace notices (e.g. candidates ready in their
  // thread, which names it by design): only the Site proposal notices (and digests, reminders of
  // them) are this wall's.
  const siteKind = (k: unknown) => typeof k === "string" && k.startsWith("memory.site_proposal.");
  for (const who of ["admin", "member", "siteAdmin"] as const) {
    const bell = (await get(who, "/v1/notifications?limit=100")) as {
      notifications: { kind: string; related_kind?: string | null }[];
    };
    const mine = bell.notifications.filter((n) => siteKind(n.kind) || siteKind(n.related_kind));
    expect(mine.length, who).toBeGreaterThan(0);
    probe.add(`api:${who}:notifications`, mine);
  }
  probe.add("mail:sent", h.mailer.sent);

  // Audit of these flows: the Site log's memory events, the Workspace log's Site proposal events
  // (rows and the site audit API). The Workspace's own `memory.site_proposal.created` names the
  // candidate it closed (KOBE-403, Workspace side): candidate ids are allowed there only.
  const siteAudit = await h.admin.query(
    `SELECT * FROM audit_log WHERE team_id IS NULL AND action LIKE 'memory.%' ORDER BY seq`,
  );
  probe.add("db:audit.site", siteAudit.rows);
  const teamAudit = await h.admin.query(
    `SELECT * FROM audit_log WHERE team_id = $1 AND action LIKE 'memory.site_proposal.%'
      ORDER BY seq`,
    [team],
  );
  const created = teamAudit.rows.filter((r) => r.action === "memory.site_proposal.created");
  const rest = teamAudit.rows.filter((r) => r.action !== "memory.site_proposal.created");
  probe.add("db:audit.workspace", rest);
  const noCandidates = new SiteWallProbe(
    [...textCanaries, ...derivedIds].filter((x) => !candidateIds.includes(x)),
  );
  noCandidates.add("db:audit.workspace.created", created, { allowFields: ["candidateId"] });
  createdLeaks = noCandidates.leaks();
  // The Site audit view (KOBE-666, Gate C decision 3): every page of `/v1/site/audit` and its
  // export, every event (the Site log's and every Workspace's, any action), with nothing allowed:
  // Workspace events show only allow-listed metadata (`audit/site-view.ts`).
  const apiAudit: { action: string; teamId: string | null }[] = [];
  for (let before: string | null = null, n = 0; n < 50; n++) {
    const page = (await get(
      "siteAdmin",
      `/v1/site/audit?limit=200${before ? `&before=${before}` : ""}`,
    )) as { events: { action: string; teamId: string | null }[]; nextCursor: string | null };
    apiAudit.push(...page.events);
    before = page.nextCursor;
    if (before === null) break;
  }
  expect(apiAudit.some((e) => e.action === "memory.pass.completed")).toBe(true);
  probe.add("api:siteAdmin:site.audit", apiAudit);
  for (const format of ["jsonl", "csv"] as const) {
    const r = await as.siteAdmin.get(`/v1/site/audit/export?format=${format}`);
    expect(r.status, r.text).toBe(200);
    // JSONL as objects too, so a forbidden field (not only a canary) is named.
    const rows =
      format === "jsonl"
        ? r.text
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l))
        : [];
    probe.add(`api:siteAdmin:site.audit.export.${format}`, format === "jsonl" ? rows : r.text);
  }
  // SIEM forwarding (KOBE-676, Gate 7 answer 1) leaves the box in the same Site view: every event
  // from seq 0 through the real forwarder into a fake sink; the probe reads the events and both
  // wire formats (RFC 5424 messages, the OTLP request).
  const forwarded = await forwardEverything();
  expect(forwarded.some((e) => e.action === "memory.pass.completed")).toBe(true);
  probe.add("siem:events", forwarded);
  probe.add(
    "siem:syslog",
    forwarded.map((e) => formatSyslogMessage(e)),
  );
  probe.add("siem:otlp", exportLogsRequest(forwarded));
  return probe;
}

/** Every audit event as the SIEM forwarder hands it to a destination (fake sink, cursor at 0). */
async function forwardEverything(): Promise<AuditEntry[]> {
  const { db, pool } = h.deps.database;
  await writeState(db, "syslog", initialState(0));
  const sent: AuditEntry[] = [];
  const errors: object[] = [];
  const forwarder = new AuditForwarder({
    db,
    sinks: [{ name: "syslog", send: async (events) => void sent.push(...events) }],
    lock: createPgReconcileLock(pool, undefined, `${AUDIT_FORWARD_LOCK}.wall-probe`),
    log: { warn: (o) => void errors.push(o), error: (o) => void errors.push(o) },
  });
  for (let before = -1; before !== sent.length;) {
    before = sent.length;
    await forwarder.runOnce();
  }
  expect(errors).toEqual([]);
  expect(sent.length).toBeGreaterThan(0);
  return sent;
}
let createdLeaks: Leak[] = [];

describe("the Site wall (KOBE-406)", () => {
  it("drives canary-laden candidates through every Site entry point", async () => {
    const m = await seedThread(ids.member);
    const a = await seedThread(ids.admin);
    const memberCandidates = await learn("member", m.threadId, STATEMENTS);
    const [adminCandidate] = await learn("admin", a.threadId, [ADMIN_STATEMENT]);

    // Entry point 1: Propose → Site from a candidate (six: the Team admin's notices digest).
    const p: string[] = [];
    for (const id of memberCandidates)
      p.push(
        proposalId(
          await ok(as.member.post(`${WS}/candidates/${id}`, { justification: JUSTIFICATION }), 201),
        ),
      );
    const [p1, p2, p3, p4] = p as [string, string, string, string];
    // Confirm with edit, request changes, confirm again, approve (edited).
    await ok(
      as.admin.post(`${WS}/${p1}/confirm`, {
        statement: EDITED,
        justification: "Finance runs one calendar for every workspace.",
      }),
    );
    await ok(as.siteAdmin.post(`${SITE}/${p1}/request-changes`, { note: "Say which month." }));
    await ok(as.admin.post(`${WS}/${p1}/confirm`, {}));
    const s1 = itemId(
      await ok(as.siteSteward.post(`${SITE}/${p1}/approve`, { statement: APPROVED, ...LINT_OK })),
    );
    // Merge into it; reject one; one waits for the Site, two for the Team admins.
    await ok(as.admin.post(`${WS}/${p2}/confirm`, {}));
    await ok(
      as.siteAdmin.post(`${SITE}/${p2}/merge`, { item_id: s1, statement: MERGED, ...LINT_OK }),
    );
    await ok(as.admin.post(`${WS}/${p3}/confirm`, {}));
    await ok(as.siteAdmin.post(`${SITE}/${p3}/reject`, { reason: "Too team-specific." }));
    await ok(as.admin.post(`${WS}/${p4}/confirm`, {}));

    // Entry point 2: a Workspace memory saved from a candidate (its version keeps the thread
    // link and entry ids, Workspace side), proposed to the Site by a Team admin and approved.
    const saved = await ok(
      as.admin.post(`/v1/memory/review/candidates/${must(adminCandidate, "c")}/save`, {
        scope: "team",
      }),
    );
    const workspaceItem = itemId(saved);
    const src = await h.admin.query(
      `SELECT source_thread_id FROM semantic_memory_item_versions WHERE item_id = $1`,
      [workspaceItem],
    );
    expect(src.rows[0]?.source_thread_id).toBe(a.threadId);
    const p7 = proposalId(
      await ok(as.admin.post(WS, { item_id: workspaceItem, justification: JUSTIFICATION }), 201),
    );
    const s2 = itemId(await ok(as.siteSteward.post(`${SITE}/${p7}/approve`, LINT_OK)));

    // Reminders come due and are sent (KOBE-645 sweep).
    await h.admin.query(
      `UPDATE memory_reminders SET due_at = now() - interval '1 minute' WHERE team_id = $1`,
      [team],
    );
    await sweepMemoryReminders(h.deps.database.db);

    // A running run of the Site admin's, for the admin MCP delegation.
    const mcpThread = randomUUID();
    const mcpRun = randomUUID();
    await h.admin.query(`INSERT INTO threads (team_id, id, owner_user_id) VALUES ($1, $2, $3)`, [
      team,
      mcpThread,
      ids.siteAdmin,
    ]);
    await h.admin.query(
      `INSERT INTO runs (team_id, id, thread_id, trigger, status, started_at)
       VALUES ($1, $2, $3, 'user', 'running', now())`,
      [team, mcpRun, mcpThread],
    );
    world = {
      proposals: [...p, p7],
      siteItems: [s1, s2],
      memberThread: m.threadId,
      mcpDelegation: { threadId: mcpThread, runId: mcpRun },
    };
    const digests = await h.admin.query(
      `SELECT 1 FROM notifications WHERE team_id = $1 AND kind = 'memory.review.digest'
        AND related_kind = 'memory.site_proposal.received'`,
      [team],
    );
    expect(digests.rows.length).toBeGreaterThan(0);
  });

  it("ac-1: no canary or thread-derived field on any Site read path", async () => {
    const probe = await collect(world);
    expect(probe.leaks()).toEqual([]);
    expect(createdLeaks).toEqual([]);
    // Positive controls: each path really shows the confirmed text (else it proves nothing).
    const showsMerged = probe.containing(MERGED);
    for (const surface of [
      "db:site_memory_item_versions",
      "api:member:item.detail",
      "api:outsider:items.list",
      "mcp:site_memory_item_get",
      "export:site.json",
      "export:site.csv",
      "run:semantic",
      "run:recall",
    ])
      expect(showsMerged, surface).toContain(surface);
    const showsEdited = probe.containing(EDITED);
    for (const surface of [
      "db:site_memory_proposals",
      "api:siteAdmin:site.detail",
      "api:member:workspace.detail",
    ])
      expect(showsEdited, surface).toContain(surface);
    expect(probe.containing(JUSTIFICATION)).toContain("db:site_memory_proposals");
    expect(probe.containing("memory.site_proposal.confirmed")).toContain("db:notifications");
    expect(probe.containing("memory.site_proposal.accepted")).toContain("db:audit.site");
    // The Site audit view lists the Workspace's events too (D6), only without thread-derived ids.
    for (const surface of [
      "api:siteAdmin:site.audit",
      "api:siteAdmin:site.audit.export.jsonl",
      "api:siteAdmin:site.audit.export.csv",
      "siem:events",
      "siem:syslog",
      "siem:otlp",
    ]) {
      expect(probe.containing("memory.site_proposal.created"), surface).toContain(surface);
      expect(probe.containing("memory.pass.completed"), surface).toContain(surface);
    }
  });
});

describe("mutation check (ac-2)", () => {
  it("the detector names an injected evidence field and a copied quote", () => {
    const view = {
      proposal: { id: randomUUID(), statement: APPROVED, justification: JUSTIFICATION },
    };
    expect(findLeaks("api", view, Object.values(C))).toEqual([]);
    const corrupted = { proposal: { ...view.proposal, evidence: [{ quote: QUOTE }] } };
    expect(findLeaks("api", corrupted, Object.values(C))).toEqual([
      { surface: "api", path: "$.proposal.evidence", found: "field:evidence" },
      { surface: "api", path: "$.proposal.evidence[0].quote", found: "field:quote" },
      { surface: "api", path: "$.proposal.evidence[0].quote", found: C.quote },
    ]);
  });

  it("a corrupted proposal row and Site version are caught on every path that reads them", async () => {
    const [p4] = world.proposals.slice(3, 4) as [string];
    const [, s2] = world.siteItems as [string, string];
    const before = await h.admin.query<{ justification: string }>(
      `SELECT justification FROM site_memory_proposals WHERE id = $1`,
      [p4],
    );
    const version = await h.admin.query<{ statement: string; version: number }>(
      `SELECT statement, version FROM site_memory_item_versions WHERE item_id = $1
        ORDER BY version DESC LIMIT 1`,
      [s2],
    );
    const v = must(version.rows[0], "version");
    // As if a copy bug carried the rationale and the evidence quote across.
    await h.admin.query(
      `UPDATE site_memory_proposals SET justification = justification || ' ' || $2 WHERE id = $1`,
      [p4, C.rationale],
    );
    // Versions are immutable (trigger): this test session alone skips triggers to corrupt one.
    const corruptVersion = async (statement: string) => {
      await h.admin.query(`SET session_replication_role = replica`);
      try {
        await h.admin.query(
          `UPDATE site_memory_item_versions SET statement = $3 WHERE item_id = $1 AND version = $2`,
          [s2, v.version, statement],
        );
      } finally {
        await h.admin.query(`SET session_replication_role = DEFAULT`);
      }
    };
    await corruptVersion(`${v.statement} ${QUOTE}`);
    try {
      const leaks = (await collect(world)).leaks();
      const where = (found: string) =>
        new Set(leaks.filter((l) => l.found === found).map((l) => l.surface));
      const rationale = where(C.rationale);
      for (const s of [
        "db:site_memory_proposals",
        "api:siteAdmin:site.detail",
        "api:siteSteward:site.queue",
        "api:admin:workspace.detail",
      ])
        expect(rationale, s).toContain(s);
      const quote = where(C.quote);
      for (const s of [
        "db:site_memory_item_versions",
        "api:member:item.detail",
        "api:outsider:item.detail",
        "mcp:site_memory_item_get",
        "mcp:site_memory_items_list",
        "export:site.json",
        "export:site.csv",
        "run:recall",
      ])
        expect(quote, s).toContain(s);
    } finally {
      await h.admin.query(`UPDATE site_memory_proposals SET justification = $2 WHERE id = $1`, [
        p4,
        must(before.rows[0], "row").justification,
      ]);
      await corruptVersion(v.statement);
    }
    expect((await collect(world)).leaks()).toEqual([]);
  });
});
