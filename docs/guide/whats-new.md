---
title: What's new
summary: What changed in the latest Kobe release (v1.3, Semantic Memory) for members and admins, including that turning Allow memory off now turns memories off too, with links to the pages that explain each change.
section: Getting started
order: 4
audience: member
---

What changed in the latest release, in short, with a link to the page that explains each part.

## v1.3: memories

Kobe can now keep short **memories** beside your notes: facts, preferences, conventions,
definitions and decisions it gives the agent at the start of each run, so you don't repeat
yourself. Your notes work as before.

### For everyone

- **My memory has two tabs.** The memory icon in the top bar (or `/memory`) opens **My memory**
  with **Memories** and **Notes**. Add, edit, pin, archive and undo memories there. See
  [Your memories](memory.md#your-memories).
- **Learn from this chat.** Ask Kobe to suggest memories from a conversation you started: **+** ›
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
- **Checked before saving.** Kobe refuses secrets and warns about instruction-like text, personal
  data and near-duplicates. A memory never changes what an agent may do. See
  [What Kobe checks before a memory is saved](memory.md#what-kobe-checks-before-a-memory-is-saved).

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

The people who run Kobe find the operator notes for this release (settings, chart, migrations and
upgrade steps) in the repository's `docs/releases/v1.3.md`.
