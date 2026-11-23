# Workspaces: Git organizations (GitHub, Gitea, Forgejo)

Status: **approved** (Chris, 2026-11-21): every recommendation in §12 accepted, then the order
revised the same day: this work comes **before** the rename to Kaiju (GQ9). Hadron spec
`6d287131`; tickets GIT-1..GIT-13 = KOBE-757..769 (§13). It starts when the 2026-11-20 review
tickets have merged and is written under the current names; the rename lane renames it afterwards
with everything else.

Request (Chris, 2026-11-21): let a Workspace be connected to a git organization. The admin sets up
either a personal access token or a GitHub App, and the agent uses that to create repositories and
perform other actions. Include how Workspaces get a similar integration with Gitea or Forgejo.
There is a Git section in the Workspace admin screen. The member's path (Chris, same day): promote
a folder in My files to a Project, then convert the Project to a Repo; Repos are listed with
Projects and show a git icon instead of the folder.

Builds on Workspaces (`docs/specs/workspaces.md`; its decision CM10 deferred git to "a later
phase"), Policy, Approvals and Egress (D28, D29) and the connector credential model.

## 1. Summary

A Workspace admin connects the Workspace to an organization on a git host: GitHub (github.com or
GitHub Enterprise Server), Gitea or Forgejo. The credential is a GitHub App installation or an
access token. It is sealed on the server and never enters a sandbox.

Agents then work with the organization in two ways:

- **Git host tools** (create a repository, list and read repositories, branches, pull requests and
  issues, open a pull request, comment). The agent calls a tool, the server decides the call under
  the Workspace's policy and approval rules, and the server calls the host's API.
- **Git itself in the sandbox** (`git clone`, `fetch`, `push`). The sandbox has no credential: its
  git traffic to the connected organization goes through the egress proxy, which adds a short-lived
  credential for exactly that organization and enforces read or write per repository.

For members the path is: a folder in My files is promoted to a Project (as today), and a Project
is converted to a **Repo**. A Repo is a project whose record is a repository in the connected
organization. Repos are listed with Projects in the Files panel, with a git icon in place of the
folder.

The Workspace admin console gets a **Git** section to connect, test, limit and disconnect, and to
see the repositories and recent activity.

## 2. Today (checked on main `7e03f272`, 2026-11-21)

- **Workspace admin console.** `apps/web/app/admin/team/*` has 22 sections (Members, Connectors,
  Egress, Policy, Storage, ...). There is no Git section.
- **Git in the sandbox.** The sandbox image ships git (`images/sandbox/Dockerfile`, with
  `/workspace` as a safe directory). An agent can `git init` and commit locally. It can reach a git
  host only when the Workspace enabled the host's domain on the Egress page, and then only without
  credentials (public repositories, read-only).
- **Credentials at the proxy.** Egress header injection (KOBE-39, `packages/db/src/egress/
header-rules.ts`, `services/egress-proxy/src/upgrade.ts`) adds a sealed, admin-supplied header to
  a sandbox's plain-HTTP request for a domain and sends it upstream over verified HTTPS, so the
  secret stays out of the sandbox. It is per domain (no path scope), static (no expiring tokens),
  and has request and response size limits meant for package uploads.
- **Git on the server.** The skill catalog mirror (KOBE-343, `services/server/src/skills/mirror/`)
  already pushes to a git remote from the server with `isomorphic-git` (MIT) through a guarded HTTP
  client; skill import fetches packs with a pack guard.
- **Projects.** Kobe-native commits (`services/server/src/projects/`). CM10: a git repository per
  project as an export and sync target was left for later; no project data is in a git format.
- **Sealing.** Envelope encryption in `packages/db/src/envelope`, with a purpose per kind of
  secret (connector grants, egress headers, model keys).

## 3. Connections

**G1. A connection** belongs to one Workspace and names one organization (or user namespace) on
one host:

| Field        | Notes                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------- |
| Provider     | `github`, `gitea` or `forgejo`                                                              |
| Base URL     | `https://github.com` by default; any https URL for GitHub Enterprise Server, Gitea, Forgejo |
| Organization | the org (or owner) the Workspace may act in; everything else on the host is out of reach    |
| Credential   | GitHub App installation, or an access token (§4)                                            |
| Access level | **Off**, **Read**, or **Read and write** (the same three steps as the Kobe admin connector) |
| Defaults     | new repositories private; optional name prefix; default branch name                         |
| Display name | shown to members and agents, e.g. "Acme on GitHub"                                          |

**G2. Several connections per Workspace** are allowed (for example a GitHub organization and an
internal Forgejo), up to 5. Each (host, organization) pair can be connected once per Workspace.
Two Workspaces may connect the same organization; each holds its own credential.

**G3. Site ceiling.** A Site admin allows Git connections for the Site (switch, on by default) and
may limit the hosts Workspaces can connect to. The host must also be reachable under the Site's
egress rules: a self-hosted Gitea or Forgejo on a private address needs the Site's internal
targets entry, as any private destination does.

**G4. Connecting tests the credential** before saving: the server reads the organization, lists
what the credential may do (create repositories, read, write, administer) and shows it. A
credential that can do more than the connection needs is accepted with a warning naming the extra
permissions (delete repositories, organization administration).

## 4. Credentials

**G5. GitHub App (recommended for GitHub).** The admin creates a GitHub App in their organization
(the Git section shows the exact permissions to select and can pre-fill GitHub's app-manifest
form), installs it on the organization, and gives Kobe the App ID, the installation ID and the
private key. Kobe seals the private key. For each use the server mints an installation token:
valid for one hour, limited to the repositories and permissions that use needs (GitHub supports
both limits when a token is created). Actions appear on GitHub as the app's bot; commits carry the
member as author (G13). No user account is consumed and removing the installation revokes access
at once.

**G6. Access token.** A fine-grained personal access token (GitHub), or an access token of a
dedicated bot account (Gitea, Forgejo). Kobe seals it. It cannot be narrowed per use, so the token
the admin creates is the whole grant: the Git section says which scopes to choose and warns that
actions appear as the token's owner. Kobe shows the token's expiry when the host reports one and
notifies Workspace admins 14 days before it lapses.

**G7. Gitea and Forgejo.** Neither has GitHub Apps, so the credential is always an access token
(G6); the recommendation in the console is a bot account that is a member of only that
organization. Forgejo is a fork of Gitea and serves the same `/api/v1` API, so Kobe has one
adapter for both; the provider is recorded so labels, links and documentation are right, and the
adapter reads `/api/v1/version` to refuse versions it has not been tested with. Token scopes:
repository read/write, organization read (write only if agents may create repositories), user
read, and issue write (Gitea keeps issues and comments under its own scope; found by KOBE-759). Codeberg and other hosted Forgejo instances work the same way.

**G8. Where credentials live.** Sealed with their own envelope purpose (`git-hosts`); never
returned by any API, never logged or audited, never sent to a sandbox, a browser or a model.
Installation tokens are held in memory by the server and the egress proxy only until they expire.
Rotating: the admin pastes a new token or key; the old one is discarded. Disconnecting deletes the
credential; repositories on the host are not touched.

## 5. What agents can do

**G9. Git host tools.** With a connection at **Read** or above, agents in that Workspace get
tools, one set for all providers:

| Tool (working names)                                                                 | Level | Default policy    |
| ------------------------------------------------------------------------------------ | ----- | ----------------- |
| `git_list_repositories`, `git_get_repository`, `git_list_branches`, `git_read_file`  | Read  | allowed           |
| `git_list_pull_requests`, `git_get_pull_request`, `git_list_issues`, `git_get_issue` | Read  | allowed           |
| `git_create_repository`                                                              | Write | asks for approval |
| `git_create_branch`                                                                  | Write | allowed           |
| `git_open_pull_request`, `git_comment`                                               | Write | asks for approval |
| `git_create_issue`                                                                   | Write | asks for approval |

The server decides every call (policy, then approval where a rule says so), signs approvals as it
does for every tool, calls the host with a credential minted or opened for that call, and audits
it. Approval cards name the host, organization, repository and what will be created. Workspace
admins change the defaults with ordinary policy rules ("always allow opening pull requests in
`acme/docs`"). Not offered at all: deleting or archiving repositories, changing visibility to
public, changing organization or repository settings, managing members, secrets, webhooks or
deploy keys, merging pull requests, force operations.

**G10. Repositories are private.** `git_create_repository` creates private repositories. A
Workspace admin may allow internal visibility where the host has it; public is never created by an
agent.

**G11. Git in the sandbox.** With a connection, the sandbox's git is configured (by the sandbox
agent, at start) so remotes for the connected organization go through the egress proxy. The proxy:

- recognises git smart-HTTP requests to `<base URL>/<organization>/<repository>.git`;
- allows fetch (`git-upload-pack`) at **Read**, and push (`git-receive-pack`) only at **Read and
  write** and only when the member may write there (G12);
- adds the credential (for a GitHub App, an installation token limited to that one repository and
  to read or write; for a token connection, the token) and forwards over verified HTTPS to the
  address it checked, as header injection does today;
- refuses the same paths for any other organization on that host with a clear message, so the
  credential cannot be pointed at a repository outside the organization;
- streams packs without the upload size limit that header injection has, under its own limits
  (Workspace setting, default 1 GiB per push), and records each fetch and push in the egress audit
  with the repository.

Nothing else on the host gets the credential: API calls from the sandbox to the host go without
it, so the tools in G9 stay the only way to act on the API.

**G12. Who may write.** A push or a write tool needs all of: the connection at **Read and write**;
the member holding the Workspace's Contributor role or above (readers can read); and, for a
Repo (§6), the member being an editor or owner of that project. Runs
without a person present (schedules) follow the schedule owner's rights.

**G13. Authorship.** Commits made in the sandbox carry the member's name and their Kobe email as
author, set by the sandbox agent, with "via Kobe" in the committer. On the host, the pusher is the
app's bot or the token's owner. Pull requests and comments opened by tools end with a line naming
the member and the conversation.

**G14. Branches.** Kobe does not parse pushes to enforce branch rules. The Git section recommends
branch protection on the host (the default branch requires a pull request) and shows whether the
default branch of each repository is protected, with a warning when it is not.

## 6. Projects and Repos

**G15. The path.** My files folder → **Promote to project…** (today, `projects/promote.ts`:
Workspace admins and contributors) → **Convert to repo…** on the project's **⋯** menu. A Repo is
still a project in every other respect: same roles (owner, editor, reader), same visibility, same
place in the Files panel, same conversations.

**G16. Convert to repo.** Offered to the project's owner and Workspace admins when the Workspace
has a connection at **Read and write**. The dialog asks for the connection (when there are
several), the repository name (the project's slug, with the connection's prefix) and whether to
carry the history. On confirm the server:

1. creates a private repository in the organization (or, if the admin chose one, uses an existing
   empty repository);
2. writes the project's commits as git commits on the default branch, oldest first, each with its
   author, time and message (the Kobe commit model maps onto git without loss, CM10), or one
   commit of the current state when history is not carried, and pushes them with the server-side
   git client the skill mirror already uses;
3. marks the project as a Repo and records the link.

Conversion is one-way in the product. It is refused while the project is under legal hold, has
open checkouts with unsaved changes, or holds a file the host would reject (size limit of the
host); the dialog says which.

**G17. After conversion the repository is the record.** The default branch on the host is what
the project is. Kobe keeps a mirror of that branch (files and commit list) so the Files panel,
project mounts, readers without git access and search keep working. The mirror is refreshed when
Kobe itself pushes, when someone opens the Repo, and on a timer (default 5 minutes; no webhooks,
§10); the panel shows when it was last refreshed and a **Refresh** action. Kobe's history cap and
retention for project commits no longer apply to a Repo: its history lives on the host.

**G18. Committing to a Repo.** Two ways, both ending as git commits on the host:

- **From Kobe's commit flow** (the existing Commit dialog and the agent's commit tool): the server
  makes a git commit from the checkout, authored as the member, and pushes it to a new branch and
  opens a pull request by default; a Workspace setting per connection allows committing straight
  to the default branch where the host permits it. If the branch moved on the host, the existing
  conflict flow applies against the new head.
