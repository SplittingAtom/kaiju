# Gate 7: v1.3 Semantic Memory (KOBE-413)

Gate 7 closes v1.3 Semantic Memory: every story U39–U54 proven on k3d and on the real cluster
(gate1), with the four phase gates linked. Spec: the Hadron spec _Kobe v1.3 — Semantic Memory_
(SM1–SM31, amendments 2026-11-12).

## Summary

| Check                                  | Result                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U39–U54 on k3d                         | **PASS**, all 16, `e2e/gate7.sh` in shards `gate7-a` / `gate7-b` (section below)                                                                                                |
| U39–U54 on the real cluster (gate1)    | **PASS**: each story's phase gate on gate1 plus the browser specs re-run on gate1 at `e324bb1f2aee` (section below)                                                             |
| Gate 1 and Gate 2 shards on one commit | **PASS**: every e2e shard green on main `65febf84f4db`, merge-queue run 44557277380 (suite, cold start, gate1–gate5, gate7-a/b, apps, sso, executor, restore; `stories`, `k3d`) |
| Phase gates A–D                        | **Done**: [A](gate-7a.md) (KOBE-388), [B](gate-7b.md) (KOBE-401), [C](gate-7c.md) (KOBE-407), [D](gate-7d.md) (KOBE-412), each approved by Chris                                |

## k3d checks

`e2e/gate7.sh` (KOBE-675) proves U39–U54 on a fresh k3d install, one verdict per story, in CI's
e2e shards `gate7-a` (U39–U46) and `gate7-b` (U47–U54), each on its own cluster after the
`gate1-prep` install. A story passes when its API checks (`e2e/gate7/client.mjs`, run in a server
pod) and its browser checks (Playwright in Chromium, `e2e/browser`) all pass; the shard's last line
is its verdict, read by `e2e/gate-verdicts.sh` in the `stories` job.

**Learning on k3d.** CI has no real model. The fake provider (`services/model-gateway/src/testing/
fake-llm.ts`) answers a `memory_learn` extractor call with schema-valid candidates scripted by its
transcript (`fake-extractor.ts`): `kobe-learn {json}` lines (any statement, scope, kind,
portability, project flag, target memory, or evidence cited from the assistant's echo), and in the
person's own words "I prefer …" (a personal preference) and "For the record: …" (a Workspace fact,
quoted). Like a naive model it offers whatever the transcript asks for, injections included; the
server's screen, selection and save checks decide what survives. So every pass below is a real pass
(gateway server call, usage row, screen, To review, watermark) with only the model replaced.

