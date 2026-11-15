# Gate A evidence: prompt-cache share of "What Kobe knows" (KOBE-383)

v1.3 Semantic Memory, wave A7 (KOBE-383 ac-4; Chris 2026-11-12, Q6: re-pick every message, keep the
stable parts first so the provider caches the prefix). This page records the **cache-read share**
on a 20-turn thread before and after KOBE-383. The numbers are **not filled in yet**: they need a
real provider that reports cache counters, so they are measured on gate1 at Gate A. The fake
upstream model used in CI and on the dev VM reports no cache tokens, so nothing could be measured
when KOBE-383 was built.

## What changed

Before KOBE-383 the memory fence carried a fresh random nonce every run, so the system prompt
changed near its start on every message and no later token could be read from the cache. After it:

- the nonce is per thread (HMAC of the thread id under the agent process's key), so the memory
  blocks are byte-identical across runs of a thread;
- the run's additions are ordered stable first: What Kobe knows (preamble, Policy, pinned),
  Notes indexes, project instructions, then the per-message picks, the viewed file and sync
  conflicts.

The picks are re-picked every message (SM24), so a message whose picks change still breaks the
cache from the picks onwards (that includes the conversation history after the system prompt).
The measurement shows how much the stable prefix buys in practice.

## Method

1. Pick a team model whose provider reports cached prompt tokens (Anthropic `cache_read_input_tokens`
   or OpenAI-compatible `prompt_tokens_details.cached_tokens`; the gateway normalises both into
   `cacheRead`, `services/model-gateway/src/usage/normalize.ts`, and records it as
   `run_usage.cache_read_tokens`, `usage/sink.ts`).
2. Seed the member's memory: 3 Policy rules, 2 pinned Workspace memories, 10+ other memories across
   the four places, and a Notes index of a few lines.
3. **Before:** on an install at the commit before KOBE-383 (the KOBE-382 build), open a new
   thread with a Kobe agent whose Memory setting is Full and send the 20 scripted messages in
   `e2e/browser` style (fixed texts, one per turn, each waiting for the run to finish). Note the
   thread id.
4. **After:** deploy the KOBE-383 build, repeat step 3 in a new thread with the same messages.
5. For each thread, from the gate1 database (`kobe-gate1-deps`, read-only):

   ```sql
   SELECT count(*) AS calls,
          sum(cache_read_tokens) AS cache_read,
          sum(input_tokens + cache_read_tokens + cache_write_tokens) AS prompt,
          round(100.0 * sum(cache_read_tokens)
                / nullif(sum(input_tokens + cache_read_tokens + cache_write_tokens), 0), 1)
            AS cache_read_share_pct
   FROM run_usage
   WHERE team_id = :team AND thread_id = :thread;
   ```

   Also note the share for turns 2-20 only (turn 1 can never read the cache).

6. Record both rows below with the model, the commits and the date.

## Results

Measured on gate1 on 2026-11-15, model `glm-5.3-flash` (Ollama Cloud, which reports cached prompt
tokens), owner in Team1, seeded per step 2 (no Notes index).

| Build                               | Model         | Thread     | Calls | Cache read | Prompt tokens | Share (all) | Share (turns 2-20) |
| ----------------------------------- | ------------- | ---------- | ----- | ---------- | ------------- | ----------- | ------------------ |
| Before (`d7dfb763`, KOBE-382 build) | glm-5.3-flash | `33926e48` | 20    | 109,440    | 120,027       | 91.2%       | 94.3%              |
| After (`63c6549f`, main with 383)   | glm-5.3-flash | `0bd91d16` | 20    | 28,800     | 110,415       | **26.1%**   | **27.2%**          |

**Reading: KOBE-383 lowered the cache-read share.** The "before" build does not render What
Kobe knows in the sandbox at all (rendering is KOBE-383), so its system prompt never changes and
almost every turn reads the whole prefix from the cache. The "after" build renders the
per-message picks inside the system prompt; picks are re-picked every message (SM24, Q6), they
change on most turns, and every change invalidates everything after them, including the whole
conversation history. Per turn (input/cache-read tokens): before `3932/0, 213/3840, 254/3968,
291/4096, ...` (every later turn hits); after `4604/0, 4784/0, 4885/0, 180/4736, 5029/0, ...`
(14 of 19 later turns read nothing). The stable-first ordering works as designed (turns whose
picks did not change read about 4.7k tokens), but it cannot help while the picks sit in the system
prompt. **Proposed fix (Chris decides at Gate A):** carry the per-message picks (and other
per-message parts: viewed file, sync conflicts) in the newest user turn instead of the system
prompt, so the system prompt and the history stay byte-identical across turns while picks are
still re-picked every message.

### Running the replay with the harness (KOBE-387)

`e2e/memory-eval.sh cache` does steps 3-5 from any machine with the repository (`pnpm install`),
through the install's public API as the member: it signs in, creates a new thread, sends the 20
messages of `e2e/fixtures/memory-cache/turns.json` one per turn (each after the previous run's
terminal event; they ask for no tools), then reads `GET /v1/threads/{id}/usage` (the same
`run_usage` rows as the SQL above) and prints the share over all turns and over turns 2-20.
`KOBE_EVAL_SEED=1` first creates the step 2 memories from `e2e/fixtures/memory-cache/seed.json`
(once per install, before the "before" replay; Policy needs a Site admin; add the Notes index by
hand). Everything about the install comes from the operator's shell; nothing is committed:

```bash
export KOBE_EVAL_URL=https://<install>            # public URL
export KOBE_EVAL_EMAIL=<member> KOBE_EVAL_PASSWORD=<password>   # or KOBE_EVAL_COOKIE=<Cookie header>
export KOBE_EVAL_TEAM_ID=<workspace id>           # optional: default is the active Workspace
export KOBE_EVAL_AGENT_ID=<agent id>              # an agent whose Memory setting is Full
export KOBE_EVAL_MODEL=<alias>                    # a model whose provider reports cached tokens
KOBE_EVAL_SEED=1 KOBE_EVAL_LABEL=before KOBE_EVAL_OUT=before.json e2e/memory-eval.sh cache   # KOBE-382 build
# deploy the KOBE-383 build, then:
KOBE_EVAL_LABEL=after KOBE_EVAL_OUT=after.json e2e/memory-eval.sh cache
```

A turn that does not end in `run.completed` stops the replay. "No cache reads at all" means the
provider reports no cached tokens: pick another model. Cross-check one thread with the SQL above.

## Relevance: FTS recall@8 (KOBE-387, SM25/SM30)

Gate A's other number: does the KOBE-382 selector (Postgres full text with the fixed `english`
config + 0.3 · trigram + 0.1 · recency) find the right memories? Phase D (vectors) only if overall
recall@8 is below **0.85**.

