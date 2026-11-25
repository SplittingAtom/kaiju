# KOBE-827: RN-14: sandbox folder .kaiju/, Pi entry types and provider id, with a migration

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (no PR yet; branch only)
- **Branch / worktree:** `group-132-rename-14-folder` in `../Kobe-g132`, stacked on
  `group-131-rename-13-connector` (KOBE-826, PR #728)
- **Spec:** `docs/specs/rename-kaiju.md` §11 answer A4 (rename, with a migration that includes the
  workspace volumes); tooling `scripts/rename/README.md`

## What changed

- **Step file** `scripts/rename/steps/RN-14.txt` = the RN-14 group; applied with `rename.mjs`:
  354 occurrences in 168 files. One wrong swap fixed by hand: `docs/skill-package.md` names the
  manifest key `compatibility.kobe` as `.kobe` (RN-12's, now an entry in RN-12's permanent group).
  The RN-14 group is gone; two narrow permanent groups replace it (below).
- **The move** (`services/sandbox-agent/src/workspace/state-folder.ts`), called in `index.ts`
  right after the config check, before workspace sync, Pi identities' use of the volume, kernels,
  skills or the wire start. Algorithm (lstat only, never follows a link):
  1. no `/workspace/.kobe` → nothing (fresh volume, or already moved): no report;
  2. `.kobe` not a real directory (link, file) → left alone, `not_a_folder`;
  3. `.kaiju` absent → one `rename(2)` (same directory, same filesystem: atomic) → `moved`;
  4. `.kaiju` is a link → `unlink` (a link holds no data; its target is untouched), then 3;
     `.kaiju` is an empty directory → `rmdir` (refuses a non-empty one), then 3;
  5. else, `.kobe` empty → `rmdir` it, `removed_empty`;
  6. else both hold data → nothing touched, `conflict`, reported at every start.
     Any error → `failed` with the errno code; `.kobe` is intact (the only step on it is the rename
     or an `rmdir` that only succeeds when empty); the next start tries again. There is no copy, so
     no half-moved state exists; a crash between 4 and 3 leaves the plain case 3 for next time.
- **Report:** `hello.state_folder` `{outcome, code?}` (optional, strict; sent only when there was
  an old folder; sandbox → server frames stay strict, the server is never older). The server logs
  it with the sandbox id (`info` for moved/removed_empty, `warn` "needs a person" otherwise); the
  agent logs it too. **No member notice path exists** that fits (sync-conflict notes need a path
  pair and hashes, and are model-facing); the guide tells the in-sandbox agent what an old
  `.kobe/` next to `.kaiju/` means and to tell the member.
- **Sync / paths:** `WORKSPACE_EXCLUDED_PREFIXES = [".kaiju/", ".kobe/"]`: both names agent-internal
  for good (sync push/pull/restore, server `isInternalPath` for browse, move, notebooks, projects,
  thread-file map, sync conflicts; web tree, Save as and mentions now call `isExcludedPath`;
  `share_file`). Temp files `.kaiju-sync-*`; `.kobe-sync-*` left by an interrupted download on the
  old image are still skipped (`isSyncTempName`). Evictions go to `kaiju-moved/`; an existing
  `kobe-moved/` is member data (synced) and stays.
- **Policy (never widen, as KOBE-826 H1):** deny and ask rules (site, team, MCP App bridge) and the
  agent's `tools.deny` also match the input with the folder's name swapped where it is a whole path
  segment (`policy/state-folder-views.ts`, `swapStateFolderName`): a rule on `/workspace/.kobe/**`
  protects `.kaiju/**`, and one on `.kaiju/**` protects a leftover `.kobe/**`. Allow rules,
  remembered approvals and `tools.allow` never match the swapped view. Permanent. No other path
  rule names the folder (kaiju-policy and the tools check through the server and `isExcludedPath`).

## Decisions per name

| Name                                                                        | Where it lives                          | Decision                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/workspace/.kobe/`                                                         | volumes                                 | moved at wake (above); old name internal forever                                                                                                                                                                                                                                            |
| `kobe.branch`                                                               | Pi session files, `thread_entries`      | write `kaiju.branch`; server (run prompt) and web (tree) read both, permanent                                                                                                                                                                                                               |
| `kobe.app_card`                                                             | `thread_entries`, sessions, `run.start` | write new; schema and readers accept both (stored rows go to the agent as stored); an agent without hello capability `kaiju_names` (old image) gets cards under the old type, one release                                                                                                   |
| `kobe.skipped_actions`                                                      | `thread_entries` (server-written)       | write new; `isSkippedSummaryEntry` and the Pi-entry filter take both, web reads both, permanent                                                                                                                                                                                             |
| Pi provider id `kobe`                                                       | `model_change` and answers in sessions  | register `kaiju`; kaiju-models' `branchIsOn` treats `kobe/<m>` as the same model (else Pi records a spurious same-model `model_change`, proven by the negative control); server run-prompt setup check accepts it; a planted `kobe` provider is a new redirect variant (refused); permanent |
| `kobe.model_error:`                                                         | live errorMessage                       | server parses both, one release (KOBE-754)                                                                                                                                                                                                                                                  |
| `kobe.event_dropped`                                                        | live wire only                          | renamed; an old agent's is "any other type: accepted, no effect" already                                                                                                                                                                                                                    |
| `kobe-memory-picks`, `kobe-sync-conflict`                                   | model-call context only, never stored   | renamed, no reader of the old names needed                                                                                                                                                                                                                                                  |
| `/kobe-branch-summary`, `kobe.branch_summary(_result)`, `kobe-context.json` | per-launch Pi extension / tmpfs         | renamed (same image on both sides)                                                                                                                                                                                                                                                          |
| `kobe.notebook.html`                                                        | postMessage, server frame ↔ web         | renamed (served together; a tab open across the upgrade resizes after reload)                                                                                                                                                                                                               |

Session files are **not rewritten** at wake: Pi ignores custom types, resumes with an unknown
recorded provider by using the launch model (verified with real Pi 1.4.0), and Postgres stays the
record (D15).

## DB decision

**No data migration.** No table stores a path under the folder as data: every writer refuses the
agent-internal area (workspace manifest via sync `read_only`, `files` shares, thread-file map,
sync conflicts, mentions, notebooks, project import/promote). Conversation history
(`thread_entries`, run events) keeps the paths and entry types it was written with (append-only,
as KOBE-826 kept history); readers accept both types. Stored rules naming `.kobe` keep protecting
through the runtime swap (deny/ask), so no rule rewrite is needed and none is widened.
Risk noted for the coordinator: files a member stored under a top-level `.kaiju/` before the
upgrade become internal (still in S3, no longer shown or restored); check gate1 first (below).

## Kept old names (allowlist)

- permanent "Names the sandbox wrote into workspace volumes, Pi session files and thread entries
  before the rename": the move, its report, the exclusions, temp prefix, entry types, provider id,
  the policy swap, their tests and docs. **Permanent** (stored data never rewritten).
- permanent "The model-error prefix `kobe.model_error:`": **remove in KOBE-754**, with the
  `kaiju_names` capability bridge (`withPreRenameAppCards`, `CAPABILITY_KAIJU_NAMES`).
- RN-12's group gained the `docs/skill-package.md` manifest-key line. Self-test samples updated.

## For the coordinator to test on gate1 (live)

1. Before deploying, on gate1 (as the owner role, past RLS):
   `SELECT count(*) FROM workspace_files WHERE NOT deleted AND (path LIKE '.kaiju/%' OR path = '.kaiju')`;
   expected 0.
2. **Dirty repo:** in a Repo conversation, make an unpushed commit plus uncommitted and staged
   changes in `/workspace/.kobe/repos/<slug>` before the upgrade; after it, the first run sees them
   in `.kaiju/repos/<slug>` (`git status`, `git log`), and no `.kobe` exists.
3. **Hibernated sandbox:** hibernate one before the upgrade, wake it after: server log
   `sandbox folder moved from .kobe to .kaiju` with its sandbox id; old conversations continue
   (no "Model changed" marker after the upgrade; edit/regenerate on old branches works).
4. **Lost volume:** delete a sandbox's PVC; the rebuilt sandbox restores into a fresh workspace
   with only `.kaiju/` created on demand, no `.kobe`, sessions restored from the server.
5. Running sandboxes on the old image keep `.kobe` until they restart; app cards and runs keep
   working on them meanwhile (old type sent to them).

## Docs evaluation

Members, admins and in-sandbox agents see the folder name, so the guide changes (ac-4):
`whats-new.md` (the move, conflicts, `kaiju-moved/`), `files/workspaces-and-projects.md`,
`for-agents/working-with-git.md` ("An old `/workspace/.kobe/` folder": never create it, never
merge, recover unpushed work with git); the script renamed `.kobe/` to `.kaiju/` in
`files/storage-limits.md` and the operator/design docs. Operators: `install.md` upgrade note
(algorithm, log lines, conflict handling, rollback, the pre-check). `/llms.txt` and
`/docs/<slug>.md` are generated from these pages.

## Evidence (TMPDIR=~/tmp)

- `rename.mjs --step RN-14` dry run then apply; `guard.mjs` ok; self-test 24/24.
- build, typecheck, lint, format:check, `db:check` (no changes), public hygiene, site wording,
  guide (33): pass.
- Whole DB suites: db 2193 passed, server 3760 passed (one new: skipped notes of both names).
- Unit: protocol 1400, db 1113, server 4610 (8 skipped), web 4351, sandbox-agent 1447 (58
  skipped) with the pinned Pi installed, so the real-Pi suites ran here.
- New tests: `workspace/state-folder.test.ts` (11: dirty copy by inode, real git status/log/fsck,
  second run, fresh volume, never recreated, empty `.kaiju`, half-copied `.kaiju` = conflict,
  empty `.kobe`, planted `.kaiju` link out of the volume, `.kobe` link/file, failed rename,
  crash after rmdir); real Pi `kaiju-models.model-change.real-pi.test.ts` resume of an old session
  (provider `kobe`, `kobe.branch`) with no switch, plus its negative control by hand; redirect
  suites with the planted `kobe` provider (15 passed); policy `evaluate.state-folder.test.ts`
  (7) and the MCP App bridge case; protocol `state-folder.test.ts` (5); server run prompt, run
  start and hello log; web `pre-rename-entries.test.ts` (3) and path refusals; sync exclusions
  and restore of both names; DB `skipped-summary-names.db.test.ts`.
