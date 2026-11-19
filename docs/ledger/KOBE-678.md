# KOBE-678: v1.3 Semantic Memory release notes (Gate 7 answer 5, U51)

- **Status:** committed locally on `kobe-678-release-notes` (no push/PR; coordinator reviews)
- **Branch / worktree:** `kobe-678-release-notes` in `../Kobe-wt678`

## What changed

- `docs/releases/v1.3.md` (new; starts the release-notes convention, one file per release, for
  operators): features, the master-switch widening (before/after table), new switches and Site
  settings with defaults, chart changes (`embeddings.local.enabled` on by default; off and
  external-model paths; pgvector), migrations, licences, privacy/wall, retention, known limits,
  upgrade steps.
- `docs/guide/whats-new.md` (new guide page, Getting started, order 4): member/admin summary with
  links into memory.md and the admin pages. Picked up by the guide build automatically (served at
  `/docs/whats-new`, `/docs/whats-new.md`, listed in `/llms.txt`); linked from getting-started.md
  "Where to go next" (the guide's index page).
- `docs/install.md` Upgrade notes: links docs/releases and v1.3.md.
- U51 k3d check: `e2e/browser/tests/gate7/u51-notes.spec.ts` also fetches `/docs/whats-new.md` and
  checks the master-switch line; story text in `e2e/gate7.sh` and the row in `docs/gates/gate-7.md`.

## Decisions

- **Migration range.** The brief names 0228–0235; v1.3 as a release spans 0216–0235 (Phase A
  0216–0227 is also v1.3 and has no earlier release). The notes list both groups, so an install
  upgraded from before v1.3 and one already on Phase A both read correctly.
- **KOBE-676** (SIEM + Site audit page hint) is described as part of v1.3, as the brief asks; it
  lands alongside. If it slips, the "Site audit and SIEM" bullet in v1.3.md and whats-new.md needs
  trimming to the Site audit view (KOBE-666) only.
- whats-new.md points to the release file by repo path in code text (not a link): the guide build
  refuses links outside docs/guide.

## Docs

This ticket is the docs change (guide page added). No UI change.
