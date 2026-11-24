---
title: What's new
summary: What changed in the latest Kaiju releases for members and admins, with links to the pages that explain each change. v1.4 connects Workspaces to git organizations on GitHub, Gitea and Forgejo and turns projects into Repos; v1.3 adds memories, and turning Allow memory off now turns memories off too.
section: Getting started
order: 4
audience: member
---

What changed in the latest release, in short, with a link to the page that explains each part.

## Kobe is now Kaiju

The product has a new name: the app, its emails, the sign-in page and this guide now say
**Kaiju**. A site that set its own name under **Site admin → Appearance** keeps showing that name.

After the upgrade your browser forgets its own choices once: the theme, the last Workspace and
conversation it opened, panel sizes and open tabs, and notices you closed. Set them again as you
go. You stay signed in. If you were in the middle of signing in with your organization's account
during the upgrade, start the sign-in again.

For admins with scripts or tools that call Kaiju's API: send the Workspace as `X-Kaiju-Team`.
The old `X-Kobe-Team` still works for this release only.

## v1.4: git organizations

A Workspace admin can connect the Workspace to an organization on GitHub (including GitHub
Enterprise Server), Gitea or Forgejo. Agents then work with its repositories, and a project can
become a **Repo** that lives on the git host.

### For everyone

- **Git in the sandbox works with no setup** for the connected organizations: `git clone`, `fetch`
  and `push` go through Kaiju, which holds the credential. Your agent never sees it. Pushing needs
  the Contributor role. See [Working with git repositories](for-agents/working-with-git.md).
- **Agents get git host tools**: list and read repositories, branches, files, pull requests and
  issues, and create branches. Creating a repository, opening a pull request, commenting and
  creating an issue ask you first. See [Git changes](internet-and-approvals/approvals.md#git-changes).
- **Convert a project to a Repo.** On a project's **⋯** menu in the Files panel, **Convert to
  repo…** (for the project's owner and Workspace admins) creates a private repository with the
  project's history. Repos show a git icon. Commits from the **Commit…** dialog become pull
  requests by default, and in a conversation on a Repo the agent gets a real git working copy.
  See [Repos](files/workspaces-and-projects.md#repos). When the conversion finishes or fails, the
  notifications bell tells you, with the reason when it failed.
- **See what your Workspace is connected to** under **Profile → My connectors**. See
  [Git organizations](connectors-and-apps.md#git-organizations).

### For admins

- **A Git page in the Team console** connects, tests, limits, replaces credentials for and
  disconnects git organizations (GitHub App, fine-grained token, or an access token for Gitea and
  Forgejo). See [Git organizations](admin/git-organizations.md). A token that expires within 14
  days is noticed once, in the bell and by email, to every Workspace admin.
- **Commits to a Repo's default branch** are off unless you turn on **Allow commits straight to the
  default branch** for the connection. Protect the default branch on the host as well.
- **Site admins** can switch git connections off for the Site and limit the hosts. See
  [Site admin](admin/site-admin.md).
- Repositories are outside Kaiju's retention and erasure:
  [Retention and deletion](reference/retention-and-deletion.md).

## v1.3: memories

Kaiju can now keep short **memories** beside your notes: facts, preferences, conventions,
definitions and decisions it gives the agent at the start of each run, so you don't repeat
yourself. Your notes work as before.

### For everyone

- **My memory has two tabs.** The memory icon in the top bar (or `/memory`) opens **My memory**
  with **Memories** and **Notes**. Add, edit, pin, archive and undo memories there. See
  [Your memories](memory.md#your-memories).
- **Learn from this chat.** Ask Kaiju to suggest memories from a conversation you started: **+** ›
  **Memory** › **Learn from this chat**, `/learn`, or **Ctrl+Shift+L** (**Cmd+Shift+L** on a Mac).
  Nothing is saved until you review each suggestion in **To review**. A dot on the **+** button
  pulses once when a conversation has something worth learning from. See
  [Learn from this chat](memory.md#learn-from-this-chat) and [To review](memory.md#to-review).
- **Preferences follow you, facts stay put.** Your preferences (tone, units, how you like answers)
  can follow you into every workspace; facts about work stay in the workspace they belong to.
- **Forget something in one click.** Ask the agent to forget something and it shows an **Open in
  Memory** link; archive the memory there, with Undo. See
  [Forget a memory](memory.md#forget-a-memory).
- **Share with your workspace and the site.** Propose a memory to your workspace, or something you
  said to the whole site with a short justification. Curators decide; a team admin confirms before
  anything goes to the site, and only the statement and your justification travel, never the
  conversation. See [Propose a memory to the Workspace](memory.md#propose-a-memory-to-the-workspace)
  and [Propose a memory to the Site](memory.md#propose-a-memory-to-the-site).
- **Checked before saving.** Kaiju refuses secrets and warns about instruction-like text, personal
  data and near-duplicates. A memory never changes what an agent may do. See
  [What Kaiju checks before a memory is saved](memory.md#what-kaiju-checks-before-a-memory-is-saved).

### For admins

- **Turning Allow memory off now turns memories off too.** **Allow memory** (site and workspace)
  is the master switch for notes **and** memories. A workspace that had it off keeps no notes, as
  before, and now gets no memories either; Site Policy still reaches its runs. To keep notes and
  switch memories off, leave Allow memory on and turn **Allow memories** off. Every new switch is
  on until you turn it off, and turning one off deletes nothing. See
  [Switches that control memory](memory.md#switches-that-control-memory).
- **Workspace memories and stewards.** Team admins and **memory stewards** curate the workspace's
  shared memories, decide proposals and see the **Quality** tab on the Team console's **Memory**
  page. See [Workspace memories](admin/team-admin.md#workspace-memories) and
  [Decide on proposals](memory.md#decide-on-proposals-team-admins-and-memory-stewards).
- **Site memories and Policy.** Site admins and Site memory stewards keep the site's memories and
  decide workspaces' proposals; **Site Policy** reaches every workspace's runs. See
  [Site admin overview](admin/site-admin.md) and
  [Decide on Site proposals](memory.md#decide-on-site-proposals-site-admins-and-site-memory-stewards).
- **Choose a learning model.** Learn from this chat needs a learning model, set by a site admin
  (Settings › Memory) or for one workspace by its team admins; until then Learn says why it can't
  run. See [The learning model](memory.md#the-learning-model).
- **Search by meaning.** With an embedding model chosen in Settings › Memory, memory search finds
  memories that mean the same as a message, not only those that share its words. See
  [Search by meaning](memory.md#search-by-meaning).
- **The site audit view shows site-safe details only.** Workspace events in the Site console's
  audit view (and in what is forwarded to your SIEM) leave out conversation, run and suggestion
  ids; the full record is in each workspace's own audit log.
- **How long things are kept.** Suggestions nobody acts on go after 14 days, waiting proposals
  after 30; nothing you still use is ever deleted. See
  [How long memories are kept](memory.md#how-long-memories-are-kept).

The people who run Kaiju find the operator notes for this release (settings, chart, migrations and
upgrade steps) in the repository's `docs/releases/v1.3.md`.
