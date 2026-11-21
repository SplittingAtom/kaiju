# KOBE-733: Reclaim dormant hibernated workspace volumes; surface PVC quota exhaustion (review STO-1)

- **Status:** in review (group 63, branch `group-63-storage-reclaim-retention`)
- **Branch / worktree:** `group-63-storage-reclaim-retention` in `../Kobe-g63`
- **Depends on:** KOBE-741 (same branch, earlier commit; no code dependency)

## Plan

Owner decision: reclaim ships **off** (`sandbox.hibernation.reclaim.enabled: false`); dormancy
`dormantDays` (30 once turned on) is a chart value (ac-5: default chosen, disabled until then).

## Decisions

- **The proof that the object-store copy covers the volume** (reworked after review g63, HIGH:
  a proof taken by a sync-now before suspension missed files that background processes wrote
  afterwards, and the stop push was never confirmed). Now it comes only from the agent's shutdown
  path (`Agent.#finishStop`): every Pi is stopped with its uid's processes killed (tools, `nohup`
  jobs) and kernels stopped, so nothing writes any more; then the final push; then a fresh plan
  must find no change, no file left out (refused, unreadable, changing, or a scan-skipped symlink,
  special file or unsyncable name: `ScanResult.skipped`) and no lost content over a whole scan; only
  then the agent calls new sync endpoint `POST flushed {connection_id}` (`@kobe/protocol`
  `workspaceFlushedRequestSchema`). The server (`recordFlushProof`) sets `volume_synced_at` only
  when the token's sandbox is the hibernated one, the named connection is the one the hibernation
  closed (`sandbox_connections.closed_at = sandboxes.state_changed_at`, same transaction), and no
  upload is reserved. Any later upload reservation or manifest change (`clearFlushProof` in
  `reserveUpload`/`saveState`) and any wake (`beginWake`) clear it. No call (killed pod, failed
  push, timeout, older image, old server answering 404) = never reclaimed. The earlier sync-now
  `complete` variant (capability, bus hint) was removed; Refresh keeps its KOBE-599 meaning.
- **Review g63-2 hardening:** the proof also needs (a) no failed kill-all or reclaim at any time in
  the agent's life (`PiIdentities.cleanupFailed`, never reset) and (b) a quiet `/proc` right before
  the final check (only the agent, its ancestors and its own agent-uid children; zombies ignored;
  unreadable = not quiet). Without Pi identities the agent offers no proof and the server's schema
  refuses one without `pi_identities: true`. "Unchanged" now needs ctime and inode too: a file
  whose ctime is newer (or another inode) is re-hashed, and an unrecorded one (restored, pulled, or
  after a restart: the migration) is re-hashed once (all of them in the proof's strict check, at
  most 200 per ordinary push). The server locks the row before checking, so a proof that races the
  hibernation commit waits for it; `not_hibernated` gets one agent retry after 2 s. Every proof is
  logged and audited (`sandbox.volume_proof`). The reaper no longer holds the hold and row locks
  while the PVC terminates; instead the provider waits (≤ 60 s) for a terminating volume of the
  same name before creating a new claim.
- **Review g63-3 (racily clean, HIGH):** stamps are nanosecond (`bigint` stats: size, mtime,
  ctime, inode) and compared with strict equality, so a rewrite after a clock step back is caught
  too. A stamp is recorded only when the file's ctime and mtime are ≥ 2 s older than the volume's
  clock when the plan began (mtime of `.kobe/workspace-clock`, rewritten first): younger files stay
  unverified (`sync/stamps.ts`). The proof's strict pass re-hashes every unverified file after the
  quiet check; if any is still inside the window it waits it out once (≤ flush deadline) and
  re-hashes, else no proof. Liveness: verified stamps are saved on the volume
  (`.kobe/workspace-verified.json`, agent-only) at every flush and loaded at restore, so a wake on
  the same volume proves without re-hashing unchanged files. Freshly downloaded files are not
  recorded at write time: they are inside the window by definition, so the racy rule leaves them
  unverified; periodic pushes verify them (200 per push) and the next flush remembers them.
  `pi.command` is refused while draining; the /proc check fails on any read error but
  ENOENT/ESRCH; a wake whose old volume is still terminating after 60 s fails with a retryable
  `SandboxProvisioningError` (logged) instead of creating the claim.
