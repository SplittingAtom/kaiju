# KOBE-818: A Repo too large to mirror is downloaded again on every re-check and Refresh

- **Status:** in review
- **Branch / worktree:** `group-111-small-followups` in `../Kobe-g111`

## Decisions

- Size is read from the repository answer the mirror already fetches (`getRepository`, one host
  call that counts against the connection's budget as before): new optional `GitRepository.sizeKb`
  (GitHub `size`, Gitea/Forgejo `size`, both KiB), documented as an untrusted hint of the whole
  repository with history.
- Skip only for a Repo already in a too-large state, and only when the hint is over 4 times the
  pack cap (`GIT_MIRROR_SIZE_HINT_MARGIN`): the hint covers history, the fetch covers the tip, so
  a Repo near the limit is still fetched and judged by what it sends. A skip records the same
  failure and the 6 h recheck.
- Manual Refresh on a too-large Repo: 1 per hour per Repo (all members), `checkRateLimit` key
  `git-mirror-refresh-large:<repo>`, 429 `rate_limited` with the reason. Row added to
  `docs/rate-limits.md`.
- Docs: `docs/guide/admin/git-organizations.md` (Repos section) updated.
- Script fix: `db:rebase` printed "a plain git merge is enough" when run by `onto-main.sh`; reworded.
  `docs/parallel-work.md` explains calling `onto-main.sh` by path from main for an old branch.

## Evidence

- ac-1, ac-2, ac-3: `services/server/src/git-mirror.db.test.ts`, "a Repo too large to mirror is
  not downloaded again (KOBE-818)".
