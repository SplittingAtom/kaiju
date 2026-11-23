# Git integration gate (KOBE-769)

For the owner. This is the checklist for the gate run of the Git integration (spec
[docs/specs/workspace-git.md](../specs/workspace-git.md) §11, tickets KOBE-757..768) on a test
install, against a GitHub test organization (once with a GitHub App, once with a fine-grained
token), a Gitea organization and a Forgejo organization.

**Status: not run.** Every box below is unchecked. The documentation half of KOBE-769 (guide,
install notes, release note) is done; the gate run waits for test hosts. Nothing here was run, and
no result is claimed. Tick a box only after doing its steps and seeing the result named.

Guide pages the steps rely on: [Git organizations](../guide/admin/git-organizations.md),
[Repos](../guide/files/workspaces-and-projects.md#repos),
[Working with git repositories](../guide/for-agents/working-with-git.md). Operator setup:
[docs/install.md](../install.md#git-for-connected-organizations).

## Before you start

- A test install of the release, with `server.tmpSizeLimit` at `8Gi` and the egress proxy's
  internal key Secret present. Site console, Settings, **Git connections**: switch on, allowed
  hosts empty or listing the three test hosts.
- Each host in the Site's egress ceiling; a private-address Gitea or Forgejo marked internal and in
  the connectors' internal CIDRs (install notes). The base URL is served on port 443.
- A test Workspace with: you as Workspace admin; a second member with the **Reader** role; a third
  with **Contributor**; a project owner who is not a Workspace admin.
- Test organizations, each holding only throwaway repositories: GitHub (A: a GitHub App installed
  on it with the permissions in the guide, including Administration; B: a fine-grained token for
  the same organization), Gitea 1.26.0 or later and Forgejo 15.0.0 or later (each with a bot
  account in that organization only and a token with the scopes in the guide), plus a second
  organization on each host for the "outside the organization" check.
- A tool for inspecting a sandbox: a conversation where the agent can run `env`, `git config -l`
  and `ls -a ~` (item 2).
- Record each host's version from the Test result.

Columns: **GH-App** (GitHub, GitHub App), **GH-Token** (GitHub, fine-grained token), **Gitea**,
**Forgejo**. Where an item does not apply to a column it says so.

## §11.1 Connect, test, show what the credential may do

| Check                                                                                          | GH-App | GH-Token | Gitea | Forgejo |
| ---------------------------------------------------------------------------------------------- | ------ | -------- | ----- | ------- |
| Connect with the intended credential; test passes and lists what it may do                     | [ ]    | [ ]      | [ ]   | [ ]     |
| Test names who actions appear as, the host's version and the credential's expiry (where known) | [ ]    | [ ]      | [ ]   | [ ]     |
| A credential missing one permission or scope fails with that permission named                  | [ ]    | [ ]      | [ ]   | [ ]     |
| A credential with extra permissions connects with a warning naming them                        | [ ]    | [ ]      | n/a   | n/a     |
| A host below the minimum version is refused naming the minimum (if an old test server exists)  | n/a    | n/a      | [ ]   | [ ]     |
| Gitea selected for a Forgejo host (or the reverse) is stored as what the host reports          | n/a    | n/a      | [ ]   | [ ]     |

Steps:

1. Sign in as the Workspace admin. Team console, **Git**, **Connect a git organization**.
2. Step 1: choose the provider; for Gitea and Forgejo enter the base URL. Step 2: enter the
   organization, choose **Read and write**, and provide the credential (GH-App: App ID,
   installation ID and the `.pem`; others: the token). Step 3: **Test**. Read the result.
3. Connect. The card shows the provider, organization, credential kind, access level, **Working**.
4. Missing permission: create a second credential without Issues write (GitHub) or without
   `write:issue` (Gitea, Forgejo). **Test** must fail, naming it. Delete that credential.
5. Extra permission: for GitHub, give the App or token an extra permission (for example
   Workflows write) and **Test**: the warning names it.
6. Version: Test shows the host's version. For the refusal, point at an older server if you have
   one, else rely on the unit tests (note that here).
7. Provider mix-up: choose Gitea for the Forgejo host and Connect; the card says Forgejo.

## §11.2 Agent flow with no credential in the sandbox

| Check                                                                                                      | GH-App | GH-Token | Gitea | Forgejo |
| ---------------------------------------------------------------------------------------------------------- | ------ | -------- | ----- | ------- |
| Agent calls `git_create_repository`: a card names host, organization and repository; repository is private | [ ]    | [ ]      | [ ]   | [ ]     |
| After approval the repository exists on the host and is private                                            | [ ]    | [ ]      | [ ]   | [ ]     |
| `git clone` of it in the sandbox works with no setup                                                       | [ ]    | [ ]      | [ ]   | [ ]     |
| Commit, then `git push -u origin <branch>` works                                                           | [ ]    | [ ]      | [ ]   | [ ]     |
| `git_open_pull_request` asks, then opens a pull request whose last line names the member and conversation  | [ ]    | [ ]      | [ ]   | [ ]     |
| Inside the sandbox: no credential in the environment, files, git config or remote URL                      | [ ]    | [ ]      | [ ]   | [ ]     |
| The e2e suite's check from inside a sandbox passes against this host                                       | [ ]    | [ ]      | [ ]   | [ ]     |

Steps:

1. As a Contributor, start a conversation with an agent that may use git. Ask it to create a
   repository named `kobe-gate-<host>-<date>` in the connected organization. On the card check the
   host, organization, repository and visibility. Approve. Open the host and check the repository
   is private.
2. Ask the agent to `git clone` it, create a file, commit, and push a branch `gate/test`. Check the
   branch on the host, and that the pusher is the App's bot (GH-App) or the token's owner.
3. Ask the agent to open a pull request with `git_open_pull_request`. Approve the card. Check the
   pull request on the host, its last line, and that the conversation link opens.
4. Ask the agent to run `env | sort`, `git config --global -l`, `git config -l` inside the clone,
   `cat .git/config`, `ls -a ~` and `git credential fill` with an empty input. None may show a
   token, key, password or `Authorization`; `origin` is the plain `https://` URL.
5. Run the browser and sandbox e2e specs that cover this against the host where they apply
   (`e2e/browser`, `git-section` with `KOBE_GIT_PROVIDER`, `KOBE_GIT_ORG`, `KOBE_GIT_TOKEN` and
   `KOBE_GIT_BASE_URL` set; `repos-files-panel`).
6. Audit log: `git.repository.created`, `git.branch.created`, `git.pull_request.opened`,
   `git.write.attempted`, and the egress audit's fetch and push rows, with no credential.

## §11.3 Refusals

| Check                                                                                              | GH-App | GH-Token | Gitea | Forgejo |
| -------------------------------------------------------------------------------------------------- | ------ | -------- | ----- | ------- |
| Push to a repository in another organization on the same host is refused with a clear message      | [ ]    | [ ]      | [ ]   | [ ]     |
| Push with the connection at **Read** is refused ("is read-only")                                   | [ ]    | [ ]      | [ ]   | [ ]     |
| Push by a Reader is refused ("Pushing needs the Contributor role")                                 | [ ]    | [ ]      | [ ]   | [ ]     |
| A request to another host through the proxy gets no credential (and fails as a private repository) | [ ]    | [ ]      | [ ]   | [ ]     |
| A Repo push by a non-editor of its project is refused ("editor or owner role")                     | [ ]    | [ ]      | [ ]   | [ ]     |
| Git host tools at **Read**: write tools refused with `git_not_allowed`                             | [ ]    | [ ]      | [ ]   | [ ]     |

Steps (the message texts are in
[Working with git repositories](../guide/for-agents/working-with-git.md#when-a-push-or-clone-is-refused)):

1. In a sandbox, `git push` a commit to `<base>/<other-organization>/<repo>.git` using a remote you
   add by hand: expect `is outside the organization this Workspace connected`.
2. Set the connection to **Read** (Settings). Push to the connected repository: expect `is
read-only`. Fetch still works. Call `git_create_repository`: expect `git_not_allowed`. Set it
   back to **Read and write**.
3. As the Reader, push: expect `Pushing needs the Contributor role`.
4. In a sandbox, run `git ls-remote` against a different host's private repository: expect a
   failure with `terminal prompts disabled` or `could not read Username`, and nothing sent with the
   credential (check the egress audit).
5. Convert a project (item 5), then as a Contributor who is only a reader of that project, push
   from the working copy: expect `pushing needs the editor or owner role on its project`.

## §11.4 Credential never returned, logged or audited; survives key rotation

| Check                                                                              | GH-App | GH-Token | Gitea | Forgejo |
| ---------------------------------------------------------------------------------- | ------ | -------- | ----- | ------- |
| No API answer for the connection (list, get, test, update) contains the credential | [ ]    | [ ]      | [ ]   | [ ]     |
| Server, proxy and sandbox-agent logs for the run contain no credential             | [ ]    | [ ]      | [ ]   | [ ]     |
| Audit log and egress audit rows contain no credential                              | [ ]    | [ ]      | [ ]   | [ ]     |
| After rotating the envelope key, the connection still tests and a push still works | [ ]    | [ ]      | [ ]   | [ ]     |

Steps:

1. As admin, fetch `/v1/team/git/connections` and one connection with your session; search the
   JSON for the token (or the key's first line, App ID aside). Do the same as a member.
2. Collect the logs of the server, egress-proxy and sandbox pods for the period; search them for
   the token string, `-----BEGIN`, and `Authorization: Basic`.
3. Export the audit log for the period and search it the same way.
4. Rotate: set the envelope Secret's `key-previous` to the old key and `key` to a new one (see
   [backup and restore](../backup-restore.md#secrets) and the Secret table), restart the server,
   then **Check now** on each connection and push again. Replace the credential once under the
   new key and check the old text is gone from the card.

## §11.5 Project to Repo, commits, host changes

| Check                                                                                                                       | GH-App | GH-Token | Gitea | Forgejo |
| --------------------------------------------------------------------------------------------------------------------------- | ------ | -------- | ----- | ------- |
| Promote a My files folder to a project, then **Convert to repo…** with history                                              | [ ]    | [ ]      | [ ]   | [ ]     |
| The host shows each Kobe commit as a git commit with its author, time and message                                           | [ ]    | [ ]      | [ ]   | [ ]     |
| The Repo appears among Projects with the git icon, host and `organization/repository`                                       | [ ]    | [ ]      | [ ]   | [ ]     |
| A change committed from the **Commit…** dialog becomes a pull request on the host                                           | [ ]    | [ ]      | [ ]   | [ ]     |
| An agent in a conversation on the Repo commits to a branch and pushes from the sandbox                                      | [ ]    | [ ]      | [ ]   | [ ]     |
| The agent's `commit_project` on the Repo asks (`commit_repo`) every time and cannot be remembered                           | [ ]    | [ ]      | [ ]   | [ ]     |
| A commit made on the host appears in Kobe after **Refresh**                                                                 | [ ]    | [ ]      | [ ]   | [ ]     |
| With **Allow commits straight to the default branch** on, the commit goes to the default branch                             | [ ]    | [ ]      | [ ]   | [ ]     |
| Archive the host repository: the Repo turns read-only; **Detach…** and **Relink…** work                                     | [ ]    | [ ]      | [ ]   | [ ]     |
| Commits use the member's Kobe email; with the no-reply setting, the `<short id>+<name slug>@users.noreply.<Site host>` form | [ ]    | [ ]      | [ ]   | [ ]     |

Steps:

1. As the project owner, in My files make a folder with three files, **Promote to project…**,
   make two commits (edit a file, commit; add a file, commit). Open the project's **⋯** menu,
   **Convert to repo…**, choose the connection, keep the name, keep history on. Follow progress to
   completion; check the email and the Files panel notice.
2. On the host, list the repository's commits: two commits plus the first, authors, times and
   messages as in Kobe, files and modes match.
3. Files panel: the Repo row has the git icon; hover shows `<host> · <org/repo>`; **Open on
   &lt;host&gt;** opens the repository; **Repo details…** shows the mirror time and the commits.
4. Check the project out, edit a file, **Commit…**: the result names a pull request with a link.
   Open it on the host. Commit again from the same copy: the same pull request grows.
5. Start a conversation on the Repo. Ask the agent to work in `/workspace/.kobe/repos/<slug>`:
   create a branch, commit, `git push -u origin <branch>`, then `git_open_pull_request`. Check the
   Files row's branch and ahead/behind chip. Confirm the working copy is not in My files.
6. Ask the agent to commit the checkout with `commit_project`: a `commit_repo` card appears, naming
   host, repository and branch; there is no remember option.
7. On the host, merge the pull requests (or commit directly to the default branch), then
   **Refresh** in **Repo details…**: the files and commit list change.
8. Settings: turn on **Allow commits straight to the default branch** and commit from the dialog:
   the commit lands on the default branch, or a pull request if the host protects it (say which).
   Turn it off again.
9. Archive the host repository, wait for or press **Refresh**: read-only banner. As admin,
   **Relink…** to another repository of the organization, then **Detach…** on a second Repo.
10. Check the author line of a commit made in a sandbox against the member's email; set **Commit
    author email** to **No-reply address**, commit again, and check the new form.

## §11.6 Git section, guide and install notes

| Check                                                                                        | All hosts |
| -------------------------------------------------------------------------------------------- | --------- |
| The Team console **Git** page connects, tests, limits, replaces a credential and disconnects | [ ]       |
| Members see the connection read-only under **Profile → My connectors**                       | [ ]       |
| Site console: switch off stops tests and use; host list refuses a host not on it             | [ ]       |
| Guide pages match what the install does (spot-check the exact permissions and scopes)        | [ ]       |
| the git pages are listed in `/llms.txt` and served at `/docs/<slug>.md`, `/llms-full.txt`    | [ ]       |
| Install notes followed from scratch on a clean install work (egress ceiling, internal CIDRs) | [ ]       |

Steps: **Replace credential** (paste a new token; the card keeps working), **Settings** (change the
level, name prefix, push limit), **Disconnect** (repositories on the host stay; the Repo turns
read-only). In the Site console switch **Allow Workspaces to connect git organizations** off:
**Check now** and a test are refused, cards show **Not allowed by the Site**, a sandbox fetch is
refused; switch on again. Add an allowed-hosts list without one test host and check it.

## §11.7 Suites

| Check                                                                                            | Result |
| ------------------------------------------------------------------------------------------------ | ------ |
| The e2e suite runs the flow against an in-cluster Forgejo (**deferred by the owner, see below**) | [ ]    |
| The GitHub flow runs against the test organization (items 1 to 5 above, App and token)           | [ ]    |

The in-cluster Forgejo for e2e was deferred by the owner on 2026-11-21 (KOBE-759, ac-3: "we will
set this up later"). KOBE-757..768 contain no Forgejo service, chart component, CI job or licence
row for it. Until that work is done, the Forgejo column above is a manual run against a Forgejo
server of your choosing, and item 7 stays unchecked.

## Decisions for the owner to confirm

Each line is the default taken. Say "keep" or give the change. Sources are the ledgers of KOBE-757
to KOBE-768.

1. **Repo content limit 256 MiB** (with 500 files, 50 MiB per file) of files at the default branch
   tip, shared by the mirror and Convert to repo; pack 384 MiB, 816 MiB on disk, 20,000 objects
   per pack (KOBE-766, coordinator's numbers, 2026-11-23).
2. **`server.tmpSizeLimit` default `8Gi`** (new chart value; the KOBE-765 ledger still says 6Gi from
   before the mirror; the chart is the truth) (KOBE-765, KOBE-766).
3. **Conversion pushes at most 2 GiB of distinct content**, or the connection's push limit if
   smaller, and files over 100 MiB are refused (KOBE-765, coordinator's number). In practice the
   256 MiB Repo limit binds first.
4. **Mirror commits are authored by the member who converted or relinked**, message `Mirror of
<org/repo> at <sha12>`; the panel shows the host's own commit list (KOBE-766).
5. **Older mirror commits are dropped** when a newer one lands (unless a checkout is based on it or
   a legal hold covers the Workspace); pre-conversion history is never touched (KOBE-766, KOBE-767
   sweep).
6. **Relink and detach are allowed in any state**, not only when the Repo is read-only; Workspace
   admins only (KOBE-766).
7. **A Repo whose newest 25 commits are very large is "too large to mirror"** until they age out;
   the history margin is half the content cap, at least 16 MiB (KOBE-766 review R4).
8. **Working copy at `/workspace/.kobe/repos/<slug>`, never synced**, instead of `repos/<slug>` in
   My files (KOBE-767 N2).
9. **One pull request per member and working copy** while it is open; a later commit is added to
   it, and after it is merged or closed the next commit opens a new one (KOBE-767).
10. **Direct commit refused by the host for another reason falls back to a pull request** and says
    so (`fallback`) (KOBE-767).
11. **Direct commits write Kobe's copy of the Repo at once** instead of waiting for the refresh
    (KOBE-767).
12. **An agent's commit to a Repo is its own approval subject `commit_repo`**: always asks, no
    remember, rules for `commit_project` do not cover it (KOBE-767 M2).
13. **Each commit is built on the host's current head and every changed file is checked**; a file
    changed on the host since the member's copy refuses the commit (`repo_moved`), other files'
    host changes are kept (KOBE-767 H1).
14. **A sweep of mirror commits on an unchanged refresh is not audited** (no event fits)
    (KOBE-767 R2-L5).
15. **Repo reads follow the project's read rule**; today every Workspace member is an implicit
    reader of every project, so no member is refused yet (KOBE-762 M4, KOBE-763).
16. **The git tools are a built-in `git` connector**, separate from the Kobe connector; its ceiling
    is the Site's Git switch and each connection (KOBE-762 M3).
17. **Per-connection budgets: 3,000 reads and 300 changes an hour**; per member 300 reads per 10
    minutes and 30 changes per hour; 60 Repo commits per member per hour; Refresh 30 per 10
    minutes (KOBE-762 M2, KOBE-767, KOBE-766).
18. **Agent-limited connections (GQ8) are refused for git in the sandbox** (`agents_restricted`):
    one sandbox serves all of a member's agents. The alternative needs run identity in the egress
    token (KOBE-763).
19. **A renamed repository's old smart-HTTP URL is not followed** by the proxy; the agent uses the
    new name (KOBE-763).
20. **The organization's letter case must match the connection's** for git in the sandbox; lower-case
    variants can be added if agents trip on it (KOBE-764).
21. **Only reads and branch creation run unattended** (scheduled runs, auto mode); other git
    changes are refused unless a Workspace allow rule lists them (KOBE-762).
22. **Host links shown only when the host and port match the connection's base URL**, and the
    Repo's hostname and `organization/repository` are shown on hover and for screen readers, not as
    a second line in the Files row (KOBE-768, starred).
23. **Convert to repo is offered only in the Files panel**, to the project's owner and Workspace
    admins, with the connection's default visibility and no visibility choice in the dialog
    (KOBE-768).
24. **Conversion and credential-expiry notices use the Files panel and email, not the bell**; bell
    kinds `git.conversion.finished|failed` and `git.credential.expiring` are a suggested follow-up
    ticket (KOBE-760, KOBE-765, KOBE-768).
25. **A connection that starts failing only shows in health**; admins are not emailed (KOBE-760).
26. **No-reply author form** `<short id>+<name slug>@users.noreply.<Site host>` follows the Site's
    public address; if it changes, new commits use the new host (GQ10, 2026-11-22).
27. **Minimum hosts** Gitea 1.26.0 and Forgejo 15.0.0 (the release line current at build time and
    its previous major, 2026-11-22; KOBE-759 notes that no Gitea 1.28 should have shipped by the
    check date, unconfirmed).
28. **Gitea and Forgejo tokens need `write:issue`**, which the spec's scope list omitted; the spec
    now lists it (KOBE-759).
29. **GitHub's Administration permission is requested only if agents create repositories**, though
    it also allows deleting repositories, which Kobe never does (KOBE-758).
30. **The Opus security review of the git tools (KOBE-762) was not run in that ticket**; run it
    before release if wanted.
31. **The in-cluster Forgejo e2e service** is deferred (see §11.7).
32. **Release name `v1.4`** is assumed for the release note
    ([docs/releases/v1.4.md](../releases/v1.4.md)); migrations `0248` to `0258` renumber if
    other branches land first.
33. **Pruning never drops a Repo's pre-conversion Kobe history** (kept; the spec is silent)
    (KOBE-765).
