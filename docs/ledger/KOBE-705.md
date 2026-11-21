# KOBE-705: Stop swallowing fire-and-forget failures (review CODE-27, CODE-41)

- **Status:** in review (group 55)
- **Branch / worktree:** `group-55-listen-connections` in `../Kobe-g55`

## Decisions

- `services/server/src/async-util.ts` `fireAndLog(log, what, work, context?)`: warns
  `<what> failed` with `err` (and context), never throws, survives a throwing logger, accepts
  `undefined` work (optional seams like `deps.mounts?.`).
- Replaced: `routes/budgets.ts` (the two `budgets.evaluate` lines, plus one import line for the
  logger), `projects/commits.ts` x2 and `projects/from-proposal.ts` (`mounts.reconcileProject`),
  `skills/evals/runner.ts` (heartbeat; the two awaited `runs.cancel` now log their error),
  `skills/evals/reaper.ts` (`runs.cancel`), `startup/jobs.ts` (`startServerJobs(jobs, log)`: each
  stop error logged with the job name, the others still stop), `index.ts` (skill eval shutdown error).
- `revertTo` deps gained `log` (it reconciles mounts too); the route passes the server logger.
- Grep of the rest, left alone on purpose: request-body parsing (`c.req.json().catch`, CODE-18's
  lane), dead-client/socket/stream cleanup (`end()`, `cancel()`, a Job delete after a failed scan,
  `pg_advisory_unlock` in setup), queue chaining (`schedules/user-lock.ts`), the vector-leg race
  (a timeout decides), `memory/embeddings/service.ts` background cache refreshes (the stale value
  stays and the next caller retries; a log on every transient refresh failure would be noise),
  `uploads/parse.ts` and `connectors/oauth/http.ts` (unhandled-rejection guards on promises that
  are awaited elsewhere).

## Evidence

- ac-1: `async-util.test.ts`.
- ac-2: `startup/jobs.test.ts` (failing stop logged with the job name, others stopped).
- ac-3: `budgets.db`, `projects*.db`, `project-commits*.db` green.
- Docs: no member/admin-visible change (log lines only); no guide change.
