---
title: Workspaces, My files and projects
summary: What a workspace, My files (your scratchspace) and a project are, who can do what in a project, and how to work on a project in a conversation.
section: Files and editing
order: 1
audience: member
---

Kaiju organises files in three layers. The **workspace** is your team's place. **My files** is your
own private space inside it. **Projects** are shared, versioned folders the workspace works on
together. The Files tab of the rail shows all three as one tree.

## The workspace

A workspace is one team: its members, conversations, projects, agents, connectors and settings.
Nothing crosses from one workspace to another. If you belong to several, switch with the
**Workspace** switcher at the top of the rail; only one is active at a time. The team console calls
its people side **Team** and the settings side **Workspace settings**; it is the same thing.

## My files

**My files** (Kaiju calls the idea your _scratchspace_) is your own volume in the workspace. Only you
and your agent see it. Every conversation you have runs in your own sandbox with My files mounted at
`/workspace`, so the agent in one conversation can pick up a file the agent in another wrote.

- **Upload file** in the Files panel adds a file; a file's **⋯** menu has **Open**, **Mention in
  message**, **Download**, **Rename**, **Move to…** and **Delete**.
- Files you attach to a message land in `uploads/<thread>/` and are read-only to the agent.
- **Add to project** on a file (or on an artifact) copies it into a project you can edit.
- **Promote to project…** on a My files folder's **⋯** menu (team admins and contributors) turns the
  folder into a new project you own, as its first commit.

Your files are kept while your sandbox sleeps and come back when it wakes.

## Projects

A project gathers instructions, a versioned file tree, project memory and shared conversations for
people working on something together. Find them under **Profile → Projects** (`/me/projects`) or
**Manage projects →** in the Files panel. **New project** creates one; team admins and contributors
can create projects, and the creator becomes the owner.

Every member of the workspace can read every project. Keep confidential work in My files or in a
separate workspace.

| Role       | Can                                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reader** | Browse the files and history, read shared conversations and project memory, and start conversations on the project. The agent cannot change the project's files. |
| **Editor** | Everything a reader can, plus check out, edit and commit files, and accept the agent's proposed edits.                                                           |
| **Owner**  | Everything an editor can, plus change the project's settings (instructions, default agent), add and remove people, hand over ownership, archive or delete it.    |

Team admins can do everything in every project of their workspace. Everyone not named as an owner
or editor is a reader.

## Work on a project in a conversation

Start a conversation in a project with **New conversation in this project** or **Open in a
conversation** on the project page, or pick the project with the control next to the composer
("Add to a project") before you send the first message. The title then reads **Project / name**;
its project part has **Open project**, **Move to project…** and **Move out of the project**.

While you have a conversation in a project (or a checkout of it), the project is mounted in your
sandbox at `/workspace/projects/<slug>/`. The Files panel lists every project: the conversation's
project is marked "Active in this conversation", the others "Not in this conversation" and open
read-only. A conversation has one project at a time.

## Change project files

The mounted folder is read-only until you check it out:

