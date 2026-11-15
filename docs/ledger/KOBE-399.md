# KOBE-399: SMB11: recall over items and show_memory_item (Open in Memory chip)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (branch ready, not pushed)
- **Branch / worktree:** `kobe-399-sm` in `../Kobe-wt399`
- **Depends on:** KOBE-382, KOBE-383 (merged)
- **Migrations:** none

## Plan

1. Protocol (own commit): `recall` answers may carry `items` (≤ 8 semantic items, additive);
   `show_memory_item({ id })` tool, `memory.show` kobe-tools op and wire frame, answered by
   `memory.result` `op: "show"`; `MEMORY_TOOLS` gains it (so `off` denies it with the others);
   `BUILTIN_TOOLS.show_memory_item` (risk read).
2. Server: `memory/items/recall-items.ts` (`recallItems`, `showItem`), `readRecallRows` in
   `items/run-memory.ts` (the selector's lane query in a `recall` mode: matched items only, Policy
   ranked like a lane), `readMemory` adds items, `showMemory`, connection `memory.show` handler,
   `memory/recalled.ts` (per-connection, per-run ids a recall answered), `BOUND_TOOLS`.
3. Sandbox agent: `show_memory_item` tool, recall renders saved memories first (fenced, labelled
   with the Workspace wording, kind, provenance, id), reply parsing, broker + agent routing,
   memory hooks list/neutralise it like `recall`, `remember` guideline line about Learn.
4. Web: "Open in Memory" chip under a successful `show_memory_item` call
   (`/me/memory?item=<id>`); My memory shows that item first ("Opened from a conversation") with
   Archive and the page's Undo; Workspace/Site items read-only there.
5. Docs: guide `memory.md` (recall, show, Forget a memory), `for-agents/working-in-a-sandbox.md`,
   `for-agents/concepts.md`; /llms.txt follows the guide summaries.

## Decisions

- Items come back only for `recall({ query })` **without** `scope`: `scope` names a Notes scope
  (`user|project`), so a scoped query and every path read stay Notes only (ac-1).
- Ranking is the selector's relevance (A7: `ts_rank_cd + 0.3 trigram + 0.1 recency`) without the
  preference base or stickiness: recall answers the question asked. Only items whose statement
  matches a query word (full text) count, as for the per-message picks. Top 8.
- Recall over items is standalone (works whatever the context carried), so KOBE-658's
  `tool_only` placement can rely on it. Gate is `readRunMemoryPlan(...).semantic` plus the
  Workspace/Site switches (`runMemoryStateQuery`), the same rules as `run.start.memory.semantic`.
- `show_memory_item` accepts an id from the run's records (`run_memory_items` & co.) or from an
  earlier recall answer of the same run on the same connection (in memory, bounded 4096, FIFO).
  A reconnect or another replica forgets recalled ids: the agent recalls again (fail closed). No
  migration needed. The item is re-read under the runner's RLS/owner filters and shown with its
  current status (an archived one says so). It writes nothing, not even an audit row; refusals
  that aren't "unknown id" (capability, not allowed, run ended) audit as `sandbox.memory_refused`
  with op `read`.
- The chip is rendered by the web from the call's input under a successful call (the server only
  answers ok for an id this run may show); the id must be a UUID, the link is always
  `/me/memory?item=<id>` and the page re-reads the item with the viewer's own access (tries the
  four scopes unless `&scope=` names one). No new event type.
- Not touched: `services/sandbox-agent/src/context/sections.ts`, `src/memory/semantic-context.ts`
  (KOBE-658), `packages/db` (KOBE-389), server-call contract (KOBE-390). `items/run-memory.ts`
  (KOBE-382's file) gained an optional `mode` on the lane query; `select` mode is unchanged.
- Optional conversation-tree "N memories" badge not done (kept the PR small).

## Open questions (for Chris or the coordinator)

- None blocking. Possible follow-up: persist recalled ids per run if multi-replica reconnects make
  "recall it again" noticeable.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/memory-recall-items.db.test.ts` "recall over saved memories"
  (items of every enabled scope, never others'; path/listing/scoped query Notes only; Workspace
  switch; `notes_only` gives none). Sandbox rendering: `kobe-tools/memory-tools.test.ts`.
- ac-2: same file, "show_memory_item": given and recalled ids shown; random, another person's,
  another Workspace's and never-given ids refused `not_found`; DB snapshot (items, versions, run
  records, audit_log) unchanged. Tool shape: `memory-tools.test.ts`, broker test.
- ac-3: same file, "Forget X through the chip": archive via the API the Memory page uses; same
  run shows it archived; next run's `run.start` and recall no longer have it. Web:
  `components/me/my-memories.test.tsx` (opened item, Archive, Undo), `open-in-memory.test.tsx`.
- ac-4: `docs/guide/memory.md`, `docs/guide/for-agents/working-in-a-sandbox.md`,
  `docs/guide/for-agents/concepts.md` (llms.txt is generated from the guide).
