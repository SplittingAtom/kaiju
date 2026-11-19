# KOBE-675: Gate 7 on k3d (e2e gate7 shard, U39–U54)

- **Status:** in progress (draft PR)
- **Branch / worktree:** `kobe-675-gate7-k3d` in `../Kobe-wt675`
- **Depends on:** v1.3 Phases A–D merged (KOBE-413 writes the rest of docs/gates/gate-7.md)

## Plan

- Fake extractor in the model-gateway image's fake provider
  (`services/model-gateway/src/testing/fake-extractor.ts`, unit-tested with the protocol's parser).
- `e2e/gate7.sh` + `e2e/gate7/client.mjs` (API checks per story, modelled on gate5) and
  `e2e/browser/tests/gate7/` (u39-review, u51-notes, u54-forget); existing specs reused
  (learn-from-chat, memory-editor, memory-consoles, memory-quality-nudge, site-proposals).
- e2e.yml shards `gate7-a` (U39–U46) and `gate7-b` (U47–U54); `docs/gates/gate-7.md` "k3d checks".

## Decisions

- **Extractor markers:** `kobe-learn {json}` (full control: scope, kind, portable, project flag,
  target memory by substring → `update`, `cite: assistant` for a claim the person never made), plus
  "I prefer …" and "For the record: …" in the person's words, so the gate1 browser specs work
  unchanged on k3d. Detection: a user message carrying the transcript fence. The fake offers
  injections like a naive model; the server's screen must drop them (U46, ac-3).
- **Letter nonce:** the gate's unique token is letters (`date +%s | tr 0-9 …`): a 10-digit number
  reads as a phone number and the screen drops the candidate as personal data (found with a local
  replay of the fake's replies through the real `screenExtractorOutput`).
- **Browser user** is the e2e owner (Site admin), joined to `gate7-a` as Team admin through the
  API, `KOBE_TEAM=gate7-a`; `KOBE_USER2` is gate7-m2 (member of both teams).
- **Fixtures on rows (documented in the client):** U42 moves one proposal's `expires_at` back (30
  days can't pass in CI); U47 inserts 20 failed pass rows for the daily limit, then ages them out.
- **Stickiness (U48):** the selector's stickiness only ranks (Q6: re-picked every message); on k3d
  the check is that an unmatched item is not carried into the next run; the bonus is unit-tested.
- **Manual partial runs:** `workflow_dispatch` input `shards` (JSON list) runs only some shards;
  draft PRs skip e2e entirely, so the gate shards were iterated with dispatch runs.
- **Guide:** no user-facing change (test harness and the fake model only): no docs/guide update.

## Open questions (for Chris or the coordinator)

- U51's "release notes" have no file in the repo; the gate checks the served guide's line
  ("Turning **Allow memory** off now also turns memories off"), as gate-7a noted.

## Evidence (acceptance criteria → test or command output)

- ac-1/ac-3: CI run ids and per-story verdicts below once green.
