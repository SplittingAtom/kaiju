# KOBE-768: GIT-12: Files panel: Repos among Projects with the git icon, host link, branch and ahead/behind; Convert to repo dialog

- **Status:** in review (committed on the branch, not pushed; the coordinator lands it)
- **Branch / worktree:** `group-109-git-12-files-panel` in `../Kobe-g109`, stacked on
  `group-108-git-11-commit-flow` (KOBE-766 mirror + KOBE-767 commit flow)
- **Depends on:** spec `docs/specs/workspace-git.md` G16, G17, G19, G20, GQ12, GQ13; KOBE-765..767
  routes and protocol types (no server commit, mirror or conversion logic changed)

## What ships

| Piece                                                                                                                                                                                               | Where                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Read-only server additions: `projects.kind` and `repo_conversion` (running/failed) on every project answer; `repo_name_prefix` on the members' view of a connection (both optional in the contract) | `packages/protocol/src/projects.ts`, `git-connections.ts`; `services/server/src/projects/repository.ts`, `git/connection-view.ts` |
| Web API for `/repo*` and `/repo-conversion*`; words and checks (host link, subtitle, branch, ahead/behind, mirror state, name rule, progress, refusals)                                             | `apps/web/lib/projects/repo-api.ts`, `repo.ts`                                                                                    |
| Repo state beside the projects: each Repo's `/repo` + `/repo-status`, the connections (once a project the member manages is listed), conversion polling (10 s) and notices                          | `apps/web/components/projects/workspace-repos.ts` (in `WorkspaceProjectsProvider`)                                                |
| Row: git icon, "Repo" for screen readers, host · org/repo (hover and description), branch, ↑/↓ chip, read-only / too large / refresh failed, "converting to a Repo…" / "conversion failed"          | `components/files/workspace-tree.tsx`, `components/projects/repo-row.ts`, `file-tree.tsx` (`icon`, `kind`)                        |
| Menu: **Open on &lt;host&gt;**, **Repo details…**, **Convert to repo…**                                                                                                                             | `components/files/file-row-menus.ts` (`repoBindings`), `lib/shell/commands.ts`                                                    |
| Repo details… (mirror, Refresh with its 429 words, commits, PR link, read-only banner; Relink…/Detach… for admins)                                                                                  | `components/projects/repo-panel.tsx`                                                                                              |
| Convert to repo dialog (connection, name with prefix, history, admin-only existing repo, refusals, progress, completed/failed/abandoned, Retry/Abandon)                                             | `components/projects/convert-dialog.tsx`                                                                                          |
| Notices in the Files panel: conversion finished/failed; credential expiring (admins)                                                                                                                | `components/projects/repo-notices.tsx`                                                                                            |

## Decisions (owner please confirm the starred ones)

- \* **Host links:** a link (menu or `<a>`) is offered only when the server's `web_url` (or a pull
  request URL) has the same scheme, host and port as the connection's `base_url` and no
  credentials; otherwise none is shown. Opened with `noopener,noreferrer`; host strings are text.
- \* **Subtitle on hover and for screen readers**, not a second line: Files rows are one line
  (26 px); the row's `title` is `<slug> · <host> · <org/repo>` and the details panel shows it.
- **Branch shown:** the member's working copy's branch (from `repo-status`), else the default
  branch; ahead/behind only with a working copy (G19 "for a mounted working copy").
- **Convert to repo… only in the Files panel** (the spec's "project's ⋯ menu"); the project page
  is unchanged. Offered to owners and admins (`my_role` owner or null) when the Site allows git
  and a connection is at Read and write; always while a conversion runs or failed (to follow,
  retry or abandon). Visibility is the connection's default (no choice in the dialog).
- \* **Admin detection for "existing repository" and the expiry notice:** the connections list
  carries the admin view (or `site.allowed_hosts`), i.e. `team.git.manage`.
- **Notices without the bell.** The bell (`notifications`) would need a migration (the kind and
  shape CHECKs, a column naming the conversion or connection), protocol kinds, rendering, and
  writes in KOBE-765's job and KOBE-760's expiry job; out of scope for a web ticket stacked on code
  in review. Shipped instead: the Files panel shows "<project> is now a Repo." / "Converting
  <project> to a Repo failed…" when a conversion it watches (any project with `repo_conversion`
  running; projects re-read every 10 s meanwhile) ends, and Workspace admins see each connection
  whose credential expires within 14 days with a link to the Git section. Both dismiss per session;
  emails are unchanged. **Follow-up ticket suggested** for bell kinds `git.conversion.finished|failed`
  and `git.credential.expiring`.
