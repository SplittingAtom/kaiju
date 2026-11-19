# Gate 7C: v1.3 Semantic Memory Phase C (Site proposals) verification

Gate C (KOBE-407) proves Phase C: a Workspace raises a memory to the Site in two steps (a Team
admin confirms, then a Site curator decides), and nothing from a conversation crosses the wall but
the confirmed statement and its justification. Spec U44, U45 (with proposals), SM19, SM20, SM22.

Install: gate1 at main `5642c909c769` (`local-5642c909c769`), deployed 2026-11-18 after a database
dump; it also carries Phase D wave D2 (KOBE-410 Learn nudge, KOBE-411 quality flags).

## Checks

| Check                                         | Result                                                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate 1 and Gate 2 shards on one commit (ac-3) | **PASS** on `5642c909c769`: every e2e shard green in merge-queue run 44317512791 (gate1, gate2, gate3, gate4, gate5-a/b, apps, sso, executor, cold start) |
| Wall probe (U44, ac-2)                        | **PASS**: no leak on any read path; the mutation check catches corrupted rows and views (section below)                                                   |
| Site proposals state machine (U44, U45)       | **PASS**: `memory-site-proposals.db.test.ts` 21 tests, `site-memory-proposals.db.test.ts` 12 (schema)                                                     |
| Expiry and reminders (ac-2)                   | **PASS**: `memory-site-proposal-sweeps.db.test.ts` 9 tests                                                                                                |
| Browser spec on gate1                         | **PASS** `site-proposals.spec.ts` (new) twice; memory editor, consoles and Learn from this chat specs green (section below)                               |

## Phase C tickets

| Ticket   | What                                                                                                                                                      | PR   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| KOBE-402 | `site_memory_proposals` table (the only Phase C migration; no evidence, rationale or thread columns, catalog test)                                        | #597 |
| KOBE-403 | Proposal service and API: two steps, request changes (3 rounds), merge, withdraw, provenance by role, audit both sides                                    | #599 |
| KOBE-404 | Workspace side: Propose → Site from To review, Propose to Site on Workspace memories, the To the Site confirmation queue, My memory › Your Site proposals | #602 |
| KOBE-405 | Site console › Memory › Proposals: queue, detail with diffs against Site items and Policy, Approve / Merge / Reject / Request changes                     | #600 |
| KOBE-406 | Wall probe                                                                                                                                                | #601 |
| KOBE-653 | Expiry after 30 days, weekly reminders, Site curators get the notices, holds freeze                                                                       | #603 |

KOBE-403 had an independent Opus security review before its PR: no critical or high findings;
four low findings fixed (switch re-checked at decision time, an id-only Workspace audit entry for
Site decisions, a request-changes note never survives approval, proposal-made Site memories shown
as any other Site memory to non-curators). One is left for the decisions below.

## Acceptance criteria (ac-1)

