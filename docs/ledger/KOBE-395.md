# KOBE-395: SMB7: Learn in the + menu, dot/count on +, /learn, /learn all, ⌘⇧L, palette

- **Status:** in review (commits on `kobe-395-sm`; coordinator opens the PR)
- **Branch / worktree:** `kobe-395-sm` in `../Kobe-wt395` (based on `kobe-393-sm`, PR #581)
- **Depends on:** KOBE-393 (learning pass execution)

## Plan

- **Server** (KOBE-393 had no HTTP route): `routes/thread-learn.ts`, mounted under `/v1/threads`:
  `GET /v1/threads/{id}/learn[?estimate=1]` (state) and `POST` `{mode: new|all}` (202 or the
  refusal). `memory/learn/state.ts` reads the state; run.ts exports its messages and
  `serverCalls`. Protocol: `semantic-memory/learn-api.ts` (new types only, nothing changed).
- **Web:** `lib/chat/learn-api.ts` (client, camelized state, indicator/blocker rules),
  `components/chat/use-learn.ts` (state, poll, start, notice), `components/chat/plus-learn.tsx`
  (Memory submenu, + face, command bindings), `plus-menu.tsx` (Memory replaces "Coming soon"),
  composer passes `threadRunning`. Registry command `learn` (`brain-circuit`, `Mod+Shift+L`,
  `/learn`, arg `range`, new `argOptional`), slash.ts runs the bare word of an optional-argument
  command. `?` sheet: a Memory section (the twelve stay twelve).

## Decisions

- **State endpoint:** owner only (403 `read_only` for a shared reader, 404 otherwise). Blockers in
  the start's order without assembling the input: Trash, test/Workbench/eval, no gateway, switches
  and learning model (with reason), no completed run on the leaf path, 20/day, budget at 100 %.
  A running pass (anyone's; one per thread, stale ones ignored) is `running`, not a blocker.
  `new_messages` = leaf ≠ the person's watermark. `candidates` = open, unexpired candidates of the
  person's passes **in this thread** (the + is per chat). `last_failure` = the person's newest
  pass here when it failed, as a sentence (`interrupted` and the failure codes mapped).
- **Estimate** only with `?estimate=1` (the Memory submenu opening): the pass input's own
  `estimatedTokens` for new and rescan, in a separate transaction (it takes the change lock
  briefly; a lock timeout gives null).
- **+ button name stays "Add to your message"** (e2e and unit specs match it exactly); the state is
  the tooltip's second line / accessible description and a mark: spinner (running) > count
  (candidates) > dot (new messages and Learn available).
- **To review** link: `/me/memory?tab=review` (`TO_REVIEW_HREF`): KOBE-396 must accept `tab=review`.
  The count opens it from Memory › Review N candidates (no separate pill button: one target).
- **Refresh:** on thread open, whenever a run on the thread ends, on opening Memory (with the
  estimate), and every 2 s while a pass runs. A pass this tab started or watched ends with a
  notice (found N / the failure's message). No stream subscription: pass events land after the
  bound run's terminal event, which the live reducer drops.
- **One-time hint:** "New" on Memory while Learn can run, until Memory is opened once
  (localStorage `kobe.learn-hint.v1`, per browser rather than per member: no server column).
- **Palette:** Learn from this chat opens its two ranges (new / rescan); `/learn` and Mod+Shift+L
  start new; `/learn all` and Rescan start all. Nothing new → refused locally with the reason.
- **Dismissals / statementHash:** not written here (KOBE-396's candidate actions).
- **Docs:** guide `memory.md` (Learn from this chat section, summary → /llms.txt),
  `chat/composer.md` (+ menu, `/learn`), `reference/keyboard-shortcuts.md` (Mod+Shift+L).
- No OpenAPI entry yet (the thread routes documented there are a fixed list; add with 396's
  candidate routes if wanted).

## Open questions (for Chris or the coordinator)

- Hint per browser, not per member (a member column would need a migration).
- Count is per thread; a person-wide count could go on the rail's My memory instead (396?).

## Evidence (acceptance criteria → test or command output)

- **ac-1** `apps/web/components/chat/plus-learn.test.tsx` (unavailable with reason, dot, spinner,
  count → Review opens To review, New hint, shared reader has no +), `lib/chat/learn-api.test.ts`;
  server `src/memory-learn-route.db.test.ts` (state, blockers, read_only/404).
- **ac-2** `plus-learn.test.tsx` (menu Learn + Rescan, refusal message, pass-ended notice,
  `/learn`, `/learn all`, Mod+Shift+L, palette ranges); `lib/shell/slash.test.ts` (optional arg);
  `memory-learn-route.db.test.ts` (202, pass_running 409, nothing_to_learn 409, 429, all rescans).
- **ac-3** `plus-learn.test.tsx` "on a phone the + still carries the count" (390 px).
- **ac-4** guide pages above. gate1 spec: `e2e/browser/tests/learn-from-chat.spec.ts` (after deploy).