- `credential_rejected` (502 from Refresh/Relink, Kobe's fixed sentence) added to the codes whose
  5xx message the web shows.

## Left / open

- The Threads panel's file map and project filters already treat Repos as projects (they list
  projects); its project headers keep the folder icon (no icon there today).
- The browser spec has not run yet (first run after the next deploy); it typechecks (`npm ci`,
  `npm run typecheck`) and lints clean.

## Review round 1 (review-g109.md) — what changed

Merged `origin/group-108-git-11-commit-flow` (KOBE-767 final, working copy at
`/workspace/.kobe/repos/<slug>`; none of this ticket's text named the old path).

- **H1** the browser spec's real conversion is opt-in (`KOBE_GIT_E2E_CONVERT=1`); without it the
  second test goes through the dialog on a real project (name, visibility words, history) and
  cancels before the start.
- **M1** Repo details reads `/repo` again while the mirror refreshes (2 s, doubling to 30 s, at
  most 8 reads, then says "Still refreshing"), so the state and Refresh follow; the row is read
  again at the end. Test `repo-panel.test.tsx`.
- **M2** the members' view of a connection carries `repo_visibility` (admin-set, benign); the
  dialog words the default ("A private repository…: only people the organization gives access
  can read it" / "An internal repository…: everyone with an account in the host's enterprise
  (GitHub) or on the server (Gitea, Forgejo) can read it"); progress names the visibility; guide
  says the same. Server test pins the member key set.
- **M3** only running conversions of projects the member manages are followed, by
  `GET .../repo-conversion` for those ids (10 s, ×1.5 up to 60 s); the project list is read again
  once when one ends (retried up to 3 times if that read fails); Repo details are re-read when
  the set of Repos changes, not on every reload. Server: the file count and the conversion state
  come from one query per project (no extra query; the list already read one count per project).
- **L1** a Workspace admin listed with a role is known from the connections answer (admin view or
  `allowed_hosts`), read once the projects are in, for every member. **L2** connections are read
  again when Repo details or Convert to repo opens. **L3** the dialog's poll has a stale guard,
  doubles after failed reads and stops after 5 with a message. **L4** an unreadable attempt shows
  "could not read" with Try again, not the form. **L5** readers are not followed and get no
  failure notice. **L6** the dialog takes the focus while it reads; Close takes it when no
  connection is writable. **L8** fake rows use the current time. **L9** guide: admins see Relink
  and Detach for any Repo. **L10** one persistent `role="status"` region announces notices.
  **L11** host-link tests for backslash, default port, case, protocol-relative, trailing dot, IDN.
- **L7 kept as decided:** the host and repository are in the row's hover text and description,
  and in Repo details…, which keyboard (the row's menu key) and touch (the ⋯ button is always
  shown on coarse pointers) reach; the guide says so. A second line would break the 26 px rows.

## Docs

`docs/guide/files/workspaces-and-projects.md` "Repos": Repos in the Files panel, Repo details…,
Convert a project to a Repo (who, fields, one-way, authors, privacy, every refusal with the
limits, progress, Retry/Abandon, after conversion), Notices. `admin/git-organizations.md`: where
Relink/Detach are, the expiry notice. `for-agents/working-with-git.md`: converting is the user's
step (no tool). Release note is KOBE-769's.

## Evidence

- ac-1: `apps/web/components/files/repo-files-panel.test.tsx` (git icon, title, branch, ↑2 ↓1,
  description; Open on github.com with `noopener,noreferrer`; no link for another host; Repo
  details… text-only host strings, Refresh, 429 words, read-only banner, admin Relink refusal and
  Detach); `components/projects/repo-row.test.ts`; `lib/projects/repo.test.ts` (host link rules);
  server `git-conversion.db.test.ts` (`kind: "repo"` after conversion, `repo_conversion: "failed"`
  to a member), `team-git.db.test.ts` (member view keys incl. `repo_name_prefix`).
- ac-2: `components/projects/convert-dialog.test.tsx` (connections and prefixes, name check,
  admin-only existing repository, files named in a refusal, no writable connection, progress to
  completed, failed with Retry, Abandon with the repository left on the host, Escape);
  `repo-files-panel.test.tsx` (offered to owner not editor, prefix, `too_large_to_mirror` words,
  body sent; holding chip and "is now a Repo." notice; expiry notice).
- ac-3: the tests above; `e2e/browser/tests/repos-files-panel.spec.ts` (fake-host test with
  `page.route`; real conversion skipped without a connection at Read and write); guide pages above.
- Suites round 1 (2026-11-23): web 4282 (whole); server unit 4559 (+8 skipped); server `test:db`
  3726; browser spec typechecks and lints. First run: web 4274; protocol 1370; server unit 4559; server
  `test:db` 3725; lint, typecheck, format:check, site wording, public hygiene clean.