| Criterion            | What is proven                                                                                                                                                                               | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U44                  | Site proposals need a Team admin's confirmation; the Site reviewer sees statement, kind, justification, Workspace and date only; request changes at most 3 rounds                            | `memory-site-proposals.db.test.ts`: "only Team admins confirm (edit audited); stewards endorse", "request changes sends it back to the Team admins, at most 3 rounds, then decide", "shows proposals by role", "another Workspace's Team admin can't act on a proposal by id"; wall probe (every read path); browser `site-proposals.spec.ts` (detail shows no conversation text)                                                                         |
| U45                  | Site curators approve, merge or reject with a reason; Policy rules (≤25 items, ≤2 KiB, first in every Workspace even with the opt-out, contradicting saves blocked with an audited override) | Proposals: "approves into a Site memory whose only provenance is the proposal; the source stays", "merges into an existing Site memory as its next version", "nobody decides their own; a reason is required to reject", "a Site steward can't approve as Policy, merge into Policy or into an archived memory", "two concurrent approvals make exactly one Site memory"; Policy rules proven at Gate A ([gate-7a.md](gate-7a.md), U45 row) and unchanged |
| Expiry and reminders | 30-day expiry (rounds don't reset it), weekly reminders to the step's deciders, Site curators notified, Site-wide hold freezes, once per event                                               | `memory-site-proposal-sweeps.db.test.ts` (each open state, both steps, holds, two runners)                                                                                                                                                                                                                                                                                                                                                                |

## Wall probe (KOBE-406)

No thread-derived text crosses to the Site (SM20): only the confirmed statement and justification.

- **Probe:** [`services/server/src/site-wall-probe.db.test.ts`](../../services/server/src/site-wall-probe.db.test.ts)
  (server DB test; runs in CI's DB job and in `pnpm verify` with `KOBE_TEST_DATABASE_URL`).
- **Reusable detector:** [`services/server/src/testing/site-wall-probe.ts`](../../services/server/src/testing/site-wall-probe.ts)
  (`SiteWallProbe`, `findLeaks`, `siteTableRows`, `canary`): a case-insensitive search for canary
  strings and ids, plus forbidden fields (`evidence`, `quote`, `rationale`, `source_thread_id`,
  thread/entry/run/pass/candidate ids) with a value, over every string and key of every value.
- **Seed:** two threads with canaries in the person's message, the evidence quote, the assistant's
  answer, a tool's output and the candidates' rationale, canary entry ids, and their thread, run,
  pass and candidate ids; real learning passes (scripted extractor) make the candidates.
- **Entry points:** Propose → Site from a candidate; Propose to Site from a Workspace memory saved
  from a candidate (its version keeps the thread link); confirm with edit; request changes and
  confirm again; approve (edited); merge; reject.
- **Read paths:** every `site_memory%` table's rows; the Site console queue (each state), detail
  and provenance for Site admins and Site stewards; the Workspace proposal list and detail; Site
  item list, detail and provenance for members and another Workspace's Team admin; run context
  (selector and recall) of a member's run; admin MCP `site_memory_items_list` /
  `site_memory_item_get` (KOBE-650) through the executor's delegated route call; the Site memory
  export (JSON and CSV, inactive included); notifications (rows, digest, swept reminders, email
  rows, the bell API, mail sent); audit entries of these flows (rows and `/v1/site/audit`).
- **Mutation check (ac-2):** the same test corrupts one proposal row (rationale appended) and one
  Site version (evidence quote appended) and asserts the probe reports each read path that shows
  them; a detector test injects an `evidence` field into a view.

## Browser specs on gate1

Run from the Playwright 1.55 container against gate1 at `5642c909c769`:

- **`site-proposals.spec.ts`** (new, owner + member2), two runs passed: member2 states an office
  fact in a no-tools turn, runs Learn from this chat and proposes the candidate to the Site with a
  justification (My memory › Your Site proposals: waiting for a Team admin); the owner confirms it
  with edited wording in Workspace console › Memory › To the Site; in Site console › Memory ›
  Proposals the detail shows statement, kind, justification, source Workspace and date and none of
  the conversation's other text; the owner requests changes, sees it back at step 1 with the note
  (round 2, "1 of at most 3"), confirms again and approves; member2 sees the confirmed wording as a
  Site memory with no Workspace named and the proposal as Approved. Light and dark screenshots of
  the Site detail and the To the Site tab are attached to the run. The Site memory is archived at
  the end.
- `memory-editor.spec.ts`, `memory-consoles.spec.ts` (owner): 3 passed.
- `learn-from-chat.spec.ts` (member2): passed.

Writing the spec showed the extractor screen at work on the real model: a first draft stated an
"office code phrase", and the pass returned no candidate (a code phrase reads as a secret, which
is never learned, U46). The spec now states a meeting room's name.

## Decisions for Chris

Answered 2026-11-18 and 2026-11-19.

| #   | Question                                                                 | Answer                                         | Follow-up |
| --- | ------------------------------------------------------------------------ | ---------------------------------------------- | --------- |
| 1   | A legal hold guards the Workspace-delete cascade on Site proposals?      | Yes (no server path deletes a Workspace today) | KOBE-665  |
| 2   | Bar the confirming Team admin from deciding at step 2?                   | Yes                                            | KOBE-666  |
| 3   | Is `/v1/site/audit` (Workspace thread/candidate ids) inside SM20's wall? | Yes: hide them from the Site view              | KOBE-666  |
| 4   | Reminders weekly or once?                                                | Once per step                                  | KOBE-666  |
| 5   | Curators in no Workspace get no bell notices                             | Accepted                                       | —         |
| 6   | Team admins promoted mid-step get no reminder                            | Accepted                                       | —         |
| 7   | "Members may propose to the Site" default                                | Keep on                                        | —         |
| 8   | Merge target picker: first 100, no search                                | Later                                          | KOBE-667  |
| 9   | A "Set by the Site" label for members                                    | Add it                                         | KOBE-670  |

Gate B questions answered at the same time ([gate-7b.md](gate-7b.md#decisions-for-chris)):

| Question                                                              | Answer             | Follow-up |
| --------------------------------------------------------------------- | ------------------ | --------- |
| Licences: pgvector; ffmpeg/curl in the llama.cpp image                | Approved           | #609      |
| Site-wide hold freezes Workspace learning records?                    | No                 | —         |
| Purge decided proposals and suggestions by age?                       | Proposal requested | pending   |
| Stale and swept suggestions share `expired`                           | Separate states    | KOBE-668  |
| "New" hint on Learn per browser                                       | Accepted           | —         |
| Approved proposal recorded as the curator's write                     | Accepted           | —         |
| Screen accepts nonce-prefixed entry ids?                              | Proposal requested | pending   |
| Capability rule may drop genuine business facts                       | Accepted           | —         |
| Archived memory stays in earlier notes until the sandbox restarts     | Accepted           | —         |
| Embedding service: no API key, open CORS, gateway-only network policy | Keep               | —         |
| Saving the embedding model without an active Workspace builds nothing | Fix                | KOBE-669  |
| Workspace-level Learn nudge switch (Gate D)                           | No                 | —         |
| Quality signals for portable preferences (Gate D)                     | No                 | —         |