**Not on k3d.** No embedding model is configured, so retrieval is keyword only and U50's vector half
is the relevance harness ([gate-7a.md](gate-7a.md#relevance-fts-recall8-kobe-387-sm25sm30),
[gate-7d.md](gate-7d.md#u50-vectors-kobe-408-kobe-409-kobe-659)). U52's thresholds need a real model:
the extractor harness ([gate-7b.md](gate-7b.md#results)); its recorded-response fixtures run in the
server's unit tests. Time-based rules (14-day candidates, 30-day proposals and offboarding, sweeps)
are proven by the DB tests the earlier gate docs cite; on k3d one proposal's clock is moved back in
its row (U42) and the day's pass count is seeded (U47).

| Story | API checks (`e2e/gate7/client.mjs`)                                                                                                                                                                                                                                                                                                                                               | Browser checks (`e2e/browser/tests/`)                                                                                                  |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| U39   | A pass over 12 scripted facts stores 10; every quote is a verbatim span of the person's message; nothing saved before Save, one item after; a Team admin reading the shared thread gets 403 `read_only` on the Learn state and on a start                                                                                                                                         | `learn-from-chat.spec.ts` (+ menu, `/learn`, the ? sheet); `gate7/u39-review.spec.ts` (Mod+Shift+L, To review, the quote)              |
| U40   | Save applies in this workspace only (not in the person's other one); Undo takes it back; portable needs `confirm_portable`; a portable fact is refused; the confirmed preference is listed and given to a run in the other workspace                                                                                                                                              | `memory-editor.spec.ts`; `gate7/u39-review.spec.ts` (Save, "Memory saved.", Undo)                                                      |
| U41   | The second pass reads only the new entries; a dismissed candidate never returns (incremental and Rescan); an existing memory returns as `update` with its current wording and version; nothing new: `nothing_to_learn`; another branch: `not_current_branch`; a fork's Rescan offers only its own message                                                                         | —                                                                                                                                      |
| U42   | A member can't save to the workspace and proposes; the curators' queue lists it and a curator is notified; approval makes a Workspace memory, notifies the proposer, and another member's next run is given it; a proposal lives 30 days; a lapsed one (clock moved back) is re-proposed with a new 30-day clock                                                                  | —                                                                                                                                      |
| U43   | A Team admin names a steward, who saves, edits, tags, pins and archives a Workspace memory; a plain member is refused; export and import preview; the 11th pin is refused; with the cap set just above the count, curators are told at 80% and the save at 100% is refused; the steward's changes are audited                                                                     | `memory-consoles.spec.ts` (import preview and commit)                                                                                  |
| U44   | A member proposes a candidate to the Site; the Site queue has it only after a Team admin confirms (a steward can't); the Site detail shows statement, kind, justification, workspace and date and no conversation field, id or text; request changes three rounds, the fourth refused; approve; members read it                                                                   | `site-proposals.spec.ts` (the whole flow in the UI, two people)                                                                        |
| U45   | Approve, merge into it (version 2), reject without a reason refused and with one shown to the proposer; Policy set by a Site admin, the 2 KiB budget refuses more; a workspace that opted out of Site memories is given Policy first and no other Site memory; a contradicting save is blocked, saved anyway, audited                                                             | `memory-consoles.spec.ts` (Policy toggle and Undo)                                                                                     |
| U46   | An adversarial pass (an injected instruction and a capability request in a pasted email, a secret, "ignore your instructions", a claim cited only from the assistant) offers only the genuine fact; a secret is refused at all four scopes; the lint override is audited; `show_memory_item` changes nothing; a pinned memory claiming powers changes no tool list or egress rule | —                                                                                                                                      |
| U47   | The pass's `memory_learn` usage row; a used-up member budget blocks Learn (state and 402); an unenabled learning model is refused with its reason (no fallback), also as a team override; memory off: Notes and Memories off, no memory tools, no personal memories, and every memory back when on; the 21st pass of the day: 429                                                 | `memory-quality-nudge.spec.ts` (nudge, Quality tabs incl. Learn's pass numbers)                                                        |
| U48   | The run's memories in context with lane and version; an edit applies from the next run (version 2); a message that matches neither it nor the thread's title and last two messages leaves it out (picks per message); a reader of the shared thread gets 403 `not_owner`                                                                                                          | —                                                                                                                                      |
| U49   | Site memory retention and the retention tables; a legal hold on one person placed and released; that person removed from the workspace is listed as offboarded with their memory kept; Site break-glass for portable preferences approved, reads them, audited in both workspaces of the person, revoked                                                                          | —                                                                                                                                      |
| U50   | No embedding model on the install; a keyword match is picked, a paraphrase with no shared word (new thread) is not (keyword only)                                                                                                                                                                                                                                                 | —                                                                                                                                      |
| U51   | `remember` writes a personal note (`memory.updated`), `recall(path)` reads it, the Notes API shows it; `remember`, `recall`, `show_memory_item` are the run's memory tools                                                                                                                                                                                                        | `gate7/u51-notes.spec.ts` (one My memory icon, Memories and Notes tabs, `/memory`, the master-switch line in the guide and What's new) |
| U52   | The gate's passes each record prompt version and model (the fake learning model); Learn's pass numbers for curators                                                                                                                                                                                                                                                               | —                                                                                                                                      |
| U53   | A project fact's destination is the project's notes; the preview signs the change; a forged approval is refused; the signed one adds the line to the project's notes                                                                                                                                                                                                              | —                                                                                                                                      |
| U54   | `show_memory_item` (the chip's call) succeeds; archive, Undo, archive; the next run is not given it                                                                                                                                                                                                                                                                               | `gate7/u54-forget.spec.ts` (the chip, Open in Memory, Archive, Undo, the next run)                                                     |

## Real cluster (gate1)

gate1 runs main `e324bb1f2aee` (`local-e324bb1f2aee`, deployed 2026-11-19 after a database dump):
every v1.3 ticket and every follow-up from the Gate B/C/D answers (KOBE-607, 636, 654, 664–672,
674). Main moved on to `65febf84` with KOBE-675 only (the k3d shard, tests and the fake model), so
the product on gate1 is the product at the head of main. Learning model `glm-5.3-flash` (Ollama
Cloud); embeddings from the in-cluster `kobe-local/nomic-embed-text`.

**Browser specs on gate1, 2026-11-19** (Playwright 1.55 container; owner = Site admin and Team
admin, member2 = member, a second Team admin `steward@gate1.test` added for the Site flow):

| Spec                           | Stories            | Result                                                                                                     |
| ------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `learn-from-chat.spec.ts`      | U39, U47           | passed (member2)                                                                                           |
| `memory-editor.spec.ts`        | U40, U54           | passed                                                                                                     |
| `memory-consoles.spec.ts`      | U43, U45           | passed (import preview, Policy toggle and Undo)                                                            |
| `memory-quality-nudge.spec.ts` | U47, U52 (signals) | passed twice (nudge after 10 messages and after a thumbs-down; Quality tabs)                               |
| `site-proposals.spec.ts`       | U44, U45           | passed twice alone (member proposes, second Team admin confirms, Site admin requests changes and approves) |
| `connector-panels.spec.ts`     | (KOBE-654)         | passed twice                                                                                               |

The first run found three spec problems, none a product bug: the Site flow needed a third person
since Gate C decision 2 (the confirmer may not decide), the nudge spec read the Learn state before
the run counted, and a single mouse jump left the pointer in Radix's tooltip grace area. Run in
parallel with other specs, `site-proposals.spec.ts` can hit the per-address sign-in limit (three
sign-ins in seconds from one runner IP); it passes alone.

**Per story on gate1:**

| Story | Real-cluster evidence                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------- |
| U39   | Gate B: Learn spec on gate1 (7/8 runs, the flake fixed in KOBE-663); today's re-run                   |
| U40   | Gate A U40 row (gate1 specs); `memory-editor.spec.ts` today                                           |
| U41   | Gate B: watermark/fork DB tests, passes on gate1 with the Site's learning model                       |
| U42   | Gate B: Workspace proposals; Gate B browser and DB evidence                                           |
| U43   | Gate A U43 row; `memory-consoles.spec.ts` today                                                       |
| U44   | Gate C: `site-proposals.spec.ts` on gate1 (twice) and the wall probe; today's re-run                  |
| U45   | Gate A U45 row (Policy) and Gate C (approve, merge, reject); today's re-runs                          |
| U46   | Gate B: extractor eval on the Site's learning model, 0 Workspace/Site offers in 27 adversarial cases  |
| U47   | Gate B (budget, switches, rate limit); Gate D nudge on gate1; today's re-runs                         |
| U48   | Gate A U48 row; Gate A/B cache replays on gate1 (memories in context)                                 |
| U49   | Gate A U49 row                                                                                        |
| U50   | Gate D: hybrid recall@8 0.894 vs 0.573 keyword only, in-cluster model on gate1; the recall tool below |
| U51   | Gate A U51 row                                                                                        |
| U52   | Gate B: extractor thresholds on the Site's learning model, per prompt version and model               |
| U53   | Gate B: Add to project notes (signed approval)                                                        |
| U54   | Gate B (Open in Memory, archive, Undo); `memory-editor.spec.ts` today                                 |

### The recall tool (KOBE-664)

`recall({ query })` now uses the same hybrid scoring as the per-message picks. On the relevance
set (151 queries; `e2e/memory-eval.sh relevance`, dev Postgres 17 + pgvector, embeddings from the
Mac mini Ollama, 2026-11-19, results in [gate-7/](gate-7/)):

| Model                | recall tool, keywords only | recall tool, hybrid | selector, hybrid |
| -------------------- | -------------------------- | ------------------- | ---------------- |
| nomic-embed-text     | 0.546                      | **0.887**           | 0.894            |
| qwen3-embedding:0.6b | 0.546                      | **0.887**           | 0.894            |

## Follow-ups from the phase gates (all merged)

KOBE-664 (recall hybrid), KOBE-665 (Site proposals block a Workspace delete, migration 0234),
KOBE-666 (the confirmer may not decide, one reminder, Site audit inside the wall), KOBE-668
(stale vs expired suggestions, migration 0235), KOBE-669 (vector build without an active
Workspace), KOBE-670 ("Set by the Site" label), KOBE-671 (decided Learn records leave with their
pass), KOBE-672 (the screen accepts the pass's own nonce), KOBE-607 / KOBE-636 / KOBE-654
(reliability), KOBE-674 and #617 (test flakes), KOBE-675 (this gate's k3d shard). Parked by Chris:
KOBE-667 (merge target search, later).

## Questions for Chris

Answered 2026-11-19.

| #   | Question                                                                                | Answer     | Follow-up |
| --- | --------------------------------------------------------------------------------------- | ---------- | --------- |
| 1   | Trim SIEM forwarding like the Site audit view (KOBE-666)?                               | Yes        | KOBE-676  |
| 2   | A hint on the Site audit page that Workspace details live in the Workspace's audit log? | Yes        | KOBE-676  |
| 3   | Site-wide vector build without an active Workspace: each Workspace pays (KOBE-669)      | Keep       | —         |
| 4   | Keep the gate1 test user `steward@gate1.test` (Team admin of Team1)                     | Keep       | —         |
| 5   | v1.3 release notes                                                                      | Write them | KOBE-678  |
