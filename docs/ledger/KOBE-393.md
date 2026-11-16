# KOBE-393: SMB5: learning pass execution, validation and candidates

- **Status:** in review (commits on `kobe-393-sm`; coordinator opens the PR)
- **Branch / worktree:** `kobe-393-sm` in `../Kobe-wt393` (based on `kobe-392-sm`)
- **Depends on:** KOBE-389 (tables), KOBE-390 (contract), KOBE-391 (gateway, PR #578), KOBE-392
  (pass input, PR #580), KOBE-394 (prompt, screen), KOBE-379 (quote normaliser)

## Plan

Server only, no migration, no protocol change. `services/server/src/memory/learn/`:

- `run.ts`: `createLearningPasses` → `start(viewer, threadId, options)` and `sweep()`; wired as
  `deps.learningPasses` (KOBE-395 adds the route and panel).
- `execute.ts`: the pass on BackgroundTasks (events, call + retry, screen, select, checks, store).
- `validate.ts` (pure): confidence, ≤10 sorted, open/dismissed dedupe, `statementHash`.
- `candidates.ts`: known hashes, A4 save checks per candidate, insert.
- `passes.ts`: pass rows, rate count, stale sweep, bound run, watermark.
- `target.ts`: learning model's gateway id at call time; failure codes and messages.
- `event-stream/append.ts`: guard for `memory.pass.*` events.
- `models/gateway-client.ts`: `passId`, `catalogMaxOutputTokens`, the extractor's
  `response_format`, a 256 KiB reply cap for `memory_learn`.

## Decisions

- **Start checks, in one `withTeam` transaction under the thread change lock:** switches +
  learning model (`learnAvailability`: Workspace alias wins, must be enabled, no fallback) →
  `memory_disabled` / `memory_learning_model_unavailable` with the reason; pass input (392);
  20 passes per person per Workspace per rolling 24 h (`learn_rate_limited`, any outcome counts);
  `exhaustedLine` of the member's lines (`budget_exhausted`, 100 %); bound run; insert.
  No server-call gateway configured → `memory_learning_model_unavailable` reason `server_calls_off`.
- **Bound run (KOBE-391 note):** newest completed run whose `user_entry_id` is on root → leaf,
  leased to the author (`no_completed_run` otherwise). Pass events go to that run.
- **One pass per thread:** `INSERT … ON CONFLICT DO NOTHING` on the 389 partial unique index →
  `pass_running`. No in-process state.
- **Restart:** a `running` pass older than `MEMORY_PASS_MAX_MS` (150 s) is failed with
  `interrupted…` by a server job (`memory-learn-sweep`, at start and every minute, every replica,
  idempotent) and lazily before a new pass on the thread. No replica column exists, so a fresh
  restart's pass shows as running for up to 150 s.
- **Call:** model re-resolved at call time (disabled since start → `learning_model_unavailable`,
  not retryable); structured output only for `openai` providers (judge rule); temperature 0;
  cap clamped to the catalog's `max_output_tokens`. Schema reject or unreadable reply (empty,
  truncated, not a completion) → one retry, then `schema_rejected`. Gateway codes: budget →
  `budget_exhausted`; `model_not_enabled`/`model_blocked` → `learning_model_unavailable`;
  timeout → `timeout`; else `model_error`.
- **Validation order:** parse → `screen.ts` (evidence, person quote, targets, secrets, lint,
  personal data) → `validate.ts` (inferred never shared, confidence < 0.4, already open for the
  person in the Workspace, dismissed in the thread, repeat in reply, >10) → A4
  `evaluateMemoryWrite` in the destination scope (project Notes judged as Workspace): secret or
  invalid drops; warnings, Policy conflicts `{id, version}` and near-duplicates are kept on the
  payload for the reviewer.
- **Dismissal hash:** SHA-256 hex of `normaliseQuote(statement).toLowerCase()` (KOBE-395 must use
  `statementHash` when it writes dismissals).
- **Success transaction:** candidates, `memory.pass.completed` event (before the row update: the
  guard admits only running passes), pass `completed` with `to_entry_id = leaf`, watermark upsert.
  Failure: event + row, or the row alone if the event is refused; the watermark never moves.
- **Pass row `usage`:** model alias, prompt version, attempts, input record (entries, mode,
  truncated, summarised, **partial**, tool outputs, estimated tokens, skipped), counts, skill
  hints (≤2). Tokens and cost are the gateway's `run_usage` row (`kind = memory_learn`).
- **Append guard:** pass events only alone, only after the run's terminal event, only for a
  `running` pass of the run's thread started within `MEMORY_PASS_MAX_MS`, one final event per
  pass, last. The epilogue tail read now skips pass events, so a run stays ended after them.
- **Trace:** span `memory.learn_pass` (model alias, gateway model, prompt version, entries,
  partial, counts, outcome/failure code); the `server_call.memory_learn` span and the gateway's
  span carry the call and its tokens.
- **Audit (`memory/learn/audit.ts`, registered in packages/db `AUDIT_EVENTS`, no migration):**
  `memory.pass.started` (model alias, `extractorVersion`, entries, partial/truncated/summarised) in
  the start transaction; `memory.pass.completed` (replied/stored/dropped/skill hints, attempts) in
  the success transaction; `memory.pass.failed` (`reason`, attempts) with the row update, only when the
  row moved; the stale sweep writes `failed` reason `interrupted` as the system. Team events, actor
  the person. Metadata only; tokens/cost stay on the gateway's `run_usage` row. The db failure
  enum is protocol's codes + `interrupted` (contract test keeps them equal).
- **Not done here:** the HTTP route and panel (KOBE-395/396). **Docs:** none, no user-facing surface yet.

## Open questions (for Chris or the coordinator)

- Rate limit counts per Workspace (RLS); a person in several Workspaces gets 20 in each.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `memory/learn/validate.test.ts` (each rule + every recorded v1 fixture through parse →
  screen → select, adversarial ones leave nothing shared); `screen.test.ts` (KOBE-394);
  db test "drops what is already open … marks Policy conflicts".
- **ac-2** `memory-learn-pass.db.test.ts` "start refusals": no model / not enabled (no pass row,
  no call), Learn off, 21st pass, $0 budget line; "maps a gateway budget refusal"; "fails
  learning_model_unavailable when the model is disabled after the start".
- **ac-3** db tests "a running pass written by another replica refuses a new one", "two replicas
  starting at once", stale sweep.
- **audit** db tests: success (started + completed targets exact, no content), schema_rejected,
  budget_exhausted, stale sweep (`interrupted`, system actor); `semantic-contract.test.ts`.
- **ac-4** db tests "stores screened candidates … streams its events to the run", "records a
  trace …", append guard cases; `models/gateway-client.test.ts` learning pass cases.
