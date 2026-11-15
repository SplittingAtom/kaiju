# KOBE-658: Memory placement Site setting (restore prompt caching after Gate A)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in progress (local commits on `kobe-658-sm`; coordinator pushes and opens the PR)
- **Branch / worktree:** `kobe-658-sm` in `../Kobe-wt658`
- **Depends on:** KOBE-383, KOBE-387 (done); `tool_only` waits for KOBE-399

## Plan

1. Protocol (additive): `semantic.placement` (five modes), item `held`, capability
   `semantic_memory_placement`; held picks get their own fence in the byte count.
2. Server: Site settings `placement` (default `latest_user_keep`) and `stable_repick_every`
   (default 20) in the `memory.settings` key/value document (no migration); applied after the
   selector (`memory/items/placement.ts`); records = payload in every mode.
3. Sandbox agent: render per mode (`semantic-context.ts`), memory file carries `held` and
   `picks_placement`; kobe-tools puts the picks note before the run's user message.
4. Web console select, admin MCP read tool, guide + /llms.txt, harness per mode.

## Decisions

- **Picks travel as a Pi custom message added in the `context` hook, never stored in the
  session.** Pi 1.4's `before_agent_start` `message` would persist the note into the session and
  so into `thread_entries` (mirrored, KOBE-290): owners' personal memories in thread history,
  visible to shared readers' payloads and kept after a memory is deleted. Instead kobe-tools binds
  each run's note to the run's user message (by its timestamp, created right after
  `before_agent_start`) in process memory and re-inserts it before that message on every request,
  byte for byte. A new Pi process (sandbox wake, launch change) loses older notes: one uncached
  request, like the per-process fence key. Capped at 256 notes per Pi.
- The note goes **before** the user message (the person's text stays last).
- Coordinator 2026-11-15: in every mode but `system` the viewed file and sync conflicts join the
  picks in the per-message note (same binding, never stored); `tool_only` too (no picks). A run
  with no semantic memory at all (Site master off) has no placement and keeps them in the prompt.
- Audit of the rest of the system prompt: Pi's base prompt has no date/time; cwd, skills, tool
  guidance and the agent addendum (written once per launch) are stable; the fence nonce is per
  thread (rotates only with a new agent process); budget and file lists are not in it. The Notes
  index section changes only when notes change (after `remember` or an edit), not per turn: left.
- Coordinator accepted: notes kept in process memory, held-set refresh on edit, 768 B overhead.
- With picks in messages the preamble says where blocks count ("here and in a 'What Kobe knows
  for this message' note"; Policy only in the system prompt), and kobe-tools neutralises memory
  markers in user messages for the request (as tool results, KOBE-383 M1). `system` mode keeps
  the KOBE-383 preamble byte for byte.
- `SEMANTIC_MEMORY_RENDER_BLOCK_OVERHEAD_BYTES` 640 → 768: the longer preamble plus the held
  header measured 745 (test `semantic-placement.test.ts`). The selector fills 128 B less.
- **stable_plus_delta is stateless:** the epoch run is the message run at index `k - k mod N` of
  the thread (creation order); the held set is that run's recorded picks at **current** versions,
  still active and in a lane the switches allow. So an edited/archived held item changes the held
  set once (refresh, not a full re-pick); no table or column needed. Delta = picks the held set
  lacks, kept per message (keep semantics). Over the Site budget, delta is trimmed from the end
  first, then held; omitted count says so.
- `tool_only`: accepted by the setting; `TOOL_ONLY_AVAILABLE = false` in `placement.ts` makes the
  server send `latest_user_keep` and log once; the console offers it only while stored. KOBE-399
  flips the flag (and the payload then carries no picks, already implemented and tested).
- Older sandbox images (no capability) get `system` and no new fields (strict schemas).
- Admin MCP: new read-only `site_memory_settings_get` (`site.settings.manage`).

## Open questions (for Chris or the coordinator)

- Default stays `latest_user_keep` until the gate1 numbers are in (ac-3).

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/memory/switches.test.ts` (modes, default, range),
  `memory-switches.db.test.ts` "memory placement setting" (API save/validate/audit),
  `memory-selection.db.test.ts` "memory placement" (capability gate, tool_only fallback),
  `apps/web/components/admin/memory-switches.test.tsx` (select, tool_only hidden),
  `kobe-mcp/site-tools.test.ts` + `kobe-mcp-site.db.test.ts` (read tool contract).
- ac-2: `services/sandbox-agent/src/kobe-tools/memory-placement.test.ts` (real render → real file
  JSON → hooks, 4 turns with picks, viewed file and a sync conflict changing: system prompt byte-identical in keep/strip/stable_plus_delta/tool_only,
  Policy and pinned in it; keep is a request prefix; strip; delta), `memory/semantic-placement.test.ts`
  (fences, one header per part, cap across parts, server byte count holds per mode),
  `memory-selection.db.test.ts` (records equal the payload per run incl. held set; redelivery).
- ac-3: harness `KOBE_EVAL_PLACEMENTS=… e2e/memory-eval.sh cache` (docs/gates/gate-7a.md
  "Memory placement replay"); numbers to be measured on gate1 by the coordinator after deploy.
- ac-4: docs/guide/memory.md "Memory placement", admin/site-admin.md,
  admin/admin-from-a-conversation.md (/llms.txt is generated from the guide pages).
