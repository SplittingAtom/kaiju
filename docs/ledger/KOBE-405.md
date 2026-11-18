# KOBE-405: SMC4: Site console — memory proposal review

- **Status:** committed locally on `kobe-405-sm` (no push/PR; coordinator reviews)
- **Branch / worktree:** `kobe-405-sm` in `../Kobe-wt405` (on `kobe-403-sm`: #597 table, #599 API)
- **Depends on:** KOBE-403 (Site API `/v1/site/memory/proposals`). No server, protocol or
  migration change.

## Plan

Web only, plus the guide.

- `apps/web/lib/memory/site-proposals-api.ts`: client for the Site side of KOBE-403 (list with
  counts, detail with checks, approve, merge, reject, request changes) and
  `describeSiteProposalError` (403 switch off, 409 state changed, version conflict, …).
- `apps/web/components/admin/site/memory-proposals/`: `site-proposals.tsx` (queue: counts per
  state, State and Workspace filters, Review), `site-proposal-detail.tsx` (statement, kind,
  justification, Workspace, proposer/confirmer, date, endorsement, round; checks with diffs),
  `site-proposal-actions.tsx` (four actions), `site-proposal-merge.tsx` (target picker + diff),
  `labels.tsx`.
- `components/admin/site/memory-page.tsx`: new **Proposals** tab; `?site_proposal=<id>` (the
  bell's link from KOBE-645) opens that tab and that proposal.

## Decisions

- **Layout:** a tab on the existing Site Memory page (like the Workspace console's Proposals tab
  from KOBE-397), not a new nav entry, so the nav registry and Site access rules are unchanged
  (the server decides who may see it: Site admins and Site stewards).
- **Diffs:** reuse `memory/review/statement-diff.tsx` (`<del>`/`<ins>`, not colour alone): each
  near-duplicate and Policy conflict from the detail's `checks` is diffed saved → proposal; the
  merge panel diffs the chosen target → merged wording.
- **Approve / merge** go through `useCheckedSave` + `CheckProblem` (KOBE-379): lint and Policy
  conflict refusals offer **Save anyway** with the override; every other refusal is shown in
  Site-proposal words (not `describeItemError`, whose `memory_item_inactive` text is about items).
- **Approve** without editing: the API's edit fields are not offered (DraftFields carries tags,
  which approve doesn't take); Site admins get **Make it Policy** (`policy: true`). Merge lets
  the wording be edited (sent only when changed) and sends `expected_version`.
- **Merge targets:** the detail's near-duplicates (plus Policy conflicts for Site admins) first,
  then the first page (100) of active Site memories; Policy items only for Site admins (the
  store's rule). A failed list load leaves the similar ones.
- **Request changes:** note ≤ 500 (`maxLength`), button disabled with `aria-describedby` reason
  at rounds = 3. Reject reason ≤ 1000, required client side too.
- **Workspace filter:** built from the Workspaces seen in loaded lists (Site stewards can't list
  teams); the filter is sent as `from_team_id`.
- **Counts:** the client camelizes `counts` keys; `countsFromWire` maps them back to state names.
- **Constants** (rounds 3, note 500, reason 1000) mirrored in the web client with comments
  (web doesn't depend on `@kobe/db`).

## 403 coverage

Nothing missing: the Site detail returns `checks.near_duplicates` and `checks.policy_conflicts`
with statements and versions, `warnings` and `secret`, so conflicts and diffs need no server work.

## User-facing docs

- `docs/guide/memory.md`: new "Decide on Site proposals (Site admins and Site memory stewards)";
  summary updated (feeds `/llms.txt`).
- `docs/guide/admin/site-admin.md`: Memory bullet describes the Proposals tab; summary updated.
- No "For agents" change: agents never act on proposals.

## Open questions

1. `lib/notifications/memory.ts` links `memory.site_proposal.received` (to Team admins) to the
   Site page; probably should be the Workspace page (KOBE-404's area; left alone).
2. Merge target list is the first 100 active Site memories; a search box would help at 1,000.
3. Gate1 browser spec not written (optional).

## Evidence (acceptance criteria → test or command output)

- **ac-1** `components/admin/site/memory-proposals/site-proposals.test.tsx` (approve + Save
  anyway over a Policy conflict, approve as Policy, merge with diff and expected version, reject,
  request changes, rounds limit, 403 switch-off and 409 refusals, own proposal, bell focus) and
  `components/admin/memory-consoles.test.tsx` "Site console Memory › Proposals" (wire shapes).
  Audit is the server's (KOBE-403 db tests).
- **ac-2** same file "shows near-duplicates and Policy conflicts with diffs".
- **ac-3** "needs a reason to reject" (client) + server schema.
- **ac-4** guide pages above.
