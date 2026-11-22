# KOBE-739: Rebuild a workspace from the last sync when its volume is lost (review STO-8)

- **Status:** in review (group 72, branch `group-72-volume-lost-provider-split`)
- **Branch / worktree:** `group-72-volume-lost-provider-split` in `../Kobe-g72`
- **Depends on:** KOBE-733 (group 63: wake-after-reclaim restore path, `workspace_quota_exhausted`)

## Plan

Detect a lost workspace volume during the wake and from a status route, fail the wake with its own
code, let the member (or a team admin) confirm a rebuild that discards the claim and volume, and
let the next wake restore from object storage exactly like a wake after a reclaim (KOBE-733).

## Decisions

- **ac-1, owner decision (Chris, 2026-11-20): MEMBER-CONFIRMED rebuild, never automatic.** No Site
  grace or timer rebuilds anything; the member or a team admin confirms after seeing the last sync.
- **What "lost" means** (`sandbox/volume-loss.ts`, read-only, Kubernetes API only): the claim is
  `Lost`; or it is bound to a PV that is missing or `Failed`; or the volume is pinned to one node
  (PV node affinity `kubernetes.io/hostname In [one]`, as local-path writes it; or a Longhorn CSI
  PV with `numberOfReplicas: "1"` and `dataLocality: strict-local`, whose node is the claim's
  `volume.kubernetes.io/selected-node`) and that node does not exist (hostname label list empty /
  GET 404) or not Ready, held for the grace period (see review g72 fixes below). Anything
  else, replicated volumes, a pending claim, and any read error are "present" (never offered).
  Risk (false positive = unsynced work destroyed): a node down > 10 min that comes back. Mitigated
  by member confirmation with the last sync shown, and by the confirm-time re-check.
- **Stall diagnosis**: new cause `volume_lost` (definite, checked first; only when the PVC exists;
  a read failure is no diagnosis). `ensureReady` maps it to `SandboxWakeError("workspace_volume_lost")`
  with its own member text (no cluster names); added to `FAILURE_MESSAGES`, branch summary,
  compaction, thread context and notebook mappings like `workspace_quota_exhausted`. Audit
  `sandbox.wake_stalled` cause enum gains `volume_lost`; `REMEDY` names the rebuild.
