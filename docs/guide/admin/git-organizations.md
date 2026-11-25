---
title: Git organizations
summary: How Workspace admins connect a Workspace to an organization on GitHub, GitHub Enterprise Server, Gitea or Forgejo with a GitHub App or an access token, the exact permissions and scopes to choose, testing, access levels for git in sandboxes and agents' git host tools (which ask for approval), repository defaults, the commit author email, health, token expiry, replacing and disconnecting, what members see, and the Site admin's switch and allowed hosts.
section: Team admin
order: 3
audience: admin
---

A Workspace can be connected to an organization on a git host: **GitHub** (github.com),
**GitHub Enterprise Server**, **Gitea** or **Forgejo** (Codeberg and other hosted Forgejo servers
work the same way). The credential is stored encrypted on the server and never enters a sandbox,
a browser or a model; it is never shown again after you save it, not even to you.

Everything here is in the **Team console** under **Workspace settings → Git** (`/admin/team/git`),
for Workspace admins. A Workspace can have up to **5** connections, one per organization and host.
Two Workspaces may connect the same organization; each keeps its own credential.

## Connect a git organization

Select **Connect a git organization**. The dialog has three steps:

1. **Host.** Choose the provider. For GitHub Enterprise Server, Gitea and Forgejo, enter the
   server's web address (https only, no user name, query or IP address; a path such as
   `https://git.example.com/forgejo` is fine). If the Site limits the hosts Workspaces may connect
   to, the dialog lists them and refuses any other host.
2. **Organization and credential.** Enter the organization (or, for a personal namespace, the
   user) as it appears in its address. The connection covers only that organization. Choose the [access level](#access-levels) and the credential. The dialog shows
   the exact permissions to select, with a link to the host's own form.
3. **Test and connect.** **Test** reads the organization and lists what the credential may do
   (read, push and open pull requests, create repositories, administer) without saving anything.
   It names who actions will appear as, the host's version and the credential's expiry, and warns
   when the credential can do more than Kaiju needs. **Connect** is offered once a test passes; it
   tests again and stores the credential. You can also set the display name members see (by
   default "_organization_ on _provider_") and the [repository defaults](#settings).

When a test fails, the dialog says why in plain words: the credential was not accepted, a
permission is missing (it names the one the host asked for), the organization does not exist or
is not visible to the credential, the GitHub App is not installed or is suspended, the host runs
a version Kaiju does not support, or Kaiju cannot reach the host or its address is not allowed (one
message for both, so the page does not reveal which internal names exist). A GitHub App's private
key is at most 8 KiB. A server on a private network
must also be reachable under the Site's egress rules: ask a Site admin to add it as an internal
target.

### GitHub: a GitHub App (recommended)

Create a GitHub App in the organization (**Settings → Developer settings → GitHub Apps → New
GitHub App**) with these **repository permissions** and no organization or account permissions:

| Permission     | Level          | Why                                                                                                                                |
| -------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Metadata       | Read           | Required by GitHub; listing and reading repositories.                                                                              |
| Contents       | Read and write | Clone and fetch (read), push (write).                                                                                              |
| Pull requests  | Read and write | Open pull requests and comment.                                                                                                    |
| Issues         | Read and write | Create issues and comment.                                                                                                         |
| Administration | Read and write | Only if agents may create repositories. GitHub requires it for that; it also allows deleting repositories, which Kaiju never does. |

At **Read**, Read is enough for Contents, Pull requests and Issues, and Administration is not
needed. Install the App on the organization (all repositories when agents create repositories),
generate a private key, and give Kaiju the **App ID**, the **installation ID** (the number at the
end of the installation's settings address) and the **private key** (choose the `.pem` file or
paste it; an encrypted key cannot be used). Kaiju mints a one-hour token for each use, limited to
the repository and permissions that use needs. Actions appear as the App's bot, no user account is
used, and removing the App's installation revokes access at once.

### GitHub: a fine-grained personal access token

Create a fine-grained personal access token (**Settings → Developer settings → Personal access
tokens → Fine-grained tokens**) with the organization as **resource owner** (an organization owner
may have to approve it), access to all repositories (or the ones agents may use), an expiry date,
and the same repository permissions as the App above, with no organization permissions. The token
is the whole grant: Kaiju cannot narrow it per use, and actions appear as the token's owner. GitHub
cannot report a fine-grained token's permissions, so the test shows writing and creating as "not
known until first use". A classic token works but is flagged for its extra scopes.

### Gitea and Forgejo: an access token

Gitea and Forgejo have no apps, so the credential is always an access token. Create a **bot
account** that is a member of only this organization, sign in as it, and create a token under
**Settings → Applications** with these scopes:

| Scope                | Why                                                    |
| -------------------- | ------------------------------------------------------ |
| `read:user`          | The bot account's own name.                            |
| `read:organization`  | The organization, its repositories and the bot's role. |
| `write:organization` | Only if agents may create repositories.                |
| `write:repository`   | Read and push repositories, open pull requests.        |
| `write:issue`        | Create issues and comment, also on pull requests.      |

Kaiju supports Gitea 1.26.0 and Forgejo 15.0.0 and later, and refuses older servers with a message
naming the minimum. If you pick Gitea for a Forgejo server (or the other way round), Kaiju records
what the server reports.

## Access levels

Each connection has an access level, which decides what git in members' sandboxes may do with the
organization's repositories. The credential stays on the server: the egress proxy adds it to each
git request and checks the request first.

| Level              | Git in sandboxes                                                                                                    | Agents' git host tools                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Off**            | Nothing: the connection is kept but unused.                                                                         | None.                                                                                                        |
| **Read**           | Any member's sandbox may fetch (clone and pull).                                                                    | Read repositories, branches, files, pull requests and issues.                                                |
| **Read and write** | Also push, when the member has the Contributor role or above and, for a Repo, is an editor or owner of its project. | Also create branches, repositories, pull requests, issues and comments, with the same role rules as pushing. |

A member who may push can push to any branch the host allows: protect important branches on the
git host (branch protection rules or rulesets).

The test checks the credential against the level you choose (at **Read and write** it must be able
to write), and you change the level later in **Settings**. Git reaches only the connected
organization: a request for another organization on the same host is refused. The host must be in
the Site's egress ceiling (a server on a private network through an internal entry). A renamed
repository's old address is not followed: use its current name.

### Agents' git host tools

Agents act on the host's API through tools Kaiju runs on its server (the list is in
[Working with git repositories](../for-agents/working-with-git.md)). Kaiju decides every call
under the Workspace's policy:

- Reads and creating a branch need no approval while the member is present. Creating a
  repository, opening a pull request, commenting and creating an issue ask the member first, on a
  card that names the host, organization and repository and shows exactly what will be posted.
  In scheduled runs and auto mode only reads run: creating a branch and the other changes are
  refused there unless a Workspace allow rule lists them. Change the defaults with policy rules,
  as for any tool: an ask or deny rule on `mcp__kaiju_git__git_create_branch`, for example. A
  Workspace allow rule does not remove the member's approval in a conversation (only the member's
  own remembered approval does), so "always allow pull requests in `acme/docs`" is the member's
  choice, not the admin's.