- **What does not block, by decision:** `.kobe/` (Pi sessions and agent state; D15: sessions are
  rebuilt from Postgres, so a reclaimed volume resumes conversations), interrupted-download temp
  files, the rebuildable `node_modules`/`__pycache__`/`.venv`, and **empty folders, which are not
  preserved** (the manifest records files only). All documented in storage-limits.md and install.md.
- **Wake right after a reclaim:** the reaper keeps the row lock until the old PVC is gone
  (`awaitVolumeGone`, ≤ 60 s), so the wake (which waits on that lock) gets a fresh volume.
- **Quota lag:** quota numbers alone give cause `volume_quota` but not definite (the wake waits its
  budget); an "exceeded quota" event of this wake is definite.
- **Reaper** (`sandbox-lifecycle/reclaim.ts`, run in the existing hibernation sweep after each
  team's hibernations; no new timer): candidates hibernated longer than `dormantDays` with a proof;
  per candidate, in `withTeam()` with the legal-hold lock: row `FOR UPDATE SKIP LOCKED` and
  re-checked (`volume_synced_at <= state_changed_at`), `workspace_sync` row present with no upload
  reservation, no `workspace_blobs.lost_at` (content only the volume holds), no pending command, no
  `legal_hold_covers`. Then Kubernetes first under the lock (`destroySandbox(retainVolume:false)`,
  then `deleteVolume(pvc)`; a failed volume delete is logged and left to owner-reference GC), row
  keeps `hibernated` with `sandbox_id`/`pvc`/proof cleared, audit `sandbox.volume_reclaimed`
  `{sandboxId, userId, dormantDays}`. A failed claim delete rolls the row back; the next sweep
  retries. At most 10 per team per sweep.
- **Wake after reclaim:** unchanged code path: `beginWake` sees `hibernated`, announces "waking",
  `wakeSandbox` creates a new claim (warm pool), and the agent's startup restore fills the empty
  volume from the manifest (existing full restore).
- **Quota exhaustion:** new stall cause `volume_quota` (definite) when the workspace PVC is missing
  and the team's `kobe-team-member-quota` has no PVC or storage left (read with new RBAC `get` on
  `resourcequotas`; a read failure is no diagnosis), or a controller's "exceeded quota" event of
  this wake names PVCs/storage. The wake fails with its own code `workspace_quota_exhausted`
  (member text names the team quota, no cluster detail; `FAILURE_MESSAGES` + branch summary,
  compaction, context, notebook mappings), `sandbox.wake_stalled` carries cause `volume_quota` with
  the quota numbers and a remedy for site admins.
- **Docs:** install.md quota sizing (members x size + warm pool + offboarding holds) and the
  reclaim value; guide `files/storage-limits.md` ("When your volume is reclaimed", quota message),
  `reference/troubleshooting.md` (two entries), `for-agents/working-in-a-sandbox.md` (envs may be
  missing after a reclaim), audit-log.md.

## Open questions (for Chris or the coordinator)

- The full guide had reached the `docs_full` cap (256 KiB, `kobe-mcp/docs/index.ts`); the guide
  additions of KOBE-741/733 (trimmed to ~1.1 KB) went over it, so the cap is now 272 KiB. Any
  later guide growth hits it again: decide whether `docs_full` without a section should stay a
  hard requirement.

- ac-2 asks for a **k3d e2e** of wake-after-reclaim; not done here (no cluster run in this
  worktree). Covered instead by the db test (wake after reclaim starts a new sandbox) and the agent
  test (a proven volume restores whole onto a new empty volume). An e2e needs a sandbox image with
  this agent and `reclaim.enabled` + a 1-day dormancy forced in SQL.
- The real agent-sandbox controller's behaviour on a quota-refused PVC (event text, Sandbox
  status) is unverified; the ResourceQuota read covers it either way.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/sandbox-reclaim.db.test.ts` (off by default; proof set / not set /
  dropped after activity / cleared by wake; reclaim; refusals: no proof, not dormant, upload in
  flight, lost content, no copy, legal hold; failed delete keeps the row).
- ac-2: same file "the wake starts a new sandbox"; `services/sandbox-agent/src/workspace/sync.test.ts`
  ("restores whole onto the new volume after a reclaim", "answers false while a file stays local").
- ac-3: `sandbox/stall-diagnosis.test.ts` (quota), `sandbox-lifecycle/ready.test.ts` (code + text).
- ac-4: chart `sandbox.hibernation.reclaim` (+ schema, `charts/kobe/tests/sandbox.test.ts`), audit
  event, docs above. `workspace-events.db.test.ts`: completeness asked only of capable agents.