**Set.** `e2e/fixtures/memory-relevance/`: 121 items of a fictional company over all four lanes
(24 preferences, 34 facts, 21 definitions, 21 conventions, 21 decisions, 8 of them unrelated
noise) and 151 queries, 30+ per kind, labelled literal (50), paraphrase (61, no content word or
stem shared with the answer) and indirect (40, a task that needs the item). 95 queries list hard
negatives. Items and queries were written by different authors; the queries were frozen before
the first run and nothing was tuned afterwards (construction: the fixtures' README.md).

**Method.** `e2e/memory-eval.sh relevance` seeds the items into a throwaway database (created and
dropped on `KOBE_TEST_DATABASE_URL`'s server) over the split tables, then sends each query as a
run's message through the selector's own store read (`readRunCandidates`, the same SQL and
trigram as `buildRunSemantic`; a fresh untitled thread, so no earlier messages or stickiness).

- **recall@8 (relevance)**, the Gate A number: the selector's eligible candidates (a query word
  matched, pinned, or a person-lane preference) ordered by the SM24 relevance score; share of a
  query's expected items in the first 8, averaged over queries.
- **recall@8 (selector score)**: the same with the selector's full score, which adds 0.5 to every
  person-lane preference. The 24 preferences then fill the top 8 of every query, so this column
  measures the base, not retrieval; it is shown so nobody mistakes it for the gate number.
- **in block**: share of expected items inside the block actually selected at the default 8 KiB
  budget (what the agent sees).
- **negative above answer**: queries with hard negatives where one ranked above the answer.

**Results** (2026-11-13, KOBE-382 selector at `0da68a6c`, dev Postgres 17; two runs, identical):

| Group             | Queries | recall@8 (relevance) | recall@8 (selector score) | in block | negative above answer |
| ----------------- | ------- | -------------------- | ------------------------- | -------- | --------------------- |
| **overall**       | 151     | **0.573**            | 0.174                     | 0.669    | 17.9%                 |
| preference        | 30      | 0.633                | 0.678                     | 0.983    | 22.2%                 |
| fact              | 30      | 0.517                | 0.000                     | 0.550    | 18.8%                 |
| convention        | 30      | 0.533                | 0.033                     | 0.533    | 23.5%                 |
| definition        | 31      | 0.645                | 0.000                     | 0.677    | 19.2%                 |
| decision          | 30      | 0.533                | 0.167                     | 0.600    | 5.6%                  |
| style: literal    | 50      | 0.980                | 0.300                     | 1.000    | 11.1%                 |
| style: paraphrase | 61      | 0.139                | 0.082                     | 0.287    | 32.5%                 |
| style: indirect   | 40      | 0.725                | 0.158                     | 0.838    | 3.6%                  |

**Reading.** 0.573 < 0.85: on this set Phase D (vectors) is indicated. Literal questions are
solved (0.98); the gap is paraphrase (0.14): 53 of the 61 paraphrase queries miss, and in 43 of
them no expected item was even a candidate, because eligibility needs a full-text word match and
trigram similarity only ranks. More weight on trigram would not help them; meaning-level matching would. The headline
depends on the mix (40% strict paraphrases here, written to be hard); with literal and indirect
queries alone it would be 0.87. Gate A (KOBE-388) decides with these caveats.

## Gate A checklist (KOBE-388)

Evidence for each acceptance criterion and story. Stories as amended 2026-11-12 (Hadron spec
`4b0acbf3`, Chris Q1-Q11): Phase A has manual saves only (no Learn, no proposals yet), and
"Memories in context" lives in the context viewer and Session info, owner-only. Test runs below
are at `63c6549f` (origin/main) on the dev Postgres, 2026-11-15. Counts per file come from
`vitest list` (an `it.each` table counts once there); totals are from the runs.

| Run                                                         | Files | Tests passed |
| ----------------------------------------------------------- | ----- | ------------ |
| `@kobe/server` db tests (`vitest.db.config.ts`, 23 files)   | 23    | 290 / 290    |
| `@kobe/db` db tests (schema, catalog, upgrades, 7 files)    | 7     | 329 / 329    |
| `@kobe/server` unit (memory, run-memory, admin MCP)         | 15    | 256 / 256    |
| `@kobe/sandbox-agent` unit (memory context, Notes tools)    | 8     | 116 / 116    |
| `@kobe/protocol` unit (memory contract)                     | 3     | 89 / 89      |
| `@kobe/web` unit (editor, consoles, switches, context view) | 15    | 138 / 138    |

### ac-1: stories

| Story                                               | What Gate A must show                                                                                                                                                                                             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Status                                                                                                                                                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **U40** manual saves incl. portable                 | Saves apply in this Workspace only, with Undo; portable preferences (after confirmation) reach the person's other Workspaces; a portable fact is impossible                                                       | server `memory-items.db.test.ts` (9: lifecycle on user/portable/team/site incl. Undo; walls; `confirm_portable` needed); `memory-selection.db.test.ts` "never gives another person's ... In Workspace B the runner gets ... their portable ones"; `@kobe/db` `semantic-memory.db.test.ts` "refuses a portable item that is not a preference"; web `my-memories.test.tsx` (Me editor: add + Undo archives, "Use in all my workspaces?" confirmation, portable for preferences only); browser `memory-editor.spec.ts`                                                                                            | db/unit green; browser spec on gate1: passed. No in-chat item chip in Phase A (the agent has no write path to items; KOBE-384 ledger): the editor's "Memory saved." + Undo is the Phase A chip                |
| **U43** curators                                    | Team admins + stewards save, edit, archive, pin (≤10), tag, import with preview, export; 80% warn / 100% block; audited                                                                                           | `memory-stewards.db.test.ts` (11); `memory-items.db.test.ts` "lets Team admins and Workspace stewards change Workspace items, not other members"; `memory-items-limits.db.test.ts` (11: 80% notice once, 100% block, pins ≤10, tags, near-duplicates, version cap); `memory-items-review.db.test.ts` (7: races on limits, pins, Policy budget); `memory-transfer.db.test.ts` (16: import preview/commit, export JSON/CSV, audited); `kobe-mcp-memory.db.test.ts` (7, read-only admin MCP tools); web `memory-consoles.test.tsx`, `memory-stewards.test.tsx`; browser `memory-consoles.spec.ts` (import)        | db/unit green; browser spec on gate1: passed                                                                                                                                                                  |
| **U45** Site curation and Policy (no proposals yet) | Site curators curate (no Site proposals in Phase A); Site admins set Policy (≤25 items, ≤2 KiB); Policy renders first in every Workspace even with the opt-out; contradicting saves blocked with audited override | `memory-items.db.test.ts` "Site items and Policy" (stewards curate, never Policy; 25 items / 2 KiB cap); `memory-transfer.db.test.ts` "lets only Site admins import Policy"; `memory-selection.db.test.ts` "Policy first, pinned next", "Workspace memory off leaves Policy only"; `memory-switches.db.test.ts` "Policy reaches a Workspace that opted out of Site memories"; `memory-checks.db.test.ts` "Policy conflict" (blocks a contradicting save until saved anyway, audited); sandbox-agent `memory/semantic-context.test.ts` (render order); browser `memory-consoles.spec.ts` (Policy toggle + Undo) | db/unit green; browser spec on gate1: passed. Approve/merge/reject of Site proposals is Phase C (U44/U45 rest)                                                                                                |
| **U48** Memories in context (owner-only)            | The context viewer and Session info list the memories the latest run was given, with versions; changes apply from the next run; stickiness                                                                        | `memory-selection.db.test.ts` "GET /v1/threads/{id}/context/memories" (owner sees per lane in render order; 403 `not_owner` for a shared reader, 404 for others; latest run while a newer one is queued), "re-picks for each message", every given item recorded with its version; server `memory/items/select.test.ts` "keeps items of the thread's previous run (stickiness)"; web `context-viewer.test.tsx` (3 memory cases), `pi-commands.test.tsx` "/session counts the memories ... for the owner only", `lib/chat/context-memories.test.ts`                                                             | db/unit green. **No browser spec** covers the context viewer's memory list or Session info: checked on gate1 via the API (passed)                                                                             |
| **U49** retention, holds, offboarding, break-glass  | SM28 retention table; legal holds per scope; offboarding; Site-level break-glass for portable preferences with audit fan-out to every Workspace of the person                                                     | `semantic-memory-retention.db.test.ts` (26: Workspace and Site/portable sweeps, holds, stale, offboarding 30 days, deactivation); `site-legal-hold.db.test.ts` (11, Site-wide hold, two-person); `legal-hold.db.test.ts` (10); `site-break-glass.db.test.ts` (7: two site admins, reads audited everywhere, expiry/revocation); `offboarding.db.test.ts` (18); `memory-items-export.db.test.ts` (5, personal export); `@kobe/db` `semantic-memory.db.test.ts` (hold guards), `site-legal-hold-upgrade`, `site-break-glass-upgrade`; web `legal-hold-page.test.tsx`, `portable-break-glass-page.test.tsx`       | db/unit green; no browser spec (admin flows need two site admins; not required)                                                                                                                               |
| **U51** Notes unchanged                             | Notes, `remember` and `recall(path)` unchanged in the Notes tab; one bar icon and `/memory` remain; release notes cover the master-switch widening                                                                | `memory.db.test.ts` (12, Notes docs, versions, Undo); `memory-agent.db.test.ts` (19, remember/recall over the wire); `memory-search.db.test.ts` (5); `memory-retention.db.test.ts` (9); sandbox-agent `kobe-tools/memory-tools.test.ts`, `memory-hooks.test.ts`, `tools/memory-broker.test.ts`, `memory/context.test.ts`; `memory-switches.db.test.ts` "the master switch turns off Notes and Memories; Memories off keeps Notes", "Notes and stored settings survive every switch off"; web `my-memories.test.tsx` (Memories/Notes tabs, one title), `lib/shell/slash.test.ts` (`/memory`)                    | db/unit green. **Gap:** no release notes file in the repo; the master-switch widening is written only in the guide (`docs/guide/memory.md`, Switches). Its line "Memories arrive with Kobe v1.3" is now stale |

### ac-2: numbers

Cache-read share: before 91.2% / after 26.1% (turns 2-20: 94.3% / 27.2%), see "Results" above;
a regression with a proposed fix. FTS recall@8:
0.573 overall (see "Relevance" above; the decision for Phase D is Gate A's).

### ac-3: schema, per-agent setting, exclusions, Q7

| Item                                                                                                                                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Status                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog check on the split tables (no mixed nullable `team_id`, GIN only on non-RLS tables, no SECURITY DEFINER, ENABLE + FORCE on team tables) | `@kobe/db` `semantic-memory-upgrade.db.test.ts` (forced RLS on Workspace tables, site-wide tables without `team_id`, no SECURITY DEFINER, GIN only on portable/Site version tables), `catalog.db.test.ts` (every team table: ENABLE + FORCE, `team_id uuid NOT NULL`, no SECURITY DEFINER anywhere); the read-only SQL below, green on the dev schema at `63c6549f`                                                                                                                     | db tests green; gate1 run: green (below)                                                                                                                                    |
| Memory setting per agent version (all / Notes only / off)                                                                                       | `agent-memory-setting.db.test.ts` (9: API, new version on change, audit, publish/rollback carry-over, refusals, personal agents; run assembly per setting with the runner's memory; off refuses memory frames end to end); `@kobe/db` `agent-version-memory-upgrade.db.test.ts`; server `agents/run-memory.test.ts`; `memory-selection.db.test.ts` "honours the agent version's memory setting"; web `memory-setting.test.tsx`                                                          | green                                                                                                                                                                       |
| Exclusions: evals, eval cases, agent-creator test chats                                                                                         | `memory-selection.db.test.ts` "exclusions" (no block for an agent without `semantic_memory`; none in a builder test chat); `agent-memory-setting.db.test.ts` "a test chat ... never gets semantic memory"; `run-memory.test.ts` "a skill eval gets none whatever the setting"; `skill-eval-runner.db.test.ts` "denies and records a call to the member's memory: the eval leaves nothing behind"                                                                                        | green. Agent evals (Orbit jobs) send no `run.start` at all (KOBE-382 ledger), so there is nothing to exclude and no test of its own; eval cases are stored copies, not runs |
| Q7: portable memories survive deactivation, return on reactivation                                                                              | `semantic-memory-retention.db.test.ts` "deactivation": "keeps portable items through SCIM deactivation and restores them unchanged on reactivation by the same source", "a JIT duplicate account starts with no portable memories", "purges portable items only on a site admin's purge of a deactivated account, never under a hold", typed-email confirm, refused under a Site-wide hold; offboarding "Workspace and portable items stay"; `scim.db.test.ts` (23, reactivation rules) | green                                                                                                                                                                       |

ac-4 (Gate 1 and Gate 2 shards on the same commit) is CI's, recorded with the gate PR.

## Catalog check

Read-only (one `READ ONLY` transaction, rolled back). It lists the split tables with their
`team_id`, RLS and policy state, then the violations; green is a summary row of zeros. The
whole-schema INFO queries show the documented site-wide exceptions (`budget_alerts` with a
nullable `team_id` under RLS, and `teamReferencing` tables such as `break_glass_grants` and
`legal_holds` that carry `team_id` without RLS); they are context, not failures. Run as
`psql "$URL" -X -v ON_ERROR_STOP=1 -f gate-a-catalog.sql`.

```sql
-- Gate A (KOBE-388) catalog check on the v1.3 semantic memory split tables. READ-ONLY.
-- Run as any role that can read pg_catalog, e.g.
--   psql "$URL" -X -v ON_ERROR_STOP=1 -f gate-a-catalog.sql
-- Green = every VIOLATION query returns 0 rows and the summary is all zeros (INFO queries are context) and the inventory shows team tables with
-- team_id NOT NULL + ENABLE + FORCE RLS + >=1 policy, site tables with no team_id and no RLS.
\pset pager off
BEGIN TRANSACTION READ ONLY;

-- The table list lives in transaction-local settings (read-only transactions allow SET LOCAL).
-- Workspace (team) tables: packages/db/src/tenancy/memory.ts + workspace.ts (team_memory_settings).
SET LOCAL gate_a.team = 'semantic_memory_items,semantic_memory_item_versions,run_memory_items,run_portable_memory_items,run_site_memory_items,memory_stewards,memory_reminders,team_memory_settings';
-- Site-wide tables: no team_id, no RLS; the server filters, app-role grants only.
SET LOCAL gate_a.site = 'portable_memory_items,portable_memory_item_versions,site_memory_items,site_memory_item_versions,site_legal_holds,site_break_glass_grants,site_break_glass_notifications';
-- memory_curators was dropped by the 2026-11-12 amendment (stewards instead): it must NOT exist.
SET LOCAL gate_a.absent = 'memory_curators';

\echo '== 1. Inventory of the split tables'
SELECT t.name, t.expected,
       c.oid IS NOT NULL                                   AS exists,
       a.attname IS NOT NULL                               AS has_team_id,
       CASE WHEN a.attname IS NULL THEN NULL ELSE a.attnotnull END AS team_id_not_null,
       c.relrowsecurity                                    AS rls_enabled,
       c.relforcerowsecurity                               AS rls_forced,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
       CASE
         WHEN t.expected = 'absent' THEN CASE WHEN c.oid IS NULL THEN 'ok' ELSE 'FAIL: should be dropped' END
         WHEN c.oid IS NULL THEN 'FAIL: missing'
         WHEN t.expected = 'team' AND a.attnotnull AND c.relrowsecurity AND c.relforcerowsecurity
              AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid) THEN 'ok'
         WHEN t.expected = 'team' THEN 'FAIL: team table needs team_id NOT NULL + ENABLE + FORCE + policy'
         WHEN t.expected = 'site' AND a.attname IS NULL AND NOT c.relrowsecurity THEN 'ok'
         ELSE 'FAIL: site table carries team_id or RLS'
       END AS verdict
FROM (SELECT unnest(string_to_array(current_setting('gate_a.team'), ',')) AS name, 'team' AS expected
   UNION ALL SELECT unnest(string_to_array(current_setting('gate_a.site'), ',')), 'site'
   UNION ALL SELECT unnest(string_to_array(current_setting('gate_a.absent'), ',')), 'absent') t
LEFT JOIN pg_class c ON c.relname = t.name AND c.relnamespace = 'public'::regnamespace
                     AND c.relkind IN ('r', 'p')
LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'team_id' AND NOT a.attisdropped
ORDER BY t.expected, t.name;

\echo '== 2. VIOLATION: split table with a nullable team_id and RLS enabled (expect 0 rows)'
SELECT c.relname AS table_name
FROM pg_class c
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'team_id' AND NOT a.attisdropped
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
  AND c.relrowsecurity AND NOT a.attnotnull
  AND c.relname IN (SELECT unnest(string_to_array(current_setting('gate_a.team') || ',' || current_setting('gate_a.site'), ',')))
ORDER BY 1;

\echo '== 2b. INFO: same over the whole public schema (budget_alerts is the documented teamReferencing exception, KOBE-42)'
SELECT c.relname AS table_name
FROM pg_class c
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'team_id' AND NOT a.attisdropped
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
  AND c.relrowsecurity AND NOT a.attnotnull
ORDER BY 1;

\echo '== 3. VIOLATION: GIN index on an RLS-enabled table (whole public schema; expect 0 rows)'
SELECT t.relname AS table_name, i.relname AS index_name, pg_get_indexdef(i.oid) AS def
FROM pg_index x
JOIN pg_class i ON i.oid = x.indexrelid
JOIN pg_class t ON t.oid = x.indrelid
JOIN pg_am am ON am.oid = i.relam
WHERE am.amname = 'gin' AND t.relnamespace = 'public'::regnamespace AND t.relrowsecurity
ORDER BY 1, 2;

\echo '== 3b. For reference: GIN indexes on the split tables (expect only portable/site *_version tables)'
SELECT t.relname AS table_name, i.relname AS index_name, t.relrowsecurity AS rls_enabled
FROM pg_index x
JOIN pg_class i ON i.oid = x.indexrelid
JOIN pg_class t ON t.oid = x.indrelid
JOIN pg_am am ON am.oid = i.relam
WHERE am.amname = 'gin' AND t.relname IN (SELECT unnest(string_to_array(current_setting('gate_a.team') || ',' || current_setting('gate_a.site'), ',')))
ORDER BY 1, 2;

\echo '== 4. VIOLATION: SECURITY DEFINER functions outside system schemas (expect 0 rows)'
SELECT n.nspname AS schema, p.proname AS function, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
ORDER BY 1, 2;

\echo '== 5. VIOLATION: split team tables missing ENABLE or FORCE RLS (expect 0 rows)'
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
  AND c.relname IN (SELECT unnest(string_to_array(current_setting('gate_a.team'), ',')))
  AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
ORDER BY 1;

\echo '== 5b. INFO: public tables with team_id NOT NULL but no ENABLE+FORCE (site-wide tables allowlisted in packages/db/src/tenancy teamReferencing, e.g. break_glass_grants, legal_holds)'
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'team_id' AND NOT a.attisdropped AND a.attnotnull
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
  AND NOT c.relispartition
  AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
ORDER BY 1;

\echo '== 6. Policies on the split team tables (expect current_setting(''kobe.team_id'') in each)'
SELECT c.relname AS table_name, p.polname, pg_get_expr(p.polqual, p.polrelid) AS using_expr
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
WHERE c.relname IN (SELECT unnest(string_to_array(current_setting('gate_a.team'), ',')))
ORDER BY 1, 2;

\echo '== Summary (all zeros = green)'
SELECT
  (SELECT count(*) FROM pg_class c
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'team_id' AND NOT a.attisdropped
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
      AND c.relrowsecurity AND NOT a.attnotnull
      AND c.relname IN (SELECT unnest(string_to_array(current_setting('gate_a.team') || ',' || current_setting('gate_a.site'), ','))))      AS split_nullable_team_id_with_rls,
  (SELECT count(*) FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
     JOIN pg_class t ON t.oid = x.indrelid JOIN pg_am am ON am.oid = i.relam
    WHERE am.amname = 'gin' AND t.relnamespace = 'public'::regnamespace
      AND t.relrowsecurity)                                                    AS gin_on_rls_tables,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%')    AS security_definer_functions,
  (SELECT count(*) FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
      AND c.relname IN (SELECT unnest(string_to_array(current_setting('gate_a.team'), ',')))
      AND NOT (c.relrowsecurity AND c.relforcerowsecurity))                    AS split_team_tables_without_enable_force,
  (SELECT count(*) FROM (SELECT unnest(string_to_array(current_setting('gate_a.team'), ',')) AS name, 'team' AS expected
   UNION ALL SELECT unnest(string_to_array(current_setting('gate_a.site'), ',')), 'site'
   UNION ALL SELECT unnest(string_to_array(current_setting('gate_a.absent'), ',')), 'absent') t
     LEFT JOIN pg_class c ON c.relname = t.name AND c.relnamespace = 'public'::regnamespace
                          AND c.relkind IN ('r', 'p')
     LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'team_id' AND NOT a.attisdropped
    WHERE NOT CASE
      WHEN t.expected = 'absent' THEN c.oid IS NULL
      WHEN c.oid IS NULL THEN false
      WHEN t.expected = 'team' THEN coalesce(a.attnotnull, false) AND c.relrowsecurity
           AND c.relforcerowsecurity AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
      ELSE a.attname IS NULL AND NOT c.relrowsecurity END)                     AS split_table_inventory_failures;

ROLLBACK;
```

**Dev schema** (`63c6549f`, migrations to `0227`, 2026-11-15): summary
`0 | 0 | 0 | 0 | 0` (16 tables in the inventory all `ok`; `memory_curators` absent; GIN only on
`portable_memory_item_versions` and `site_memory_item_versions`, trgm + tsv; every Workspace
table's policy on `current_setting('kobe.team_id')`).

**gate1** (2026-11-15, `63c6549f`, read-only, rolled back): green.

| Check                                  | Result |
| -------------------------------------- | ------ |
| split_nullable_team_id_with_rls        | 0      |
| gin_on_rls_tables                      | 0      |
| security_definer_functions             | 0      |
| split_team_tables_without_enable_force | 0      |
| split_table_inventory_failures         | 0      |

Informational: tables with a `team_id NOT NULL` column but no RLS are the allowlisted site-wide
ones (`break_glass_grants`, `legal_holds`, `session_active_teams`, `sso_access_mappings`,
`user_last_teams`).

## Cache results

- Model / provider: `glm-5.3-flash`, Ollama Cloud through the gateway.
- Before build / thread: `d7dfb763c162` / `33926e48-4214-4bd1-94d0-f854d4e44341`.
- After build / thread: `63c6549faa54` / `0bd91d16-1936-4050-bfe9-e55c7854e577` (the member's
  sandbox confirmed on the new sandbox image before the replay: it only takes a new image on a
  wake, so it was left to hibernate first).
- Share (all turns), share (turns 2-20): before 91.2% / 94.3%; after 26.1% / 27.2%.
- Reading: see "Results". Harness notes for the next run: set `KOBE_EVAL_TEAM_ID` when the member
  is in more than one Workspace (the seed's Workspace and personal rows need it), and give
  `KOBE_EVAL_MODEL` as the team's alias (`glm-5.3-flash`), not the gateway's `ollama/...` name.

**Selector speed (KOBE-382 ac-4, strict).** `KOBE_PERF_STRICT=1` on an idle dev VM against the dev
Postgres (~2.5 ms RTT), 4 runs, all green; last: p50 28.1 ms, **p95 39.9 ms**, max 52.8 ms (block
37 items, 8,119 B). The earlier 47-84 ms were measured with other agents' test runs on the same
4 CPUs.

## Browser specs on gate1

2026-11-15. Build on gate1: `local-63c6549faa54`. Run from the Playwright runner
(`npx playwright test <spec>`), Memories switches on for `KOBE_USER`'s active Workspace.

| Spec / check                                                                                          | Stories | Result                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory-editor.spec.ts` (add, edit, pin, archive, restore, Undo, portable confirmation)               | U40     | passed (after the spec fix below)                                                                                                                                                         |
| `memory-consoles.spec.ts` (curator import preview)                                                    | U43     | passed (after the spec fix below)                                                                                                                                                         |
| `memory-consoles.spec.ts` (Site admin Policy toggle + Undo)                                           | U45     | passed (after the spec fix below)                                                                                                                                                         |
| By hand: context viewer "Memories in context" and `/session` for the owner; a shared reader sees none | U48     | API check: owner `GET /v1/threads/0bd91d16.../context/memories` 200 with the latest run's 12 items (Policy first); member2 404 `thread_not_found`. UI rendering covered by web unit tests |
| By hand: a portable preference saved in Workspace A shows in a run in Workspace B                     | U40     | not run by hand; db-proven (`memory-selection.db.test.ts`)                                                                                                                                |
| `connector-panels.spec.ts`, `site-team-members.spec.ts` (regression)                                  | —       | passed                                                                                                                                                                                    |

First run: 4 passed, 3 failed, all three spec faults, no app change: the specs stamped statements
with `Date.now()`, which the save checks rightly flag as a phone number (import preview "0 to
import", Policy save stopped at "Check this before saving"), and `getByText('Pinned.')` matched
each group's "0 of 10 pinned." line. Fixed with random letter-only statements and exact status
matches (`support/unique.ts`).

## Decisions for Chris (Gate A)

1. **Phase D vectors.** FTS recall@8 is 0.573 (< 0.85): literal 0.980, indirect 0.725, paraphrase
   0.139. In 43 of the 53 missed paraphrase queries no expected item was even a candidate (no
   shared word), so neither trigram weighting nor trigram candidates can reach them. Recommendation:
   proceed to Phase D vectors (KOBE-408/409) as the spec rule says.
2. **Prompt cache.** The cache-read share fell from 91.2% to 26.1% because the per-message picks
   sit in the system prompt (see "Results"). Recommendation: a follow-up ticket before Phase B that
   moves the per-message parts into the newest user turn, then re-measure with this harness.
3. **Not done at this gate:** the KOBE-657 tall-app check in the artifact column on gate1 (unit
   tested; needs an MCP App that reports a tall height), and the by-hand portable A→B run (db-proven).
