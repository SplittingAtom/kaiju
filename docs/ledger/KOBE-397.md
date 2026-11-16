# KOBE-397: SMB9: Workspace proposals and curator approval

- **Status:** in review (commits on `kobe-397-sm`; coordinator opens the PR)
- **Branch / worktree:** `kobe-397-sm` in `../Kobe-wt397` (based on `kobe-396-sm`, PR #585)
- **Depends on:** KOBE-389 (`memory_proposals`), KOBE-380 (stewards), KOBE-396 (To review),
  KOBE-645 (notification kinds, reminder and digest)

## Plan

No migration, no protocol change (wire types live in the routes and
`apps/web/lib/memory/proposals-api.ts`).

- Server `services/server/src/memory/proposals/`: `rows.ts` (read, lock, queue, mine),
  `propose.ts` (Propose… and one-click re-propose), `decide.ts` (approve, request changes,
  dismiss), `list.ts` (queue cards with live checks; a member's own), `notify.ts` (curators, notices).
- Routes: `POST /v1/memory/review/candidates/:id/propose`; `/v1/memory/proposals`
  (`GET /`, `GET /mine`, `POST /:id/approve|request-changes|dismiss|repropose`).
- Web: `components/memory/review/propose-action.tsx` (the card's one new action, its own component
  beside Save; KOBE-398 adds its own beside it), `components/memory/proposals/*` (curators' queue
  in Workspace console › Memory › **Proposals**, **Your Workspace proposals** on My memory).

## Decisions

- **Who proposes:** members who don't curate (`team.memory.curate` false). Curators get 400 and save
  directly; their Workspace save is already audited as `memory.candidate.accepted` with their actor
  id (test added).
- **What may be proposed:** the caller's own open candidate (KOBE-396 `lockCandidate`), `add`
  only, `team` in `allowedScopes` (never inferred), `quotesThePerson` at click, Workspace memories
  switched on. Hard checks (length, secrets) refuse; warnings and Policy conflicts don't stop a
  proposal: the queue evaluates them live and the curator saves over them (audited) at approval.
- **Evidence/thread** stay on the candidate (`candidate_ref`); the queue joins them. No evidence
  column was needed. A purged thread leaves the proposal with statement, kind and note only.
- **Candidate states:** proposing sets `proposed` + `payload.proposal_id`. Request changes reopens
  it (`open`, `payload.returned.proposal_id`, `expires_at = greatest(own, proposal's)`); proposing
  it again copies the returned proposal's `expires_at` (request rounds don't reset the clock).
  Dismiss leaves the candidate `proposed`.
- **Outcome without a column:** both turn-downs are `state = 'rejected'` + reason (the table's
  CHECKs allow no reason while pending). "Sent back" vs "dismissed" for the proposer is derived:
  `back_in_review` = candidate open with `returned.proposal_id` = this proposal; the audit row
  (`memory.proposal.dismissed.outcome`) and the bell kind carry the exact outcome.
- **Approval** writes through the item store as the curator (`createItemIn`, actor kind `user`:
  Workspace versions allow no `proposal` actor kind without a migration; the link is in
  `memory.proposal.accepted`). No `source_thread_id` (curators may not read the thread).
- **Self-approval:** any decision by the proposer is 403, even after they became a curator.
- **Expiry:** pending past `expires_at` is treated as expired (not decidable; `state: expired` in
  lists). Re-propose (proposer only, candidate and thread still there) marks it `expired` and adds
  a new proposal with a fresh 30-day clock. The sweep itself is KOBE-651.
- **Notices:** received → curators except the proposer (+ reminder per curator, `about:
memory.proposal.received`); decided → reminders settled, proposer gets
  `accepted|changes_requested|dismissed` with the curator as actor. Digest is the machinery's.
- **Audit:** `memory.proposal.created|accepted|dismissed` registered (ids and flags only);
  docs/audit-log.md rows; contract test now expects the proposal actions registered.

## Open questions (for Chris or the coordinator)

- Proposing an existing personal item (`source = 'item'`) is not offered (not in this scope).
- Curators see an **Open the conversation** link; it only opens if the thread is shared with them.
- No gate1 browser spec: needs a real learning pass (as KOBE-396).

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/memory-proposals.db.test.ts` "approves (edited) as the curator: in
  every member's next run; the proposer hears" (`buildRunSemantic` for another member picks it).
- **ac-2** same file: "refuses self-approval, even once the proposer curates", "curators save their
  own candidates directly, audited with the author"; web `proposals.test.tsx` (no decision on
  one's own).
- **ac-3** same file: "reminds each curator after 7 days …", "rolls a curator's sixth proposal
  notice … into the digest", "an expired proposal … proposed again with one click", "request
  changes: back in To review; proposing again keeps the clock".
- **ac-4** `docs/guide/memory.md` (Propose a memory to the Workspace; Decide on proposals;
  notifications; summary for /llms.txt).
