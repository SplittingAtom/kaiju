# KOBE-697: Team setters outside withTeam(): documented exceptions and a guard test

- **Status:** in review (group 52)
- **Branch / worktree:** `group-52-audit-split-team-guard` in `../Kobe-g52`
- **Depends on:** none (review SEC-8, STO-12)

## Decisions

- Owner decision (Chris, 2026-11-20, ac-1): the three helpers that set `kobe.team_id` outside
  `withTeam()` are accepted exceptions, listed in CLAUDE.md next to KOBE-120 with the invariants
  each actually keeps (checked in the code):
  - `scanTeams()` (`packages/db/src/team-scan.ts`): own transaction, refuses when a team is set,
    ids from `teams` as bound parameters, cleared before return.
  - `workspacesOf()` (`packages/db/src/break-glass/portable-read.ts`): inside
    `readPortableWithSiteBreakGlass()`'s transaction, which refuses when a team is set; ids from
    `teams`, membership reads only, cleared before the audit writes.
  - `inTeam()` (`services/server/src/event-stream/read.ts`): own pool, fresh `BEGIN READ ONLY`
    per call, anchored UUID check and lowercasing before interpolation, ends with COMMIT/ROLLBACK.
    It does not check for a team already set (none can be: every call is a new transaction on a
    pool where only transaction-local settings are made).
- Event-stream reader code unchanged: a parameterized `set_config($1, ...)` cannot share the
  simple-query message with `BEGIN` (the extended protocol takes one statement, and node-postgres
  does not pipeline), so it would cost one more round trip per stream read. Owner rule: change it
  only if free; it is not, so the UUID guard is documented instead.
- Guard: `packages/db/src/team-setters.test.ts` scans `git ls-files` (ts/js/mjs/cjs/sql, test code
  excluded) for `set_config(` on the team setting (literal, `TEAM_ID_SETTING`, or a positional
  `$n` first argument) and `SET [LOCAL|SESSION] kobe.team_id`; allowlist = `with-team.ts`, the
  three exceptions, and the migrations that define the budget functions (0085, 0091, 0097, 0148, 0152) plus 0047's one-off spend backfill. It also fails on a stale allowlist entry and when
  CLAUDE.md stops naming an allowlisted file. A new migration that re-creates a budget function
  must be added to the allowlist.
- Guide: no change (nothing a member, admin or agent sees).

## Evidence (acceptance criteria → test or command output)

- ac-1: decision above (Chris, 2026-11-20, in the coordinator's brief).
- ac-2: CLAUDE.md lists the exceptions with their guards; `team-setters.test.ts` (3 tests) green;
  red before the CLAUDE.md change (`team-scan.ts` not named).
- `pnpm verify` green except the load-sensitive timing test `model-gateway budget-gate.test.ts`
  ("holds a settled reservation..."), which passes alone (255/255); `@kobe/db test:db` 2044/2044,
  `@kobe/server test:db` 3287/3287.
- Review follow-up (LOW 1-2): the guard also fails on any other file naming `TEAM_ID_SETTING` or
  `kobe.team_id` beyond reads, plain imports and comments (aliases, copies, concatenated names,
  quoted `SET LOCAL "kobe.team_id"`), scans `.sh`/`.py` too, with an allowlist of mentions
  (definition, span attributes, an HKDF label, prose); CLAUDE.md names migration 0047.
