# KOBE-733: Reclaim dormant hibernated workspace volumes; surface PVC quota exhaustion (review STO-1)

- **Status:** in review (group 63, branch `group-63-storage-reclaim-retention`)
- **Branch / worktree:** `group-63-storage-reclaim-retention` in `../Kobe-g63`
- **Depends on:** KOBE-741 (same branch, earlier commit; no code dependency)

## Plan

Owner decision: reclaim ships **off** (`sandbox.hibernation.reclaim.enabled: false`); dormancy
`dormantDays` (30 once turned on) is a chart value (ac-5: default chosen, disabled until then).

## Decisions

- **The proof that the object-store copy covers the volume** (the hard part). The server cannot
  read a hibernated volume, and `workspace_sync.last_push_at` proves nothing (a push only commits
  what changed; refused, unreadable or changing files stay local, and a run that wrote nothing
  never pushes). So the proof is taken **at hibernation**, while the sandbox still runs:
  1. with reclaim on, `hibernateOne` asks the member's sandbox to sync now with
     `{ complete: true }` (`SandboxWire.syncWorkspace`, new bus hint `syncc:`), waiting up to
     `syncTimeoutSeconds` (30) outside the row lock;
  2. the agent answers `ok: true` only when, after the push, a **fresh plan** finds no change, no
     file left out (refused earlier, unreadable, changing while hashed), no lost content to resend,
     over a whole scan (`WorkspaceSync.#complete`, `planPush` now reports `leftOut`/`partialScan`);
  3. the agent announces this meaning with new hello capability `workspace_sync_complete`
     (`@kobe/protocol`, additive). An agent without it is answered `not_synced` by its connection
     holder at once, so **older sandbox images never prove anything** and are never reclaimed;
  4. `markHibernated` stores the ask time in new column `sandboxes.volume_synced_at` only if
     nothing happened after the ask (no activity touch, no run of the member ended or created, no
     command created or completed); otherwise NULL. Every wake and offboarding clears it (CHECK:
     only on `hibernated` rows). A hibernated sandbox runs nothing, so its volume cannot change.
     Side effect: the Files panel's Refresh now reports `not_synced` while a file stays local only
     (more honest; documented in the protocol comment). An agent test needed its race assertion
     relaxed for this (`one === two` instead of both true).
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
