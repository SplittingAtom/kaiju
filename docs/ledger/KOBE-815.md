# KOBE-815: Remove merge-conflict hotspots (audit table, openapi.json, onto-main script)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (branch committed; coordinator opens the PR)
- **Branch / worktree:** `group-89-merge-hotspots` in `../Kobe-g89`
- **Depends on:** none

## Decisions

1. **Audit table generated from per-area rows in code.** Each area's rows (`fields`, `when`) live
   in `packages/db/src/audit/events/<area>.doc.ts`, typed
   `satisfies Record<keyof typeof <AREA>_EVENTS, AuditEventDoc>`: an event without a row, or a row
   without an event, fails the typecheck. `src/audit/event-docs.ts` combines them and renders the
   table between `<!-- audit-events:start … -->` / `<!-- audit-events:end -->` inside a
   `prettier-ignore` range: one unpadded row per action, sorted by name (code-point order); scope
   comes from the event definition. `pnpm --filter @kobe/db audit:doc [--check]` writes it (from
   `dist`). `events.test.ts` fails when the page is stale, a row is missing or an area's rows are
   out of name order. Row text moved unchanged (all 410 rows; scopes matched code 410/410),
   except `egress.ceiling.internal_changed`'s "the install's internal targets" → "the site's":
   `scripts/check-site-wording.mjs` scans `packages/` source, so the rows are now checked too.
   - Rows sit **beside** the definitions (own file per area) instead of a third `event()`
     argument: that would have reformatted every event file and conflicted with every open branch
     that touches an event; this way open branches' event-file edits still merge cleanly.
   - Readers: anchors other pages link to (`#event-taxonomy-and-field-allowlist`,
     `#export-and-forwarding`, `#operations`, `#ip-and-user-agent`) are unchanged; the web audit
     page only names the file; the page is not served by `/docs` (only `docs/guide/` is).
2. **openapi.json no longer committed.** Consumers checked (`git grep openapi.json`, `-i openapi`
   in `.github`, `charts`, `apps/web`, `docs/guide`, `e2e`, `scripts`): only `document.test.ts`'s
   drift comparison and docs prose. No route serves it, no workflow publishes it. Now:
   `pnpm --filter @kobe/server openapi` writes it from `dist` (gitignored); CI's `unit` job
   uploads it as the `openapi` artifact on every push. `document.test.ts` keeps every coverage
   and per-route check and now asserts the document is deterministic and survives JSON
   round-tripping (`toStrictEqual`) instead of matching a committed copy, which only proved
   someone ran the regenerate command. `coverage.test.ts` and `catalog/detail.test.ts` unchanged.
   The generated file was byte-identical (as JSON) to the last committed one.
3. **`scripts/onto-main.sh [base]`** (default `origin/main`): fetch, `db:rebase <base>` (stashes,
   merges and regenerates when the branch has migrations; the base goes positionally so a branch
   still on the old script works), else `git merge`; `pnpm install` when the lockfile moved;
   conflicts only in generated files are resolved by regenerating (audit table block; route
   inventory snapshots via the documented `vitest -u`, only when they conflict; `openapi.json` is
   removed); then regenerates and commits the audit table and prints what needs a human
   (`pnpm typecheck` for union barrels, db checks after regenerated migrations, inventory diff).
   It stops with the list on other conflicts and resumes an interrupted `db:rebase` when re-run.
   Route-inventory snapshots are never regenerated on a clean merge: they are the review record.
4. **db:rebase base ref.** `--base <ref>`, `--base=<ref>`, positional, or `KOBE_DB_REBASE_BASE`
   (in that order; default `origin/main`). Own migrations are now journal entries neither the
   base nor the fork point has (`branchOnlyEntries`): identical to before on a branch off main
   (fork-point entries are all on main); on a branch stacked on one that was regenerated since,
   the old copies of the lower branch's migrations are left to it. Tests in
   `packages/db/scripts/migration-plan.test.mjs`.
5. **Guide:** no change. Nothing a member, admin or in-sandbox agent sees changes; this is
   developer tooling and contributor docs (`docs/audit-log.md` prose, `docs/development.md`,
   `docs/parallel-work.md`, `docs/agent-prompt.md`).
