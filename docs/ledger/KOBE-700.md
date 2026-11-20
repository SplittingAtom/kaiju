# KOBE-700: Security chores: scanner fixture password, shell-safe e2e shard input, approval-key comment (SEC-11, SEC-12, SEC-14)

- **Status:** in review (group 50, branch `group-50-sec-platform`)
- **Branch / worktree:** `group-50-sec-platform` in `../Kobe-g50`
- **Depends on:** none

## Decisions

- SEC-11: the skill-scanner fixture now uses `not-a-real-password`. `check-public-hygiene.sh`
  matches credentials that leaked once by SHA-256 (list `leaked_sha256`), so the script itself
  never spells them out: it hashes every URL userinfo password (`scheme://user:password@`) and
  every `*PASSWORD*=`/`*PASSWORD*:` value in tracked files (about 150 hits, a second or so). History
  is accepted, not rewritten; rotating the dev database password is the owner's item.
- SEC-12: `e2e.yml` passes the shard to the image-loading step through `env: SHARD` (it was the
  only `${{ matrix.shard }}` inside a `run:` script), and a first step "Known shard name" fails
  the job for any shard name outside the fixed list. The other workflows have no
  `workflow_dispatch` inputs and no input-derived values in `run:` scripts (checked with grep:
  `inputs.`, `github.event.inputs`, `head_ref`, PR/issue titles); their `matrix.name` values are
  static lists in the workflow.
- SEC-14: `approvals/keys.ts` now says only the server holds the key (signs and verifies, also
  on the MCP proxy's re-check, KOBE-520). "Session-keys Secret" is the Secret's real name
  (`sandbox.sessionKeysSecret`, mounted on the server only), so docs/install.md stays.
- Docs: none needed; no member, admin or agent-visible behaviour changes.

## Review follow-up (coordinator, 2026-11-20)

- The assignment pattern is now case-insensitive (`git grep -i`), so `password: "…"` in YAML or
  JSON is caught too (checked with a probe file); the run takes a few seconds longer.

## Open questions (for Chris or the coordinator)

- Owner: rotate the dev Postgres password (SEC-11).

## Evidence (acceptance criteria → test or command output)

- ac-1: `git grep` finds the old value nowhere; `scripts/check-public-hygiene.sh` with the old
  fixture restored (`git stash`) fails with `scanner.test.ts:219: a credential that leaked before
(sha256 82cdbaf27703...)`, and on a probe file with a `*_PASSWORD=` assignment; clean tree: ok.
- ac-2: `.github/workflows/e2e.yml` "Known shard name" step and `SHARD` env.
- ac-3: `services/server/src/approvals/keys.ts` header comment.
