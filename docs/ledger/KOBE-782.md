# KOBE-782: Skill evals and drafts: lock the draft on Save version and eval start, settle executions of closed eval runs, page listReviews; P2-12 eval rights

- **Status:** in review (group 79, branch `group-79-skills-scan-evals`)
- **Branch / worktree:** `group-79-skills-scan-evals` in `../Kobe-g79`
- **Depends on:** KOBE-781 (same branch)

Review pass 2 findings P2-12, P2-36, P2-37, P2-38, P2-40 (private findings file). Each was checked
against the code first; all held as described.

## Decisions

- **P2-12 (owner decision, Chris 2026-11-22).** Evals of a team version follow its review
  (`teamVersionGate` in `skills/evals/start.ts`, used by start and estimate alike): any member
  once it is approved and not suspended; while pending, suspended, or without a review row only its
  uploader and holders of `team.skills.publish` or `team.skills.review` (`403 review_pending`);
  nobody once rejected, not even its uploader or a Team admin (`403 review_rejected`). The
  misleading comment ("a team version passed the team's review") is replaced. The ticket text's
  "record as pending decision" is superseded by the decision.
- **P2-36.** Save version (`skills/drafts/save.ts`) and an eval start of a draft
  (`skills/evals/start.ts` `loadPackage`) read the draft with `visibleDraft(..., true)`
  (`FOR UPDATE`, the lock writers take), so the revision checked or recorded and the files read are
  the same snapshot.
- **P2-37.** No new state (that would need a migration): a closed run's queued executions are
  deleted (`settleClosedExecutions` in `skills/evals/store.ts`) when the run is cancelled (route,
  departed starter, offboarding), failed (runner, agent unavailable) or budget-stopped, and when a
  replica puts back an execution of a closed run (`requeueExecution`, `recordAttempt`'s stale
  branch). Done executions stay as partial results; rows under a legal hold stay (the hold trigger
  skips the delete). `hasQueuedExecution` only counts open runs, so the 5 s sweep skips a team
  without taking its lock. The reaper's per-team pass settles every closed run, including rows an
  older release left. Views only ever read `done` results, so nothing visible changes.
- **P2-38.** `listReviews` reads the page's rows through `reviewRowsOf`, filtered on the
  `(skill_id, version)` pairs of the page (blocklist and semver lookups now run over those rows
  only).
- **P2-40.** Pure-move split in a file this branch touches: see the separate refactor commit
  (`routes/team-skill-review.ts`, `routes/skills.ts`). Left for later (files not touched here):
  `routes/site-skill-registry-review.ts` `registryReviewRoutes`, `skills/team-installs.ts`
  `installCatalogSkill`, `routes/skill-evals.ts` `skillEvalRoutes`, `skills/registry/retire.ts`
  `retireVersion`, `skills/site-edit/site-publish.ts` `publishSiteDraft`;
  `skills/evals/events.ts` `skillEvalEventStream` belongs with KOBE-704.

## Review fixes (coordinator review of group 79)

- **Gates re-checked on claim.** The eval gates moved to `skills/evals/gates.ts`
  (`evalSubjectGate`: blocklist, team version review, test-chat gates). `claimNextExecution`
  runs them again for each execution it claims (with the starter's current role); a refusal fails
  the run with that code and message (`review_rejected`, `review_pending`, `skill_blocklisted`,
  ...) and settles its queued executions, so a version rejected, suspended or blocklisted after the
  start never runs. Test: `skill-eval-runner.db.test.ts` "re-checks review and blocklist when an
  execution is claimed".
- Not changed (out of scope, advisory): `drafts/scan-preview.ts` and `drafts/test-bundle.ts` read
  draft files without the row lock (cache keyed by hash or rev); candidates for the same
  `visibleDraft(..., true)` change later.

## docs/guide evaluation

- `docs/guide/agents/skills.md`: who may run the evals of a saved team version (approved: any
  member; waiting for review or suspended: who saved it, contributors, team admins; rejected:
  nobody).
- P2-36, P2-37, P2-38: no visible change (a stale save was already refused; settled executions
  were never shown; the queue's contents are the same), so no page changes.

## Open questions (for Chris or the coordinator)

- The web app may still offer **Eval** on a pending or rejected version to a plain member; the
  server now refuses with a message. Hiding the button is a possible follow-up.

## Evidence (acceptance criteria → test or command output)

- P2-12: `skill-eval-runner.db.test.ts` "evals of a team version follow its review ...".
- P2-36: `skill-drafts.db.test.ts` "reads the draft under its row lock ..." and
  `skill-eval-runner.db.test.ts` "an eval start reads the draft under its row lock ...".
- P2-37: `skill-eval-runner.db.test.ts` "settles the queued executions of a closed run ...".
- P2-38: `skill-review.db.test.ts` "review rows of a page (P2-38)".