- The tools come from Kaiju's built-in **git** connector, separate from the Kaiju connector: the
  Site's **Kaiju connector** setting and turning the Kaiju connector off in a conversation do not
  affect them. Their ceiling is the Site's **Git connections** switch and allowed hosts, then
  each connection's access level and agents.
- New repositories are private, or internal where the connection's repository default is
  internal; never public. A name prefix in **Settings** is required of every new name.
- Pull requests, issues and comments end with a line naming the member and linking the
  conversation. On the host they appear as the App's bot or the token's owner.
- A connection limited to chosen agents is usable by those agents only, and only while every
  conversation running in the member's sandbox uses one of them.
- Nothing destructive is offered: no deleting or archiving repositories, merging, visibility or
  settings changes, members, secrets or webhooks.
- Reading a repository that is a Kaiju Repo (with the tools or git in sandboxes) follows its
  project's read rule. Every Workspace member is currently a reader of every project, so today
  this refuses no member; it takes effect wherever a project's readers are restricted, and then
  the Repo behaves for others as if it did not exist. Converting a project to a Repo never widens
  who can read it. Other repositories of the organization stay
  readable by every member at **Read**.
- Each member may make 300 reads per 10 minutes and 30 changes per hour, and all agents together
  3,000 reads and 300 changes an hour per connection, well under GitHub's 5,000 requests an hour
  for a token (the host's own limit is shared with git in sandboxes and health checks). A change
  whose answer from the host was lost is never sent again automatically: the agent is told to
  check the host. Every change is recorded
  in the audit log (`git.repository.created`, `git.branch.created`, `git.pull_request.opened`,
  `git.issue.created`, `git.comment.created`, plus `git.write.attempted` before and
  `git.write.failed` when the host refused) with the member, conversation, agent, connection,
  repository and the host's link, never the text posted. Repositories agents create are recorded
  in the Workspace's list.

## Settings

Each connection card shows the provider, host, organization, credential (the App's ids, or the
token's last characters), access level, health, when it was last checked, the token's expiry and
what the credential may do. Health is **Working**, **Failing** (with what went wrong, such as the
credential no longer accepted or the App's installation removed), **Not checked yet**, or **Not
allowed by the Site** (the Site turned git connections off or no longer allows the host; Kaiju then
sends nothing to the host). Its buttons:

- **Settings**: display name, access level, defaults for new repositories (private, or internal
  on GitHub where the organization has it; an optional name prefix; the default branch), the
  largest push from a sandbox (default 1 GiB), **Allow commits straight to the default branch**
  (see [Commits to Repos](#commits-to-repos)), and whether every agent in the Workspace may use
  it or only agents you choose. Git in sandboxes cannot use a connection limited
  to chosen agents, because one sandbox serves all of a member's agents.
- **Replace credential**: paste a new token or key. Kaiju tests it first; the old one is then
  discarded. Sandboxes may keep using the old one for up to 30 seconds.
- **Check now**: tests the stored credential and updates the health. Kaiju also checks every
  connection every few hours.
- **Disconnect**: deletes the stored credential. Nothing on the host changes: repositories there
  stay. Sandboxes already working with the organization may keep their access for up to 30
  seconds.

### Token expiry

When a token's expiry is less than 14 days away (or has passed), the page shows a banner,
Workspace admins get one notification in the bell ("The credential of the git connection _name_
expires on _date_", or "expired on" once it has passed) and one email, and the Files panel shows
them a notice linking here (once they own or administer a project). The notification's **Open the
Git section** links here. Each credential is noticed once: the Workspace admins at that moment
are told, and an admin added later, or one who has since lost the role, is not told about that
credential. Replacing the credential removes the old token's notifications from every admin's
bell, read or not, and starts again: a new token that also expires soon is noticed again. The
email names the connection, its organization and host, and the date; the notification names the
connection and the date; neither names the token. Create a new token on the host and use
**Replace credential**.

## Commits to Repos

A Repo is a project whose record is a repository in a connected organization. When a member
commits to a Repo with Kaiju's **Commit…** dialog, or their agent does with `commit_project`,
Kaiju's server makes a git commit authored as the member (with the address chosen under
[Commit author email](#commit-author-email), and "_name_ via Kaiju" as committer) and pushes it
with the connection's credential:

- **By default**, to a new branch named `kaiju/<member>/<message>-<commit>`, and opens a pull
  request into the default branch. Further commits from the same working copy are added to that
  pull request while it is open; after it is merged or closed, the next commit opens a new one.
  Branches Kaiju made before the rename are named `kobe/<member>/...`: they keep their names (a
  branch under an open pull request can't be renamed), their open pull requests keep taking that
  member's commits until merged or closed, and a member still has only one open pull request per
  Repo from Kaiju. Kaiju never deletes these branches, under either name; delete merged ones on
  the host as you would any other.
- **With "Allow commits straight to the default branch"** (off by default), straight to the
  default branch, and Kaiju's copy of the Repo takes the same commit. Where the host protects the
  default branch, Kaiju opens a pull request instead and says so. Turning the setting on or off is
  recorded as `git.connection.updated` (field `direct_commits`).

Kaiju builds each commit on the host's current branch and checks every file it changes: if
someone changed the same file on the host since the member's copy, the commit is refused ("changed
on the git host") and nothing on the host is overwritten; the member presses **Update**, then
commits again. Changes to other files on the host are kept. Kaiju never force-pushes. A commit needs
the connection at **Read and write**, the Contributor role or above and editor or owner of the
project; an agent's commit also needs the connection to allow that agent (when it is limited to
chosen agents) and the member's approval each time (`commit_repo`: the card names the host,
repository and branch; rules that allow `commit_project` do not cover it, and it cannot be
remembered). Kaiju records `git.repo.commit_attempted` before each push and `git.repo.committed`
after it, with the pull request's number and link but never the message, file names or branch
name; `git.repo.commit_failed` when Kaiju or the host refused the commit. Members may commit to
Repos 60 times an hour (more answers "Too many commits to Repos" with when to try again).

This setting governs Kaiju's own commit flow only. Agents pushing with git in their sandbox push to
whatever branch the host allows them: protect the default branch on the host (require a pull
request) to keep it reviewed either way.

## Commit author email

Commits made in members' sandboxes carry the member's name as author, and "_name_ via Kaiju" as
committer. Under **Commit author email** on the Git page, choose the address they carry:

- **Member's Kaiju email** (the default): the email the member signs in with. Anyone who can read
  the repository on the host sees it.
- **No-reply address**: `<short id>+<name slug>@users.noreply.<Site host>` (the first characters
  of the member's id, a plus sign, their display name in lower-case letters, digits and hyphens,
  then the Site's own host name), which receives no mail and does not reveal the member's email.
  The page shows your own as an example. If the Site's address changes, new commits use the new
  host and earlier ones keep the old.

Commits pushed to the host keep the address in their history for good; a change applies to new
commits only. Changes are recorded in the audit log (`git.settings.updated`).

## Repos: the mirror, read-only Repos, relink and detach

After a project is converted to a Repo, the repository's default branch on the host is the
project's record. Kaiju keeps a mirror of it, its files and its newest 25 commits, so the Files
panel, project mounts in sandboxes and members without git access keep working. The mirror is
refreshed:

- when Kaiju pushes to the repository, including a push from git in a sandbox (about 30 seconds
  later);
- when someone opens the Repo, if it was last refreshed more than 5 minutes ago (in the
  background: the panel shows the mirror as it is meanwhile);
- every 5 minutes;
- with **Refresh**, which any member who can see the project can use (30 per 10 minutes each).
  Refresh skips the waiting after failures, but not a rate limit set by the host or the end of
  the connection's hourly budget: it then says when to try again.

A commit made on the host appears in Kaiju after the next refresh. Each refresh uses one of the
connection's 3,000 git reads an hour, the budget agents' git tools share; when it is used up the
refresh waits for the next hour. The panel shows when the mirror was last refreshed and, after a
failure, what went wrong. Kaiju retries a failed refresh after 5 minutes, then waits twice as long
after each further failure, up to 6 hours (or until the host's rate limit resets); the mirror
stays as it was in the meantime. A mirror can hold at most 500 files of at most 50 MiB each, 256 MiB in all, at the tip of the
default branch; Kaiju checks every file's size before reading it. A repository whose newest 25
commits add more than about half as much again (large files rewritten often) is also too large to
mirror until those commits are older. Convert to repo refuses a project whose current files are already beyond that ("too
large to mirror"). If a repository grows past it on the host, the Repo says it is too large to
mirror and keeps showing its last mirror; nothing changes on the host. Kaiju checks again every 6
hours (or on Refresh) and the mirror resumes once the repository is back within the limits. When
the host reports a repository size far over the limit (more than four times the largest pack Kaiju
accepts), Kaiju skips the download and the Repo stays too large; the size is only a hint, so a
repository that is only a little over is still fetched and judged by what it sends. Refresh on a
Repo that is too large to mirror works once an hour for the whole Repo; before that it says why
and when to try again. Symlinks and submodules are left out. Kaiju's history settings for projects don't apply to
a Repo: its history is on the host.

A repository renamed or transferred on the host is followed: Kaiju knows it by the host's id. When
the repository is **archived** or **deleted** on the host, or its connection is **disconnected**,
the Repo becomes read-only in Kaiju from its last mirror and shows a banner saying why. Hosts
answer "not found" both for a deleted repository and for one the Workspace's credential can no
longer see (for example a GitHub App whose repository list was narrowed), so Kaiju marks a Repo
deleted only after four such answers in a row, over at least half an hour, and keeps checking a
deleted Repo every 6 hours: when the host shows it again, it is active again. Workspace
admins then have two ways forward:

- **Relink**: link the Repo to another repository of a connected organization (or to the same one
  again through a new connection). Its default branch becomes the record and is mirrored at once,
  as a new commit on top: the old repository's last mirror stays in the project's history, so
  nothing is lost. A public repository, or one that is already another project's Repo, is
  refused.
- **Detach**: turn the Repo back into an ordinary project. One commit of the mirrored files
  starts its Kaiju history again, and Kaiju commits work as before. The repository stays on the host
  and stays listed under **Repositories**.

Relink and detach are in the Files panel: a Repo's **⋯** menu → **Repo details…** → **Relink…**
(choose the connection and type the repository's name) or **Detach…** (confirms first). See
[Repos in the Files panel](../files/workspaces-and-projects.md#repos-in-the-files-panel).

Both are recorded in the audit log (`git.repo.relinked`, `git.repo.detached`), as are mirror
updates and changes of state on the host (`git.repo.mirror_updated`,
`git.repo.host_state_changed`). Kaiju never changes anything on the host when a Repo is relinked
or detached.

## What members see

Members see which organizations the Workspace is connected to, read-only, under **Profile → My
connectors** (`/me/connectors`), section **Git organizations**: the host, organization, access
level and whether it works, with no settings and nothing about the credential, and whether their
sandbox can fetch or also push there.

## Site admins: allow git connections and limit hosts

In the **Site console → Settings → Git connections**:

- **Allow Workspaces to connect git organizations** (on by default). Off: no Workspace can connect,
  test or check a git organization, and existing connections show **Not allowed by the Site**
  until it is on again. Connections and their stored credentials are kept. Workspace admins see a notice on the
  Git page.
- **Allowed git hosts**: one host per line, such as `github.com` or `*.example.com` (a wildcard
  covers subdomains only, never a public suffix such as `*.co.uk`), at most 50. Empty allows any
  host. Enter host names only, without `https://`, port or path. A connection to a host the list
  no longer allows stays listed, shows **Not allowed by the Site** and cannot be used.

Both changes apply at once and are recorded in the audit log.