6. Residual: two events whose names sort next to each other still touch neighbouring lines in
   the generated table (and in the area's doc file); `onto-main.sh` regenerates the table, the doc
   file needs the usual one-line resolution.

## Open branches: carrying an audit row or route over after this lands

Run `scripts/onto-main.sh` on the branch. Then:

- **Audit row** (branch added or changed a row in the old table): the merge conflicts in
  `docs/audit-log.md` and the script stops with these steps:
  1. `git checkout --theirs -- docs/audit-log.md`
  2. add (or edit) the row in `packages/db/src/audit/events/<area>.doc.ts`, in name order:
     `"area.event": { fields: "<old Target fields cell, \"\" for —>", when: "<old Recorded when cell>" },`
  3. `git add docs/audit-log.md packages/db/src/audit/events/<area>.doc.ts && git commit --no-edit`
  4. `scripts/onto-main.sh` again: it builds `@kobe/db`, regenerates the table and commits it.
- **Route / openapi.json** (branch regenerated it): the modify/delete conflict is resolved by the
  script (`git rm --cached`; the file stays as an ignored local file). Nothing else to carry: the
  route's catalog line or `openapi/<area>.ts` change carries the content. If the branch edited
  `document.test.ts` near the removed "matches the committed openapi.json" test, keep main's
  version of that test. Update the route-inventory snapshot as before
  (`pnpm --filter @kobe/server exec vitest run src/route-inventory.test.ts -u`).

## Evidence

Scripts used (scratchpad, not committed) built throwaway branches in a temporary worktree;
branches and worktrees deleted afterwards (`git branch --list 'demo-815*'` empty).

- **ac-1** Two branches from this tip each add an event to the same area (`run.demo_alpha` at
  the top of `runs.ts`, `approval.demo_beta` at the bottom), its row in `runs.doc.ts` and the
  regenerated table. `git merge demo-815-b` into `demo-815-a`: "Auto-merging docs/audit-log.md,
  runs.doc.ts, runs.ts — clean, no conflict"; `audit:doc --check` up to date; `events.test.ts`
  839/839 on the merge.
- **ac-1, open branch** From pre-KOBE-815 main, a branch adding `run.demo_open` with an old table
  row and a regenerated `openapi.json`, run onto "main + KOBE-815": `openapi.json` dropped
  automatically, the script stopped on the old row with the steps above; after them, the re-run
  committed the regenerated table, `run.demo_open` row present, `openapi.json` untracked.
- **Dogfood:** this branch was brought onto origin/main (#682, #683) with `scripts/onto-main.sh`:
  #683's `site.settings.updated` row change was carried into `platform.doc.ts` by those steps.
- **ac-2** `openapi.json` removed from git and ignored; `document.test.ts`, `coverage.test.ts`,
  `catalog/detail.test.ts`, route-inventory and `kobe-mcp/session-contract.test.ts`: 5 files,
  111 tests passed. CI `unit` uploads the `openapi` artifact (`if-no-files-found: error`).
- **ac-3** `demo-815-stack-base` adds migration `0245_demo_s`; `demo-815-stacked` (from the same
  tip) adds `0245_demo_c`. `scripts/onto-main.sh demo-815-stack-base` on the stacked branch:
  stash, merge, regenerate → journal `…, 0245_demo_s, 0246_demo_c`; `drizzle-kit generate` then
  reports no schema changes. A conflicting route-inventory snapshot on two throwaway branches was
  regenerated to the real inventory and the merge committed.
  `migration-plan.test.mjs`: 13 passed (base-ref parsing, stacked own-migration selection).
- **ac-4** `docs/parallel-work.md` (new "Bringing a branch onto main" section, shared-file rows,
  db:rebase base ref, merging), `docs/agent-prompt.md` (stacked migration tickets, prompt
  lines). CI: coordinator's PR.
- Checks run: install, `@kobe/db` build/typecheck, `@kobe/server` build/typecheck, db
  `audit.db.test.ts` + `audit-pii.db.test.ts` (40 passed),
  `packages/db` unit tests, shellcheck (shellcheck-py), eslint + prettier on changed files,
  `scripts/check-site-wording.mjs`, `scripts/check-public-hygiene.sh`.