1. **Check out to edit** (on a project file or in the project's menu; editors and owners). The
   folder becomes writable for you only, and the bar counts your changes.
2. Edit files yourself in the editor, or let the agent edit them.
3. **Commit…** names the change (up to 500 characters) and saves it as a new commit. If someone
   committed in the meantime, press **Update** to bring their changes into your copy, then commit
   again. **Discard** ends the checkout and throws your changes away.

### Committing to a Repo

A Repo is a project converted to a repository on a connected git host (GitHub, Gitea or
Forgejo); its record is the repository's default branch, and Kaiju keeps a copy of it. On a Repo,
**Commit…** says where your commit goes before you commit:

- usually to a new branch on the host with a **pull request** into the default branch. The result
  names the branch and links the pull request (**Open pull request #N**). Commit again from the
  same working copy and your commit is added to that pull request while it is open;
- straight to the default branch, if a Workspace admin allowed that for the connection and the
  host does not protect the branch (otherwise you get a pull request and are told why).

Commits carry your name as author, as the Workspace's [git settings](../admin/git-organizations.md#commit-author-email)
say. If a file you changed was also changed on the host since your copy, Kaiju refuses the
commit and changes nothing on the host: press **Update**, then commit again. Changes to other
files on the host are kept. When the agent commits a Repo with `commit_project`, you approve each
commit (the card says which host, repository and branch it goes to); no rule allows it without
asking.
Committing needs the Contributor role in the Workspace and editor or owner of the project.

In a conversation on a Repo, the agent also gets a real git working copy of it at
`/workspace/.kaiju/repos/<slug>/` (next to the read-only copy at `/workspace/projects/<slug>/`):
it can work on a branch, commit, push and open a pull request there. The working copy stays in the
sandbox: it is not synced to your files (so it never counts against your storage, and the Repo's
read rule, retention and legal hold are those of the project and the host). Work the agent has not
pushed lives only on the sandbox's disk and is lost if that disk is replaced; Kaiju then clones the
Repo again. Kaiju keeps the branch and how many commits it is ahead of or behind the host. It
lives in the sandbox's own `.kaiju/` area, so it never mixes with your files: a folder of yours
named `repos/` stays an ordinary synced folder. (Before the rename that area was `.kobe/`; each
sandbox moved it, with any unpushed work, the first time it started on the new version.)

In a project conversation an editor's agent can also propose an edit to a project file; **Accept**
commits it at once, with no checkout. The agent can commit a checkout itself with its
`commit_project` tool, after your approval or a team rule allows it. See
[Editing files](file-editor.md).

Deleting a project is possible only once it has no files, conversations or project memory left.
Members may still have working copies of it: the confirmation names how many hold uncommitted
changes, and deleting the project discards them. If someone starts more uncommitted work before
the delete goes through, Kaiju asks again with the new count.

An archived project's files are frozen: uploads, deletes, commits, reverts and accepted proposals
are all refused until an owner unarchives it.

**History** on the project page lists every commit, newest first. Open a commit to see its changes,
download a file as of that commit or the whole project with **Download as zip**, and **Revert** to
add a new commit equal to an earlier one. History is never rewritten; a workspace setting may prune
old commits.

**Memory** on the project page lists readers' suggestions for the project's notes: editors, owners
and Team admins approve (adds the line under `## Learned` in the project's `MEMORY.md`) or dismiss
them, and readers see their own suggestions and what happened to them. See
[Suggest to editors](../memory.md#suggest-to-editors).

## Repos

A project converted to a Repo lives on a git host (GitHub, Gitea or Forgejo): the repository's
default branch is its record, and Kaiju shows a mirror of it. A Repo is still a project in every
other way: same roles, same place in the Files panel, same conversations.

### Repos in the Files panel

Repos sit among the projects, in the same order. A Repo has a git icon instead of the folder, and
its row shows:

- the host and `organization/repository` (hover the row, read it with a screen reader, or open
  **Repo details…** from the row's **⋯** menu, which keyboard and touch reach too);
- the branch: your working copy's branch if a conversation of yours has one, else the default
  branch;
- how many commits your working copy is **ahead** (↑) of or **behind** (↓) the host, or ✓ when it
  is even;
- **read-only**, **too large to mirror** or **refresh failed** when one of those applies.

A project that is being converted shows **converting to a Repo…**, and **conversion failed** after
a failure; it takes no Kaiju commits until the conversion ends or is abandoned.

The Repo's **⋯** menu has **Open on &lt;host&gt;** (the repository on the host, in a new tab) and
**Repo details…**, which shows:

- the host and repository, the default branch and where commits go (a pull request, or straight
  to the default branch where a Workspace admin allowed it), your working copy and your open pull
  request;
- when the mirror was last refreshed, that it is refreshing, or why the last refresh failed and
  when Kaiju tries again;
- the newest commits on the host;
- **Refresh**: the mirror refreshes when Kaiju pushes, when you open the Repo (if older than 5
  minutes), every 5 minutes, and when you press **Refresh** (30 per 10 minutes each, within the
  connection's hourly limit; if a limit is reached Kaiju says so). A commit made on the host
  appears after the next refresh.

If the repository is archived or deleted on the host, or the Workspace's connection to it is
removed, the Repo stays readable from its last mirror and **Repo details…** says why. Workspace
admins also see **Relink…** (link it to another repository of a connected organization) and
**Detach…** (turn it back into an ordinary project, starting from the mirrored files as one
commit) in **Repo details…**, for any Repo. See
[Git organizations](../admin/git-organizations.md#repos-the-mirror-read-only-repos-relink-and-detach).

### Convert a project to a Repo

**Convert to repo…** is on a project's **⋯** menu in the Files panel for the project's owner and
Workspace admins, when the Workspace has a git connection at **Read and write**. The dialog asks:

- **Git connection**, when there are several at Read and write;
- **Repository name**: the project's slug with the connection's name prefix, which you can change
  (letters, digits, `.`, `-` and `_`, at most 100 characters, not ending in `.git`);
- **History**: carry the history (each commit becomes a git commit with its author, time and
  message, oldest first) or one commit of the current files;
- for Workspace admins only, **Use an existing empty repository with this name** instead of
  creating one (it must be private, empty and in the connection's organization).

Converting is one-way. The repository gets the connection's default visibility, which the
dialog names: private, or, on GitHub only, internal where a Workspace admin chose that for the
connection (everyone in the GitHub enterprise can then read it). The conversion stops if it becomes public. Commits carry each author's Kaiju email, or a
no-reply address if the Workspace's [git settings](../admin/git-organizations.md#commit-author-email)
say so; members who have left always get the no-reply address, and the committer reads
"&lt;name&gt; via Kaiju". Files under `.github/workflows/` run on the host if it runs Actions.

Kaiju refuses to start, and says which, when:

- the project is archived, is already a Repo, or already has a conversion running or failed;
- a legal hold covers the Workspace;
- working copies hold changes that are not committed (commit or discard them first);
- the connection is not at Read and write, may not create repositories, or its host is not
  allowed by the Site;
- the name is not valid, or a repository with it exists;
- a file is one git hosts refuse (`.git` in any spelling, `.gitmodules`, very long
  `.gitattributes` lines); the dialog lists the files and the commit each first appears in;
- a file is over 100 MiB (hosts refuse it);
- the current files are more than a Repo's mirror can show: 500 files, 50 MiB per file, 256 MiB in
  all ("too large to mirror");
- the files across the history carried are more than one conversion may push: the connection's
  push limit, at most 2 GiB (convert without history if the current files are smaller).

The conversion runs in the background. The dialog shows its progress (creating the repository,
pushing commits, finishing) and you can close it; when it ends you get a notification in the bell
(see [Notices](#notices)), an email, and a notice in the Files panel if it is open. After a failure
the dialog says why, with **Retry** (it resumes
where it stopped) and **Abandon…** (the project is an ordinary project again; a repository the host
already created stays there for a Workspace admin to delete or reuse).

Afterwards the repository on the host is the record: Kaiju shows the files read-only from the
mirror and commits go to the host (see [Committing to a Repo](#committing-to-a-repo)). The
repository is outside Kaiju's retention, erasure and legal hold.

### Notices

When a conversion you started ends, the notifications bell tells you, once for each end:
"_project_ is now a Repo", or "Converting _project_ to a Repo failed" with the same reason the
Convert to repo dialog shows. Each names the repository; **Show in Files** opens the Files panel,
where the project's **Convert to repo…** retries or abandons a failed conversion. Retrying and
failing again tells you again. Only the member who started the conversion is told, and only while
they are an active member of the Workspace.

The Files panel also tells you when a conversion you are watching finished or failed. Workspace
admins also see a notice when a git connection's credential expires within 14 days, with a link
to the Git section to replace it (they get a notification in the bell and an email too, see
[Token expiry](../admin/git-organizations.md#token-expiry)). Dismiss hides a Files panel notice until you
reload; notifications in the bell stay until they are read and removed like any other.

## Related

- [Storage limits](storage-limits.md): file sizes, file counts and the workspace quota
- [Editing files](file-editor.md)
- [Memory](../memory.md): personal and project memory
- [Glossary](../glossary.md)
