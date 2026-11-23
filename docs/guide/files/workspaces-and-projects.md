---
title: Workspaces, My files and projects
summary: What a workspace, My files (your scratchspace) and a project are, who can do what in a project, and how to work on a project in a conversation.
section: Files and editing
order: 1
audience: member
---

Kobe organises files in three layers. The **workspace** is your team's place. **My files** is your
own private space inside it. **Projects** are shared, versioned folders the workspace works on
together. The Files tab of the rail shows all three as one tree.

## The workspace

A workspace is one team: its members, conversations, projects, agents, connectors and settings.
Nothing crosses from one workspace to another. If you belong to several, switch with the
**Workspace** switcher at the top of the rail; only one is active at a time. The team console calls
its people side **Team** and the settings side **Workspace settings**; it is the same thing.

## My files

**My files** (Kobe calls the idea your _scratchspace_) is your own volume in the workspace. Only you
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
Forgejo); its record is the repository's default branch, and Kobe keeps a copy of it. On a Repo,
**Commit…** says where your commit goes before you commit:

- usually to a new branch on the host with a **pull request** into the default branch. The result
  names the branch and links the pull request (**Open pull request #N**). Commit again from the
  same working copy and your commit is added to that pull request while it is open;
- straight to the default branch, if a Workspace admin allowed that for the connection and the
  host does not protect the branch (otherwise you get a pull request and are told why).

Commits carry your name as author, as the Workspace's [git settings](../admin/git-organizations.md#commit-author-email)
say. If a file you changed was also changed on the host since your copy, Kobe refuses the
commit and changes nothing on the host: press **Update**, then commit again. Changes to other
files on the host are kept. When the agent commits a Repo with `commit_project`, you approve each
commit (the card says which host, repository and branch it goes to); no rule allows it without
asking.
Committing needs the Contributor role in the Workspace and editor or owner of the project.

In a conversation on a Repo, the agent also gets a real git working copy of it at
`/workspace/repos/<slug>/` (next to the read-only copy at `/workspace/projects/<slug>/`): it can
work on a branch, commit, push and open a pull request there. The working copy stays in the
sandbox: it is not synced to your files (so it never counts against your storage, and the Repo's
read rule, retention and legal hold are those of the project and the host). Work the agent has not
pushed lives only on the sandbox's disk and is lost if that disk is replaced; Kobe then clones the
Repo again. Kobe keeps the branch and how many commits it is ahead of or behind the host. Your own
files under a `repos/` folder in My files are not synced while a sandbox runs either, so keep
them elsewhere.

In a project conversation an editor's agent can also propose an edit to a project file; **Accept**
commits it at once, with no checkout. The agent can commit a checkout itself with its
`commit_project` tool, after your approval or a team rule allows it. See
[Editing files](file-editor.md).

Deleting a project is possible only once it has no files, conversations or project memory left.
Members may still have working copies of it: the confirmation names how many hold uncommitted
changes, and deleting the project discards them. If someone starts more uncommitted work before
the delete goes through, Kobe asks again with the new count.

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
default branch is its record, and Kobe shows a mirror of it. The mirror refreshes when Kobe pushes,
when you open the Repo (if older than 5 minutes), every 5 minutes, and when you press **Refresh**; the Repo shows when it was
last refreshed. A commit made on the host appears after the next refresh. If the repository is
archived or deleted on the host, or the Workspace's connection to it is removed, the Repo stays
readable from its last mirror with a banner, and a Workspace admin can link it to another
repository or turn it back into an ordinary project. See
[Git organizations](../admin/git-organizations.md#repos-the-mirror-read-only-repos-relink-and-detach).

## Related

- [Storage limits](storage-limits.md): file sizes, file counts and the workspace quota
- [Editing files](file-editor.md)
- [Memory](../memory.md): personal and project memory
- [Glossary](../glossary.md)
