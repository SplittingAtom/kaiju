# KOBE-809: Durable rate limits longer than 60 s are cut short by the auth library's prune

- **Status:** in review
- **Branch / worktree:** `group-85-rate-limit-store` in `../Kobe-g85`
- **Depends on:** none

## Cause

Better Auth 1.7.14 (`dist/api/rate-limiter/index.mjs`, `deleteExpiredRows`) deletes every row of
its `rate_limits` table whose `lastRequest` is older than its longest window (60 s), with no key
filter, whenever one of its own keys starts a new window. Kobe's `hitRateLimit` and the
password-reset resend claims (`kobe:reset-sent:*`) lived in that table, so every Kobe limit longer
than a minute (10-minute and hourly ones) and the 5-minute resend guard lost their rows after about
60 s on a Site with any sign-in traffic.

## Decisions

- **Own table `kobe_rate_limits`** (`packages/db/src/schema/kobe-rate-limits.ts`): `key` primary
  key, `count`, `window_start`, `expires_at` (epoch ms), index on `expires_at`. Site-level, no
  team: listed in `tenancy/identity.ts` `siteWide` next to `rate_limits`, all privileges for the
  app role (counters are upserted and deleted). Migration generated normally (to be renumbered by
  `db:rebase`).
- **Same single atomic upsert** in `services/server/src/rate-limit.ts`; it now also sets
  `expires_at` = window start + window, so rows of different windows can be pruned by one rule.
- **Pruning is opportunistic and bounded** (no new job): a hit that starts a new window (returned
  count 1) runs `pruneExpiredRateLimits`, which deletes at most 100 rows with `expires_at < now`
  (`FOR UPDATE SKIP LOCKED`, so replicas don't wait on each other). Each new window adds at most one
  row and removes up to 100 expired ones, so the table stays near the number of live windows. A
  prune failure is logged and never fails the hit. Chosen over the nightly retention pass because
  that pass is per team and can be paused.
- **Reset-email claims moved too** (`auth/reset-links.ts`): same keys, `window_start` = send time,
  `expires_at` = send time + `RESET_RESEND_AFTER_MS`; the per-user cleanup stays, and claims of users
  who never ask again go with the general prune.
- **Backups:** `kobe_rate_limits` is left out like `rate_limits` (throwaway counters):
  `packages/cli/src/excluded.ts`, its tests and fixture marker, `docs/backup-restore.md`.
- **Better Auth keeps `rate_limits`** for its own per-IP limits (all 60 s or less); nothing of Kobe's
  reads or writes it any more except tests of the library's limits.
- **Upgrade:** existing `kobe:*` rows in `rate_limits` are left behind; Better Auth's own prune
  removes them within a minute of the next sign-in traffic. Counters restart empty in the new table
  at upgrade, i.e. at most one extra window's worth of hits per limit, once. Pending reset-email
  claims are forgotten, so a user may get one more reset email within 5 minutes of the upgrade.

## Users of `rate_limits` checked (`git grep -n rate_limits`)

`rate-limit.ts`, `auth/reset-links.ts` moved; server DB tests that seed or clear `kobe:*` rows
(account-lifecycle, agent-ownership, agent-roster, break-glass, site-break-glass, connector-oauth,
conversation-tree, scim, skill-draft-tool, skill-drafts-preview, skill-drafts-starts,
workspace-files) now use `kobe_rate_limits`; `auth.db.test.ts` (library limit) and the backup
exclusion lists keep `rate_limits`. `e2e/gate4-restore.sh` lists only RLS team tables; no change.
`memory/site-settings.ts` `rate_limits` is a settings field, unrelated.

## Docs

`docs/guide` unchanged: it states limits as configured (for example 30 admin changes an hour) and
this fix makes them hold as written; no page described the storage or the shortened windows.
`docs/backup-restore.md` lists the new table among the tables not backed up.

## Evidence

- ac-1: `services/server/src/rate-limit.db.test.ts` "keeps a 10-minute limit and a pending reset
  link's resend guard" drives Better Auth's real prune (an expired library key's new window via
  `/api/auth/request-password-reset`, waits until a sentinel library row is gone). Before the fix
  both assertions failed (`hitRateLimit` allowed a second hit, `claimResetLinkSend` allowed a
  second email); after, it passes.
- ac-2: same test; schema and code above.
- ac-3: "deletes expired windows, in bounded batches, when a hit starts a new window" and "also
  deletes reset-email claims past the resend window".
- ac-4: `@kobe/db` unit and DB/probe suites, server typecheck, the changed server DB tests and the
  auth/reset tests (`account-lifecycle`, `auth`) green; `docs/rate-limits.md` is not created here
  (coordinator's instruction).
