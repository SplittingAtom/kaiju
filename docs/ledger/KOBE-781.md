# KOBE-781: Skill scan and catalog state: mirror catalog on revoke/withdraw/suspend, retryable incomplete scans, scans out of the review-queue GET

- **Status:** in review (group 79, branch `group-79-skills-scan-evals`)
- **Branch / worktree:** `group-79-skills-scan-evals` in `../Kobe-g79`
- **Depends on:** none

Review pass 2 findings P2-10, P2-11, P2-35, P2-39 (private findings file). Each was checked
against the code first; all four held as described.

## Decisions

- **P2-10 (mirror).** `withdrawBlocked` became `planWithdrawals` (`skills/mirror/mirror-store.ts`):
  a version is withdrawn from a remote when it is blocklisted (as before) or when this remote
  carries it and it is no longer published (revoked, withdrawn, suspended). One never pushed there
  is marked `withdrawn` at once; one the remote may list is marked only after a catalog-only commit
  without it is on the remote (`MirrorSession.withdrawFromCatalog`), so a failed commit is retried
  by the next sweep and a done one is not redone (no schema change: the existing `withdrawn` status
  is the record). The sweep now opens a session when there is a withdrawal to commit even with
  nothing pending. A version published again (unsuspended, unrevoked, off the blocklist) is pending
  again; when its tag is already on the remote, the tag is reused and `catalog.json` lists it again
  (a catalog-only commit). Retire acts (withdraw, revoke, unrevoke) kick the mirror.
- **P2-11 (incomplete scans).** A scan that doesn't finish (`scan-incomplete`,
  `scan-resources-exceeded`) is never stored as a verdict: a team version's review row is stored
  `unscanned` (no findings, rule set null), so it can be rejected but not approved
  (`scan_pending`); a personal version gets no scan row, so it needs each team's approval. Both are
  scanned again by the late scan job (below), which is the rescan; the author need not change a
  byte. The rule-set rescan (`scanStored`) no longer stores an incomplete rescan either (it would
  have suspended approved versions on a timeout); the row stays stale and is retried. A promotion
  whose scan doesn't finish is refused `scan_incomplete` instead of submitting a Block. Upload and
  Save version answer `flagged: false` for such a version.
- **P2-35 (late scans).** `scanUnscanned` is gone from the queue GET (it only reads now). New
  `skills/late-scan.ts` `LateScanner`, registered as process job `skill-late-scan`
  (`startup/process-jobs.ts`: `every` 30 s, advisory lock `kobe.skills.late-scan`, `fireAndLog`;
  server replicas with an object store). Each pass: personal latest versions without a scan, then
  each team's unscanned rows (`scanTeams`, ordered by `scanned_at`), at most 20 scans; bytes read
  verified through `scanStored` (a hash mismatch scans as Block `bundle-integrity`); the update
  requires the row still unscanned and its `content_hash` equal to the verified version's. Each row
  is isolated: a failure is logged and backed off in memory (1 min doubling to 6 h), so unreadable
  rows never starve the rest. Personal versions that predate scanning get their own scan this way
  too (as an upload would).
- **P2-39.** One `scanIncomplete(scan)` in `skills/scan-pool.ts` (with the two rule names) replaces
  the four `INCOMPLETE` copies. The other duplicates listed there (`DRAFT_BUNDLE_LIMITS`,
  `inLocation`, the busy-error mapper) were not in this ticket's scope: left as they are.

## Review fixes (coordinator review of group 79)

- **A rejection always holds.** `personalSkillUsage` reads this team's decision for every
  personal version: a rejected one stays unusable there even once a late scan gives it a Pass (an
  unscanned version can be rejected). Other "usable" readers checked: the run resolver uses
  `personalSkillUsage`; draft tests and personal-version evals refuse a declined hash
  (`testGate`); bundle fetches go through the run's resolved list; installs, the mirror and team
  versions only take approved rows.
- **Bounded unfinished rescans.** A rescan under a new rule set that keeps not finishing
  (`SCAN_DID_NOT_FINISH` from `scanStored`) suspends the version once the rule set's run is older
  than `server.skillRescanIncompleteSuspendHours` (chart, default 24, 0 = never; env
  `KOBE_SKILL_RESCAN_INCOMPLETE_SUSPEND_HOURS`, zod 0..8760). No migration: the period counts from
  `skill_rescan_runs.started_at`. Team rows keep `approved` with `suspended_at` (omitted from runs
  as for a Block, but the approval survives), so a later finished rescan that doesn't block lifts
  it, or a Team admin approves it again (allowed for an approved, suspended row); personal scans
  get `suspended_at` (now honoured even while the stored scan is Pass) and are lifted the same way.
  Audited `skill.rescan.suspended` with `reason: rescan_incomplete`; the suspension email covers
  both causes.
- **Owner question (not changed):** the mirror keeps a revoked or blocklisted version's commit
  and tag `name/vX` on the remote (append-only by design), so a client with an old catalog, or one
  listing tags, can still fetch a revoked bundle. Deleting such tags would not rewrite branch
  history (the content stays reachable through it). Chris to decide whether Kobe should delete
  tags of revoked or blocklisted versions.

## docs/guide evaluation

- `docs/guide/agents/skills.md` "It was suspended or blocked": a rescan that keeps failing to
  finish suspends the version after 24 hours (configurable) and lifts itself once one passes.
- `docs/audit-log.md`: the new optional `reason`.

- `docs/guide/agents/skills.md`: new paragraph under "Why isn't my skill showing up?" on a scan
  that can't finish (saved as not scanned yet, scanned again in the background, can't be approved
  until then, no need to save again).
- Mirror: the guide doesn't describe the git mirror or `catalog.json` (Site console only), so no
  page changes; the behaviour now matches what the console already implied.

## Open questions (for Chris or the coordinator)

- None.

## Evidence (acceptance criteria → test or command output)

- ac-1: `skill-mirror.db.test.ts` "drops a revoked, withdrawn or suspended version from
  catalog.json with nothing to push (P2-10)" (revoke via the API kicks the mirror; one catalog-only
  commit; no second commit on the next sweep; unsuspended version listed again).
- ac-2: `skill-review.db.test.ts` "a scan that doesn't finish (P2-11)" (team and personal).
- ac-3: `skill-review.db.test.ts` "backfills ... never the GET" and "skips a row it can't read
  without holding up the rest, and checks the bytes' hash (P2-35)"; `startup/server.db.test.ts`
  lists `skill-late-scan`.
- Unit: `scan-pool.test.ts` (`scanIncomplete`), `mirror/catalog-json.test.ts`.