- **With git in the sandbox** (G11): in a conversation on a Repo, the project is mounted as a real
  git working copy cloned through the proxy, so the agent uses branches, commits and pushes as in
  any repository.

**G19. In the Files panel.** Repos sit in the Projects section in the same order as projects.
A Repo has a git icon instead of the folder icon, the host and `organization/repository` as its
subtitle, a link to open it on the host, the branch shown, and ahead/behind against the host for a
mounted working copy. The Threads panel's file map and project filters treat Repos as projects.

**G20. When things change on the host.** Renamed or transferred repository: Kobe follows the
host's id. Deleted or archived repository, or a removed connection: the Repo becomes read-only in
Kobe from its last mirror, with a banner; a Workspace admin can relink it to another repository
or turn the mirror back into an ordinary project (one commit of the mirrored state).

## 7. The Git section (Workspace admin console)

New page `Git` under the Workspace admin console, permission `team.git.manage` (Workspace admins).

- **Connections.** A card per connection: host, organization, credential kind, access level,
  health (last successful call, token expiry, app installation state), and what the credential may
  do. **Connect a git organization** opens a three-step dialog: provider and base URL;
  organization and credential (GitHub: App or token, with the permissions to choose and a link to
  GitHub's form; Gitea and Forgejo: token, with the scopes to choose); test and confirm.
- **Settings per connection.** Access level, repository defaults (visibility, name prefix, default
  branch), push size limit, which agents may use it (all in the Workspace, or chosen agents).
- **Repositories.** Those created through Kobe, and Repos (§6): name, project, created by,
  last activity, default-branch protection.
- **Activity.** The last git actions (tool calls, fetches, pushes) with member, agent, repository
  and outcome; links to the audit log.
- **Disconnect** (confirms; says repositories on the host stay) and **Replace credential**.

Members see connected organizations, read-only, on their connectors page, so they know what their
agents can reach. The admin MCP exposes the page's reads; connecting and credential changes are
console-only, like injected headers.

## 8. Data and API

- `git_connections` (team table, RLS): provider, base URL, organization, credential kind, sealed
  credential, access level, defaults, health fields, created/updated by.
- `git_repositories` (team table, RLS): connection, host repository id and name, project id
  (nullable, unique; set for a Repo), mirror state (head commit, last refresh), created by,
  flags read from the host. `projects` gains a kind (`project` or `repo`).
- Activity comes from the audit log and the egress audit; no separate table.
- Routes under `/v1/team/git/*` for the console; the proxy reads connections through its existing
  server channel, as it reads allowlists and header rules.
- Audit: `git.connection.created|updated|credential_replaced|removed`, `git.repository.created|
linked|unlinked`, `git.pull_request.opened`, `git.issue.created`, `git.comment.created`,
  `git.project.converted`, `git.repo.relinked|detached`, plus fetch and push in the egress audit. No event carries a credential.

## 9. Security

- **Secrets never enter sandboxes** holds: tools run on the server, git transport gets its
  credential at the proxy. A credential helper inside the sandbox was considered and rejected for
  this reason.
- **Confused deputy.** The credential is used only for the connected organization's paths; an
  installation token is limited to one repository and to read or write per use. With a token
  connection the token's own scope is the limit, which the console states.
- **Data leaving the Workspace.** A push or a pull request sends Workspace content to the host.
  That is the feature, and it is why writes need the write level, the role in G12 and (for tools)
  approval by default; repositories are never public. A prompt-injected agent can at most write to
  private repositories in the connected organization, visibly and audited.
- **Untrusted content coming in.** Repository files, issues and pull-request text are untrusted
  input to the model, labelled as such in tool results like other external content.
- **Server-side requests.** The base URL is checked by the shared address policy on every call
  (no private addresses unless the Site allows that target; no redirects to another host).
- **Offboarding, retention, legal hold.** Kobe does not delete or rewrite anything on the git
  host. The guide says that repositories are outside Kobe's retention and erasure. A member's
  departure changes nothing on the host (the credential is the Workspace's, not theirs).

## 10. Out of scope

- GitLab, Bitbucket, Azure DevOps (the adapter interface is written so one can be added).
- Per-member credentials (acting on the host as the member), OAuth sign-in to the host.
- Webhooks and anything that makes the host call Kobe; running or reading CI.
- Bringing an existing, non-empty repository into Kobe as a Repo (only conversion of a project
  creates one in this spec), submodules, Git LFS, more than one branch mirrored in the Files panel.
- Merging pull requests, deleting repositories, managing organization settings or members.
- SSH transport.

## 11. Acceptance

1. A Workspace admin connects a GitHub organization with a GitHub App and, separately, with a
   fine-grained token; a Gitea and a Forgejo organization with a token; each connection tests and
   shows what the credential may do.
2. An agent creates a private repository after approval, clones it in the sandbox, commits, pushes
   a branch and opens a pull request, on GitHub, Gitea and Forgejo, with no credential present in
   the sandbox (checked by the e2e suite from inside a sandbox).
3. A push to a repository outside the connected organization, a push at **Read**, a push by a
   reader, and a request to another host with the credential are all refused with a clear message.
4. The credential is never returned by an API, logged or audited (tests), and survives key
   rotation of the envelope.
5. A member promotes a My files folder to a project and converts it to a Repo with its history;
   the Repo appears among Projects with the git icon; a commit from Kobe's dialog becomes a pull
   request on the host; an agent in a conversation on the Repo commits and pushes from the
   sandbox; a commit made on the host appears in Kobe after a refresh.
6. The Git section, the guide pages (Workspace admin, connectors, working in a sandbox for agents)
   and the install notes for self-hosted hosts are in place.
7. The e2e suite runs the flow against an in-cluster Forgejo; the GitHub flow runs against a test
   organization at the gate.

## 12. Decisions (Chris, 2026-11-21: all recommendations accepted)

| Id   | Question                                                                                                            | Decision                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| GQ1  | One connection per Workspace, or several?                                                                           | Several, up to 5 (G2).                                                                                                      |
| GQ2  | May agents push from the sandbox (G11), or only act through tools?                                                  | Both. Without push from the sandbox an agent cannot work in a repository the normal way.                                    |
| GQ3  | Which actions ask for approval by default?                                                                          | Create repository, open pull request, comment, create issue ask; reads, branches and pushes do not (G9).                    |
| GQ4  | After conversion, is the repository on the host the record, with Kobe mirroring its default branch (G17)?           | Yes. Two records of one project would drift; Kobe's commits stop for that project.                                          |
| GQ11 | A commit from Kobe's dialog to a Repo: pull request by default, or straight to the default branch (G18)?            | Pull request by default; direct commits a per-connection setting.                                                           |
| GQ12 | Carry the project's history into the repository on conversion (G16)?                                                | Yes by default, with a choice in the dialog.                                                                                |
| GQ13 | Who may convert a project to a Repo?                                                                                | The project's owner and Workspace admins.                                                                                   |
| GQ14 | Should an existing repository in the organization be attachable as a Repo (import), in this spec?                   | Not in this spec; conversion only. It is the natural next step.                                                             |
| GQ5  | Acting as the Workspace (app or bot) is the only mode; members never use their own git credentials?                 | Yes for this spec; per-member credentials are a later spec.                                                                 |
| GQ6  | GitHub Enterprise Server in scope alongside github.com?                                                             | Yes; it is the same adapter with a base URL.                                                                                |
| GQ7  | Which minimum versions of Gitea and Forgejo?                                                                        | The versions current at build time and one major back; the adapter refuses older ones. Built: Gitea 1.26.0, Forgejo 15.0.0. |
| GQ8  | Who may use a connection: every member's agents (readers read, contributors write), or only agents the admin picks? | Every member by role (G12), with an optional per-connection list of agents.                                                 |
| GQ9  | Order against the other queued work (review tickets, the rename to Kaiju, the sign-in page)?                        | Revised by Chris 2026-11-21: before the rename, after the review tickets. The rename then covers this code too.             |
| GQ10 | Should Kobe set the commit author to the member's real email, or a no-reply address?                                | The member's Kobe email, with a Workspace setting to use a no-reply form instead.                                           |

## 13. Phases and tickets

| Phase | Id                | Ticket                                                                                                               | Size |
| ----- | ----------------- | -------------------------------------------------------------------------------------------------------------------- | ---- |
| 1     | GIT-1 (KOBE-757)  | Tables, sealing purpose, permission `team.git.manage`, Site switch and host limit; probe fixtures                    | M    |
| 1     | GIT-2 (KOBE-758)  | Provider adapters: GitHub (App tokens and fine-grained tokens, github.com and Enterprise Server)                     | M    |
| 1     | GIT-3 (KOBE-759)  | Provider adapter: Gitea and Forgejo (one adapter, version check); in-cluster Forgejo for e2e                         | M    |
| 1     | GIT-4 (KOBE-760)  | Connection routes: create with test, update, replace credential, remove; health and token-expiry notices             | M    |
| 1     | GIT-5 (KOBE-761)  | Git section in the Workspace admin console; members' read-only view                                                  | M    |
| 2     | GIT-6 (KOBE-762)  | Git host tools with policy defaults, approval cards and audit                                                        | L    |
| 3     | GIT-7 (KOBE-763)  | Egress proxy: git smart-HTTP for connected organizations, per-repository credentials, read/write, limits             | L    |
| 3     | GIT-8 (KOBE-764)  | Sandbox agent: git configuration, authorship, guide page for agents                                                  | S    |
| 4     | GIT-9 (KOBE-765)  | Convert to repo: repository creation, history carried as git commits, project marked as a Repo                       | L    |
| 4     | GIT-10 (KOBE-766) | Repo mirror: refresh on push, open and timer; read-only state when the host repository goes away                     | M    |
| 4     | GIT-11 (KOBE-767) | Committing to a Repo from Kobe's commit flow (branch and pull request, conflicts); Repo mounts as a git working copy | L    |
| 4     | GIT-12 (KOBE-768) | Files panel: Repos among Projects with the git icon, host link, branch and ahead/behind; Convert to repo dialog      | M    |
| 5     | GIT-13 (KOBE-769) | Guide, install notes, release note; gate run on GitHub, Gitea and Forgejo                                            | M    |

Each phase is usable on its own: after phase 1 an admin can connect and test; after phase 2 agents
can create repositories and open pull requests; after phase 3 they can clone and push; after
phase 4 members turn projects into Repos.
