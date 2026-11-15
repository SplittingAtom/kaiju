# KOBE-390: SMB2 contract — memory_learn purpose, limits, extractor schema, pass events

- **Status:** in review (commit on `kobe-390-sm`; coordinator opens the PR)
- **Branch / worktree:** `kobe-390-sm` in `../Kobe-wt390`
- **Depends on:** KOBE-388 (Gate A, approved)

## Plan

Contract only, in `packages/protocol`: `memory_learn` token purpose + limits + response format +
`pass_id` claim; extractor output schema (zod + strict JSON schema + parser); three pass events.
Glue needed for the monorepo to typecheck, nothing more: gateway soft-limit label, a fail-closed
purpose guard, web `live.ts` switch cases.

## Decisions

- `memory_learn` is appended to `SERVER_CALL_TOKEN_PURPOSES` only (not the epilogue list, not
  run-less). Its token names `pass_id` (uuid, `memory_learning_passes.id`) and the leaf's last
  completed run + thread; no other purpose may carry `pass_id` (`PASS_SERVER_CALL_PURPOSES`,
  `serverCallNamesPass`). TTL stays under the shared 30 s cap (no 180 s token).
- Limits (`SERVER_CALL_LIMITS.memory_learn`, typed by the new exported `ServerCallLimit`):
  output 8192 / reasoning 16,384, timeout 60 s, skip at 100 %, 300,000 chars per message, 384 KiB
  body, temperature 0; ≤4 messages via the shared cap. One retry on schema reject
  (`MEMORY_LEARN_SCHEMA_RETRIES`). `serverCallOutputCapFor(purpose, reasoning, catalogMax)` clamps
  to `model_catalog.maxOutputTokens`. `MEMORY_PASS_MAX_MS` = 60 s × 2 + 30 s = 150 s (pass-event
  append window).
- Response format `memory_extractor` (`MEMORY_EXTRACTOR_RESPONSE_SCHEMA`, strict subset: all
  required, nullable `target_id` by type). Cross-field rules live in the zod schema:
  `target_id` null iff `add`; `inferred` ⇒ `suggested_scope: user`; `portable` ⇒ `user`.
- `suggested_scope` is `user | team` (never `site`; a Team admin moves things to the Site);
  a portable preference is `user` + `portable: true`. Interpretation of the brief's separate
  `suggested_scope` and `portable` fields.
- Caps chosen here (brief silent): ≤20 candidates, rationale ≤500, skill hint `{title ≤80,
summary ≤300}`. Evidence `{entry_id, quote ≤200}` matches what `quotesOf` (KOBE-649) reads.
- Pass events `memory.pass.progress|completed|failed` are Kobe event types written to the pass's
  bound run after its terminal event — not an epilogue. Failure codes: budget_exhausted,
  learning_model_unavailable, memory_disabled, schema_rejected, timeout, model_error, cancelled.
- Audit names already reserved in `RESERVED_MEMORY_AUDIT_ACTIONS` (KOBE-376); referenced, not
  duplicated.
- No model named anywhere (test asserts it); the learning model is a Site setting with Workspace
  override, resolved by the server.
- Purpose list stays easy to extend (KOBE-409 `memory_embed` later): append, the compiler then
  demands the limits entry, the gateway label, and `run_usage.kind`.
- **Gateway fail-closed:** `run_usage.kind` (packages/db `USAGE_KINDS` + CHECK) has no
  `memory_learn` yet and this ticket must not touch packages/db, so the gateway now refuses any
  purpose that is not a usage kind (403 `server_call_purpose_unsupported`, new
  `services/model-gateway/src/usage/kind.ts`). Without it a `memory_learn` call would reach the
  provider and its usage row would fail the DB check (test shown red first).

## Open questions (for Chris or the coordinator)

- Who adds `memory_learn` to `USAGE_KINDS` + the `run_usage_kind` CHECK migration (KOBE-389 or
  the gateway/server ticket)? Until then the gateway refuses the purpose.
- The server's append guard (`epilogueOpen`/`decideStreamOpen`, sse.ts) must admit pass events
  after a terminal event and keep the stream open within `MEMORY_PASS_MAX_MS`: server ticket.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `packages/protocol/src/semantic-memory/learning.test.ts`: golden
  `extractor-output*.json`, 12 `extractor-invalid-*.json` (each rule), fenced/plain parser,
  JSON schema in step with zod, pass-event envelope fixtures `pass-*-event.json`.
- **ac-2** `server-call.test.ts` "memory_learn purpose (KOBE-390)": token purposes only, run-bound,
  not in an epilogue, `pass_id` rule, 30 s TTL, limits, catalog clamp, token size cap.
  `SERVER_CALL_LIMITS`/`ServerCallLimit`/`serverCallOutputCapFor` exported.
- **ac-3** `server-call.test.ts` "existing purposes are unchanged": exact limits of title,
  followups, eval_judge, skill_manifest; epilogue window 30 s; old claims still valid.
- Gateway: `services/model-gateway/src/server-call.test.ts` "refuses a memory_learn token…".
