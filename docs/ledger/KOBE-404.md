# KOBE-404: SMC3: Workspace-side UI — Propose to Site and confirmation queue

- **Status:** committed locally on `kobe-404-sm` (no push/PR; coordinator reviews)
- **Branch / worktree:** `kobe-404-sm` in `../Kobe-wt404` (on `kobe-403-sm`: #597 table, #599 API)
- **Depends on:** KOBE-403 (`/v1/memory/site-proposals`, unchanged here)

## Plan

Web only plus docs; no server, protocol or migration change.

- `apps/web/lib/memory/site-proposals-api.ts`: client for the Workspace-side routes, types of
  `workspaceView` (camelized), state labels, `describeSiteChecks` (one line for warnings/Policy
  conflicts returned by propose/confirm).
- To review: `review/propose-action.tsx` now takes `targets` (workspace / site). **Propose…**
  shows a "Propose to" radio group when the Site is offered: **This Workspace's curators**
  (members who don't curate, as KOBE-397) and **The Site (every workspace)** with a required
  justification (≤ 1000, `maxLength` + `required` + inline check). `siteRefusal()` mirrors the
  server rule: inferred → disabled with the reason (ac-3); not `add` or not shareable → disabled.
  `CardSeams.proposeSite`; `ReviewSection` gets `siteProposalsApi` (defaults to the real client).
- Workspace console › Memory: new **To the Site** tab (curators only; members don't see it),
  `memory/site-proposals/site-queue.tsx` + `site-proposal-card.tsx`: groups Waiting for a Team
  admin / Waiting for the Site / Closed; card shows statement, kind, justification, proposer,
  endorsement, Site's changes note + round, rejection reason; actions follow the server's `may`
  (Confirm, Edit and confirm… with statement/kind/justification, Endorse, Withdraw… via
  `useConfirm`). Server refusals (409 inactive/expired, 403 switch off) show in the card.
  `?site_proposal=<id>` opens the tab and focuses the proposal.
- **Propose to Site** on each active Workspace memory for curators:
  `memory/site-proposals/propose-item.tsx`, through new optional `CuratorMemories.rowExtra` /
  `ItemRow.extra` slots (no change for the Site console, which passes nothing).
- Bell: `memory.site_proposal.received` (sent to the Workspace's Team admins) now links to
  `/admin/team/memory?site_proposal=<id>` instead of the Site console.

## Decisions

- **Curators get Propose… too, for the Site only.** KOBE-397 hid Propose… from curators (they save
  to the Workspace directly); the Site is a different place, so the button now shows for them with
  only the Site option. The KOBE-397 test was adjusted accordingly.
- **Buttons follow `may`** from KOBE-403's `workspaceView` rather than client permissions, so a
  steward never sees Confirm (ac-2) and the proposer never sees Endorse.
- **Focus:** the justification takes focus only when the form opens on it (curators); switching
  radios never moves focus (keyboard arrowing stays in the group).
- **Rounds** are shown as "Round N" (N = rounds + 1) and the note as "asked for changes (k of at
  most 3 times)".
- Endorsement is a boolean on the wire, so the card says "Endorsed by a curator" (no name).
- Policy conflicts come back as ids only; the success notice says "may contradict a Site Policy
  item" without the text (Team admins read Policy on the Memories tab).
- The switch state isn't read up front: the server's `memory_disabled` refusal is shown where the
  action was taken (one source of truth; the API has it).

## User-facing docs

`docs/guide/memory.md`: summary, To review bullet, Propose… wording, new sections "Propose a
memory to the Site" and "Confirm Site proposals (Team admins)". `docs/guide/admin/team-admin.md`:
summary, stewards' rights, Memory row (Proposals, To the Site), Propose to Site on Memories.
`docs/guide/glossary.md`: Memory steward. "For agents" pages unchanged: agents have no write path
to memory or proposals, and nothing they see changed.

## Coordinator follow-up (bell links, list limit)

- Site proposal notices link each reader to a page they can open: the bell asks `/v1/me` and
  `/v1/team` once, only when a Site proposal notice is listed (`lib/notifications/memory-viewer.ts`).
  `confirmed`: Site curators → Site console, others (the proposer) → My memory. Outcomes
  (accepted, dismissed, changes requested, expired): Workspace curators → Workspace console,
  others → My memory. Unknown reader → My memory.
- My memory gains **Your Site proposals** (`site-proposals/my-site-proposals.tsx`, own only,
  `?site_proposal=<id>` focuses it; reuses the card, so Withdraw is there).
- Lists: the API has no cursor (max 100). Pages now read awaiting_team, awaiting_site and all
  (newest first) separately, so open proposals aren't hidden by closed ones, and each group says
  "Showing N of M …" from the counts when it holds more.

## Open questions

1. None left from this ticket's side; a cursor on the Workspace list would replace the notes.

## Evidence

- **ac-1** `components/memory/site-proposals/site-proposals.test.tsx` (confirm with edit, empty
  justification refused, withdraw after asking, 409 and switch-off refusals shown);
  `components/admin/memory-consoles.test.tsx` (tab for curators, not members; bell link opens it).
- **ac-2** same file "Stewards: endorse but see no Confirm".
- **ac-3** `components/memory/review/site-propose.test.tsx` "is disabled for inferred candidates".
- **ac-4** guide pages above.
- `pnpm verify`: see the commit message.