- **Rebuild** (`sandbox-lifecycle/rebuild.ts`, `deps.workspaceRebuild`, provider set in index.ts
  like offboarding's; only with workspace sync, else 503 `rebuild_unavailable`): in `withTeam`,
  `lock_timeout 10s`, shared legal-hold lock, sandbox row `FOR UPDATE`; refuses no row (404
  `no_workspace`) and `destroyed` (409 `workspace_offboarded`); **re-checks `volumeHealth` under
  the lock** (`present`/unknown → 409 `volume_reachable`; `missing` → 200 `already`, idempotent);
  then `provider.discardLostVolume` (claim deleted with `retainVolume: false`, the old pod
  force-deleted with grace 0 only when it sits on the lost node, PVC deleted), row → `hibernated`
  with sandbox/pvc/proof cleared (next wake = new claim + startup restore, the KOBE-733 path),
  open connection rows closed (+ `hib` hint), audit `sandbox.volume_rebuilt`. A Kubernetes or lock
  failure rolls back: 503 `rebuild_failed`, nothing changed. Kubernetes runs under the row lock
  (as reclaim does); a concurrent wake waits, then finds the row hibernated.
- **Legal hold**: allowed (only Kubernetes objects of an unreachable volume are deleted; object
  storage and DB rows untouched), audited `legalHold: true`. Never shown to the member.
- **Audit** `sandbox.volume_rebuilt` (team): `sandboxId?`, `userId`, `reason`, `lastSyncedAt`
  (`workspace_sync.last_push_at`), `legalHold`, `byAdmin`; actor = who confirmed. No node names
  (team admins read the team log); the server log has the detail. Site view: `lastSyncedAt`,
  `byAdmin` allow-listed.
- **Routes** (OpenAPI catalog + openapi.json): member `GET/POST /v1/workspace/rebuild`
  (`team.chat`), admin `GET/POST /v1/team/workspaces/{userId}/rebuild` (`team.members.manage`).
  POST body `{confirm: true}`. GET reads the cluster live (3 GETs); no DB marker, so no migration.
- **RBAC**: orchestrator ClusterRole gains `persistentvolumes: get`, `nodes: get, list`
  (cluster-scoped, read-only); chart test added.
- **Web**: `lib/workspace/rebuild.ts` (`FilesApi.rebuild`); `RebuildWorkspaceDialog` (status first:
  last sync + what is lost; Rebuild only when `rebuildable`); `VolumeLostNotice` under a run that
  failed `workspace_volume_lost` and in the Files panel (one status GET on mount); admin section
  "Rebuild a lost sandbox" on Workspace settings → Storage and history.
- **Docs**: install.md (strict-local trade-off, rebuild, detection and its risk, RBAC, cause list),
  guide `files/storage-limits.md` (new section), `reference/troubleshooting.md`,
  `admin/team-admin.md`, `for-agents/working-in-a-sandbox.md` (agents cannot observe the state:
  the sandbox is not running; they can see missing unsynced files after a rebuild),
  `docs/audit-log.md`.

## Review g72 fixes (commit on top)

- **HIGH, grace period:** a missing or not-Ready node is now `node_down`, not lost. The server
  stores its first observation per sandbox (`sandboxes.volume_lost_since`, migration 0241, server
  clock only; any observation of the node back clears it) and counts it lost only after
  `sandbox.volumeLoss.graceMinutes` (chart, default 30). Before that the wake fails
  `workspace_volume_unreachable` and the status says `unreachable` with `offer_at`; a confirm
  answers 409 `volume_not_yet_lost`. Claim `Lost`, PV missing/`Failed` stay immediate. No
  `lastTransitionTime` is compared any more.
- **HIGH, 1b:** shipped the FALLBACK. Keeping the old claim needs a generation in the claim name
  (`claimName(userId)` is assumed in claims, readiness, volumes, isolation and the identity check
  that maps a pod to its claim, plus the KOBE-733 terminating-volume wait; and the real PVC name
  depends on the warm-pool Sandbox name, unverified): more than half a day and security-sensitive.
  Instead the dialog, the failure message, the notice and the guide say plainly that a server that
  comes back does not bring the unsynced changes back.
- **MEDIUM, state machine:** `sandboxes.rebuild_started_at`; the confirm marks it and writes the
  audit in the locked transaction and commits before any cluster delete; `completeRebuild`
  deletes (idempotent) and resets; a failure answers 503 `rebuild_pending`, wakes answer
  `workspace_rebuilding`, and the next confirm or the hibernation sweep (rebuilds unfinished > 1
  min, 10 per team) finishes it. 503 `rebuild_failed` text no longer claims nothing changed.
- **MEDIUM, RBAC switch:** `sandbox.volumeLoss.detection` (default on) gates the PV/Node rules and
  the server reads; off = never lost. install.md says there was no k3d/cluster test.
- **LOW:** status GET rate limited (burst 20, 1 per 5 s per caller) and cached 30 s per member
  (confirm always live); audit carries `node` and `firstSeenAt`; Longhorn `selected-node`
  reliance documented (no VolumeAttachment/CRD reads); a pod on a missing or not-Ready node is
  force-deleted for every loss reason.

## Open questions (for Chris or the coordinator)

- Unverified on a real cluster: that Longhorn CSI PVs carry `dataLocality`/`numberOfReplicas` in
  `spec.csi.volumeAttributes` (they copy StorageClass parameters) and that strict-local PVCs get
  `volume.kubernetes.io/selected-node` (WaitForFirstConsumer). If either is absent, strict-local
  loss is never detected (safe direction): only PV `Failed`/missing and claim `Lost` remain.
- A Longhorn-faulted volume on a node that is still Ready is not detected (no Longhorn CR reads).
- No k3d e2e (no cluster run in this worktree); covered by unit, provider and db tests below.
- 10-minute node grace is a constant, not a chart value.

## Evidence (acceptance criteria → test or command output)

- ac-1: decision above.
- ac-2: `services/server/src/workspace-rebuild.db.test.ts` (discard, row reset, connection closed,
  audit; refused when reachable at confirm; double click once; legal hold audited; Kubernetes
  failure changes nothing; offboarded/none refused; next wake starts a new sandbox; admin as actor,
  permission); `sandbox/provider-volume-loss.test.ts` (no retain, force-delete only on the lost
  node, idempotent); `sandbox/volume-loss.test.ts`; `sandbox/stall-diagnosis.test.ts`;
  `sandbox-lifecycle/ready.test.ts`; `charts/kobe/tests/sandbox.test.ts` (RBAC).
- ac-3: status route returns `last_synced_at` (db test); web `components/files/volume-lost-notice.test.tsx`,
  `components/chat/conversation.test.tsx` ("offers to rebuild…"), `components/admin/team/storage-page.test.tsx`;
  guide and install.md updated as listed.
