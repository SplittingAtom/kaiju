# KOBE-636: Evicted sandbox (home over 1 GiB) is never replaced; every wake fails until a manual hibernate

- **Status:** in review (local commit, no PR yet)
- **Branch / worktree:** `kobe-636-sandbox-evicted` in `../Kobe-wt636`
- **Depends on:** none (KOBE-607 runs in parallel; see "Shared code" below)

## Cause

agent-sandbox v1.0.4 (`controllers/sandbox_controller.go`, `reconcilePod`) starts a pod only when
the Sandbox has none; an existing pod in phase `Failed` (evicted) is kept and the Sandbox only
reports `Ready=False, reason PodFailed`. Kobe's `provision` (wake) accepted that owned pod as the
running sandbox and `awaitReady` waited the full 90 s budget for a pod that can never be Ready
(`classifyStall` had no rule for it: `unknown`, "pod Failed, volume Bound"), then failed
`workspace_unavailable`. Every wake repeated that until `lifecycle.js hibernate` (Suspended deletes
the pod, Running starts a new one).

## Decisions

- **Replace by deleting the ended pod, once per wake** (`provider.ts` `provision`, wake path only):
  the controller starts a new pod when its pod is gone (verified in the v1.0.4 source), so no
  suspend/resume race (a resume patched before the controller removed the Failed pod would find it
  again). Claim, Sandbox and the workspace PVC are untouched. `isolation.require()` still runs first
  and the new pod goes through the same RuntimeClass/handler checks. `ensureSandbox` (no wake) never
  deletes.
- **Never loop:** at most one delete per wake; if the new pod ends too, `awaitReady` reports
  `pod_failed` at once (definite) and the wake fails `sandbox_failed` with a member message. The next
  message tries once more (bounded by the member's own actions).
- **Visibility:** team audit `sandbox.restarted` {cause, podReason} (kubelet text stays in the server
  log: it names volumes/limits); warn log "sandbox pod had ended: replaced it" with phase, reason and
  message; `wake_stalled` gains cause `pod_failed`; lifecycle metric `restarted`.
- **Member message:** `sandbox.waking` gains `restarted_out_of_space` / `restarted_out_of_memory` /
  `restarted` (additive protocol enum values; the coordinator may want this as its own PR per
  parallel-work.md). Steering panel: "Your sandbox ran out of temporary space and is restarting. My
  files are kept; …". New run failure code `sandbox_failed` (FAILURE_MESSAGES + compaction,
  branch-summary, thread-context and notebook maps).
- **Home limit (ac-4):** keep 1 GiB. It already is a chart value (`sandbox.homeSize`, with
  `tmpSize`); documented in install.md, the guide's storage-limits ("Sandbox temporary space"),
  troubleshooting and the For agents page (install into `/workspace/.venv` / project `node_modules`,
  which the backup skips).
- **Not done here: redirecting caches by env** (`XDG_CACHE_HOME`, `npm_config_cache` →
  `/tmp`): HOME/TMPDIR are switched per Pi identity and per tool call (KOBE-71/196, BASH_ENV
  script, uid reclamation of shared trees); a shared cache dir across uids risks EACCES. Follow-up.

## Shared code (KOBE-607)

Touched wake code, kept minimal: `lifecycle.ts` `wakeOnce` gains one line (announce a replacement)
plus a new helper `announceRestart`; `provider.ts` `provision`/`wakeSandbox`; `ready.ts`. No change
to the run orchestrator or sandbox-agent.

## Follow-ups

- Point npm/XDG caches away from `$HOME` per identity (sandbox-agent tool env), or clean them.
- Tell the agent (system prompt or a first-turn note) that `$HOME` was wiped by a restart.
- Warn before home fills (agent-side `du` on `$HOME` near the limit).
- Usage views: the restart shows in the audit log only (no usage-page counter).
- ac-5 (gate1 regression: fill home past the limit, next message recovers) needs this deployed.

## Evidence

- ac-1: `sandbox/provider-lifecycle.test.ts` "wakeSandbox on an ended pod (KOBE-636)" (deletes the
  Failed pod once, new pod, claim kept, isolation first, at most once); `sandbox/pod-termination.test.ts`;
  `sandbox-lifecycle.db.test.ts` "an ended (evicted) sandbox pod" (run told, new pod gets run.start).
- ac-2: steering text test (`apps/web/lib/chat/steering.test.ts`); `ready.test.ts` (`sandbox_failed`
  text = FAILURE_MESSAGES); db test (command fails `sandbox_failed` fast, one wake).
- ac-3: `provider-stall.test.ts` (pod_failed with the eviction reason, not `unknown`); audit
  `sandbox.restarted` test; db test (`wake_stalled` cause `pod_failed`).
- ac-4: docs above. ac-5: pending deploy.
- gate1 (read-only, 2026-11-18): no Failed sandbox pods now; Sandbox status/volumes confirm
  `home` emptyDir sizeLimit 1Gi, `tmp` 2Gi.
