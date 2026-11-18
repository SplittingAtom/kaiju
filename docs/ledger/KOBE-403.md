# KOBE-403: SMC2: Site proposal service — two steps, request changes, merge, provenance

- **Status:** committed locally on `kobe-403-sm` (no push/PR; coordinator reviews)
- **Branch / worktree:** `kobe-403-sm` in `../Kobe-wt403` (on `kobe-402-sm`, migration PR #597)
- **Depends on:** KOBE-402 (table), KOBE-645 (notification kinds/machinery)

## Plan

Service + HTTP API, no migration, no protocol change.

- `services/server/src/memory/proposals/site/`: `rows.ts` (store, audience filters), `access.ts`
  (roles), `views.ts` (one serializer per audience), `propose.ts`, `team.ts` (step 1),
  `decide.ts` (step 2), `list.ts` (reads, checks, provenance), `notify.ts`, `schemas.ts` (zod
  bodies, kept with the service like KOBE-397's).
- Routes `routes/memory-site-proposals.ts`: `/v1/memory/site-proposals` (Workspace side, for
  KOBE-404) and `/v1/site/memory/proposals` (Site side, for KOBE-405); endpoint list in the file.
- Item store: `Op.fromProposal` makes create/edit write the Site version as `actor_kind =
'proposal'` with `proposal_id` (KOBE-376 columns); `insertVersion` takes `proposalId`.
- Audit: six `memory.site_proposal.*` events in `packages/db` `AUDIT_EVENTS` (step 1 team, step 2
  site); `docs/audit-log.md` rows; the contract test now expects every reserved name registered.

## Decisions

- **The wall (SM20).** Only statement, kind and justification are written. From a candidate the
  candidate's id goes on the candidate (Workspace side, `payload.site_proposal_id`), never on the
  proposal; the Site version's provenance is `proposal_id` only. Two views: `siteView` (names the
  source Workspace, the deciders) and `workspaceView` (no Site curator names, contract wall M6).
  Neither can carry thread data (no such columns). KOBE-406 can probe the two shapes.
- **Visibility (no RLS).** Workspace side: rows `from_team_id = active Workspace`; its curators
  (Team admins + Workspace stewards) see all, a member only their own; others 404. Site side: rows
  a Team admin confirmed (`team_confirmed_by IS NOT NULL`), Site admins + Site stewards only
  (queue 403, one proposal 404 for others). An unconfirmed proposal never reaches the Site.
- **Members may propose to the Site** = the existing KOBE-381 switch `siteProposals` (Site +
  Workspace `site_proposals_enabled`, needs Workspace memories). Default **on** (KOBE-381 made
  every switch default on so the upgrade changes nothing; not re-decided here). Off refuses every
  proposal and every confirmation from that Workspace (`memory_disabled`, 403), Team admins
  included. The docs already describe it this way.
- **Step 1.** Team admins confirm (Edit and confirm: statement, kind, justification; `edited`
  audited, never text) or withdraw; the proposer withdraws their own; Workspace curators other
  than the proposer endorse (Team admins too, not only stewards). A Team admin's own proposal is
  created `awaiting_site` with `team_confirmed_by = proposer`. Propose to Site on a Workspace
  memory: curators only. Propose → Site on a candidate: the caller's own open candidate, `stated`
  or `confirmed`, a new memory (no target, not project notes), quoting the person (`evidence.ts`).
- **Step 2.** Approve (optionally edited; `policy` only for Site admins) creates a Site memory;
  Merge adds the next version of an existing Site memory (refused when the wording would not
  change: reject as a duplicate instead; Policy targets need a Site admin, the store's rule).
  Reject needs a reason (≤ 1000). Both write through the item store as the Site curator, so
  limits, switches and the shared checks with audited overrides apply.
- **Who may not decide:** the proposer (even a Site admin). The Team admin who confirmed may
  decide at step 2: one person on a small Site would otherwise block every proposal; confirming
  is the Workspace's release, not authorship. Workspace curators who aren't Site curators get 404.
- **Request changes:** note ≤ 500, back to `awaiting_team`, `rounds + 1`, note in `reason`,
  `decided_by/at` = the Site curator; the Team admins confirm again (step 1 again even for a Team
  admin's own). With `rounds = 3` it is refused (409 `memory_item_inactive`): approve, merge or
  reject. So at most 3 rounds of changes. `changes_requested` state is not used (the brief says
  back to step 1); `team_confirmed_by` keeps the last confirmation so the Site still sees it.
- **Checks** (`memory/checks.ts`, scope site) on the statement + justification at propose and
  confirm: length and secrets refuse; lint/personal/link warnings and Policy conflicts are
  returned (`checks`) and don't block. At approve/merge the store's save checks enforce, with
  overrides. The Site detail returns warnings, near-duplicate Site items and Policy conflicts.
- **Expiry.** `expires_at` is the column default at creation (30 d); rounds never touch it. Open
  rows past it read as `expired` and refuse actions; the sweep and reminders are KOBE-653.
- **Notifications:** existing Phase C kinds only (no migration): received (Team admins),
  confirmed (Site curators + proposer), changes_requested (Team admins + proposer), accepted /
  dismissed (proposer + confirmer); 7-day reminders registered per step and settled on every
  transition and on withdraw. Table in `notify.ts`.
- **Provenance (ac-2):** `GET /v1/site/memory/proposals/items/:itemId/provenance`: Site curators
  get each proposal-written version with its source Workspace; everyone else `{set_by: "site"}`.
  Item detail for non-curators already hides authors; it shows `actor_kind: proposal` (no
  Workspace), and runs label Site items "set by the Site".
- **Audit:** step 1 in the Workspace log (created, confirmed, endorsed, withdrawn), step 2 in the
  site log (accepted, dismissed with outcome rejected/changes_requested), ids and flags only;
  the Site item also gets `memory.item.created` with `actorKind: proposal`.

## User-facing docs

No guide change now: the flow has no UI yet (KOBE-404/405 ship the user-facing pages), the guide
already describes the switch and the notifications, and no other path changes what people can do.
KOBE-650's admin MCP tools read `site_memory_items` only (no proposals view): left as is.
`docs/audit-log.md` gains the six events.

## Open questions (for Chris or the coordinator)

1. KOBE-645 delivers notices only to active members of the proposing Workspace, so Site curators
   who aren't members get no `confirmed` bell notice or reminder (they see the Site queue). A
   site-level notice channel would need a machinery change (team-scoped `notifications`).
2. Should the confirming Team admin also be barred from deciding at step 2? (Chose no; above.)
3. Should step-2 decisions also appear in the Workspace's audit view? (Chose site log only; the
   Workspace sees the outcome on the proposal and in the bell.)

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/memory-site-proposals.db.test.ts`: propose (candidate, item,
  refusals, switch), step 1 (confirm/edit, endorse, visibility, withdraw), step 2 (approve, merge,
  self-decision refused, reject reason, request changes ×3 then refused, queue filters/counts).
- **ac-2** same file "approves into a Site memory…": provenance per role, item detail for
  members/other Workspaces carries no Workspace id or name.
- **ac-3** same test: the source Workspace memory is still active after approval.
