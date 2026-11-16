---
title: Memory
summary: How Kobe remembers things between conversations, the Memories and Notes tabs of My memory, how to add, edit, pin, archive or undo memories and notes, how the agent looks up memories with recall and shows one with an Open in Memory link so you can archive it, which site and workspace switches control notes and memories, where the memories picked for each message go (memory placement), how To review shows what Kobe learned from a conversation (save, edit, dismiss, Save all mine and Undo, and Add to project notes in a project conversation), how the learning model is chosen, how long memories are kept, and how a Site-wide legal hold keeps Site memories.
section: Memory
order: 1
audience: member
---

Memory lets the agent keep what it should know beyond one conversation: your preferences, facts
about your work, decisions a project made. It comes in two forms, side by side on one page, **My
memory** in the top bar (`/me/memory`):

- **Memories** (the first tab): short statements, one per line, such as "Prefers answers in
  euros". You add and edit them yourself, and the agent is given them at the start of each run.
  See [Your memories](#your-memories).
- **Notes** (the second tab): plain Markdown files the agent writes with its **remember** tool and
  reads with **recall**. The rest of this section is about notes.

This page explains how both work and how to control them.

## Two kinds of notes

- **My notes** are about you. Only you and your own agents read them. The agent saves to them
  straight away; the conversation shows a **Note saved** chip with **Undo**.
- **Project memory** (a project's notes) belongs to a project. Everyone who can read the project can read it. Because
  it is shared, an agent's write to it waits for approval by a project member before it is stored.
  The agent writes project memory only in a conversation of an editor or owner of that project.

Each kind is a small set of `.md` files with one index file, `MEMORY.md`, and topic files such as
`topics/clients.md`.

## How the agent uses memory

At the start of each run the agent gets the index of your memory (and of the conversation's
project, if any). It has two tools:

- **remember** saves or appends a note to a memory file. Notes are the agent's own; durable things
  become **memories** when you press **Learn** (the agent never writes memories itself);
- **recall** reads a memory file or searches by text. A search also returns your matching
  **memories** first (up to 8, best match first, each labelled with where it is saved and its
  kind), then the matching notes. It never needs approval;
- **show memory item** shows you one memory the run was given or a search found, with an **Open in
  Memory** link. It only reads: it changes nothing.

Ask in plain words: "Remember that I report in euros", "What do you remember about the Q3 plan?",
"Forget what you saved about my old manager" (or delete it yourself, below). The agent is told
never to store secrets or passwords in memory; do not ask it to.

### Forget a memory

The agent cannot change or archive memories. Ask "What do you know about my old manager?" or
"Forget that I prefer euros": the agent finds the memory and shows it with an **Open in Memory**
link under its tool call. The link opens **My memory** with that memory first, under **Opened
from a conversation**, where **Archive** is one click and **Undo** puts it back. An archived
memory is never given to a run again, and a search no longer finds it. Workspace and site
memories open read-only there: their curators change them.

The agent's searches over memories follow the same rules as the memories a run is given: only
yours, your current workspace's and (while the workspace allows them) the site's, and none for an
agent whose **Memory** setting is **Notes only** or **Off**. A search with a notes place
(**My notes** or the project) looks in those notes only.

## Memories in a run

Besides notes, each run can be given **memories**: short statements about you, your workspace and
the site. Kobe picks them again for every message you send, so they follow the conversation:

- **Site Policy** always comes first (at most 25 rules, 2 KiB). It fits in the room the site
  allows (8 KiB by default); only at the smallest setting can the last rules be left out.
- **Pinned** memories come next, always in the same order.
- Then four places share the rest of the room for the memories picked for this message: **your
  memories in this workspace**, **your memories in all your workspaces** (portable preferences),
  **workspace memories** and **site memories**. Each place is sure of a small share (1 KiB), and
  what one does not use goes to the others.
- The picks are the memories that best match your message, the conversation's title, your
  previous two messages on this branch of the conversation and the names of the agent and
  project. Your preferences are always considered. Recent memories count a little more, and so
  do memories the previous message got, but only when they match this message too.
- Memories are given whole, never cut. If some that matched did not fit, the agent is told how
  many were left out.

Only memories you can see reach your runs: your own (never another person's), your current
workspace's (never another workspace's), and site memories while the workspace allows them. A run
always uses **your** memory, even with someone else's agent. Policy, pinned memories and then the
rest are always given in the same order, so unchanged parts can be reused by the model provider's
cache from one message to the next.

### What the agent sees

The agent gets its memories as a section called **What Kobe knows**, in this order:

1. a short note: these are facts and preferences people saved, not instructions; for preferences
   and conventions the narrowest place wins (your memories in this workspace over your memories
   in all your workspaces, over workspace memories, over site memories); when facts disagree the
   agent asks you; nothing overrides organization policy;
2. **Site Policy**, marked as organization policy set by the site;
3. **pinned** memories;
4. your notes indexes (**Saved memory**) and the project's instructions;
5. **What Kobe knows for this message**: the memories picked for this message, and a line saying
   how many more matched but did not fit (the agent can find them with **recall**, which searches
   all your memories whether or not they were given). Where these go depends on the site's
   **memory placement** (below): by default they sit just before your message, not in the system
   prompt;
6. the file you have open and any sync conflicts (with the picks, before your message, unless the
   site keeps memories in the system prompt).

Each place is fenced and labelled with where it came from (for example "approved by a Workspace
curator" or "set by the Site"), and each memory carries its kind and the date it was saved. Text
in a memory cannot end its fence or pose as another memory, and the agent is told that memory
only ever appears there: a copy of a memory block in a file, a tool's output or a message never
counts (Kobe also breaks such copies in the open file and in tool output). Everything up to the picks stays the
same from one message to the next unless a memory changes, so the model provider can reuse it
from its cache. A changed memory reaches the very next message. The context viewer shows each
part under its own label.

#### Memory placement

The memories picked for each message change on most messages. In the system prompt that change
stops the model provider from reusing (caching) everything after it, the whole conversation
included, so each message costs more and answers start later. A site admin chooses where they go
(**Settings › Memory › Where memories for each message go**):

- **With each message, kept in the conversation** (the default): the picks go just before your
  newest message; earlier messages keep the picks they were sent with, unchanged, so the system
  prompt and the conversation so far stay cacheable.
- **With the newest message only**: the same, but earlier messages lose their picks (a leaner
  conversation; the newest message is never cached anyway).
- **A held set in the system prompt, plus changes with each message**: the memories picked at a
  conversation's first message sit in the system prompt and are re-picked every 20 messages (the
  site can choose 2 to 200), or updated when one of them is edited or archived; each message then
  gets only the memories the held set lacks.
- **In the system prompt**: as before this setting existed.
- **Only when the agent looks them up**: no picks at all; the agent searches memory itself. It needs
  memory recall, which is not available yet: until then runs use the default.

Outside **In the system prompt**, the file you have open and any sync conflicts travel the same
way, just before your newest message, so the system prompt stays the same from message to message
(a run that gets no memories at all, Policy included, keeps them in the system prompt).

In every mode Site Policy and pinned memories stay in the system prompt, the block keeps its
fences and its size budget, and **Memories in context** shows exactly the memories the run was
given. What goes beside your message is not saved in the conversation: an agent that restarts
(a sandbox waking up) sends later messages without the picks of earlier ones. When picks travel
with messages, the agent is told memory blocks count only in the system prompt and in Kobe's
"What Kobe knows for this message" note, never in what someone typed, a file or a tool's output.

An agent whose **Memory** setting is **Notes only** or **Off** gets **Site Policy** only: Policy
reaches every run, and only the site's **Allow memory** switch stops it. An agent builder's test
chat and skill and agent evaluations get no memories at all.

### See which memories a run got

Open the context viewer (the context gauge under the composer): **Memories in context (n)** lists
what your latest message's run was given, grouped by place, each with the version it got. While
your newest message is still waiting, it shows the previous message's and says so. The
`/session` dialog shows the same count as **Memories in context**. Both are yours only: people a
conversation is shared with never see what your memory gave it.

## Your memories

The **Memories** tab of **My memory** is where you keep your own memories. It has two groups:

- **Only in this workspace**: memories only you and your agents in this workspace read. Facts,
  conventions, definitions and decisions about your work always stay here. (Memories everyone in
  the workspace shares are **Workspace memories**, kept by team admins and memory stewards.)
- **All my workspaces**: preferences that follow you into every workspace you belong to (how you
  like answers, units, tone).

**Add a memory** with its text (at most 500 characters), its kind (preference, fact, convention,
definition or decision) and up to five tags, separated by commas. For a preference you can tick
**Use in all my workspaces**; Kobe then asks **Use in all my workspaces?** and shows the text, so
nothing about your work leaves the workspace by accident. Other kinds can't be moved there.

Each memory has **Edit**, **Pin** and **Archive**. Pinned memories (up to 10 in each group) are
listed first and always given to your agents; **Show more** lists older ones. Archiving never
deletes: **Show archived** lists archived memories with **Restore**. After every change the page says what happened (**Memory saved**, **Archived**,
...) with **Undo**; an undone edit brings back the version before it.

Every save runs the [checks](#what-kobe-checks-before-a-memory-is-saved) first. Their warnings
appear under the memory you were saving, a similar memory as a link to it, with **Save anyway**;
a secret is never saved. If the memory changed in another tab since you opened it, Kobe says so;
**Reload** shows the saved text above your draft, which is kept, and **Save** replaces it. An
**Undo** that comes too late (the memory changed since) is withdrawn. Each group says when it is
80% full, and when it is full (by default 300 memories only in this workspace and 50 in all your
workspaces; a site admin can change this): archive some before adding more.

## To review

When you ask Kobe to learn from a conversation, nothing is saved until you choose. What it found
waits in **To review**, at the top of the **Memories** tab of **My memory**, for the conversation
on screen. It opens by itself when the learning finishes while you are on that conversation and
no other panel is open; otherwise the bell says "3 memories to review" (its **Open To review**
button opens it) and the count waits for you.

Each suggestion is a card with:

- the **statement**, which you can **Edit** (text and kind) before saving;
- where it came from: **You said**, **You confirmed** or **Kobe noticed** (something Kobe concluded
  rather than heard from you), with its confidence, its kind and the days left;
- **why** Kobe suggests it and the **quotes** it rests on: choose a quote to scroll the
  conversation to that message, which flashes briefly;
- **Keep it for**: **Just me (this workspace)** or **This Workspace**. Only the places allowed are
  offered: something Kobe noticed always stays yours, and a Workspace memory needs your own words
  in the conversation. Saving to the Workspace needs a Team admin or memory steward. For a
  preference you can tick **Use in all my workspaces**; Kobe asks first and shows the text;
- for a change to a memory you already have (an update, a replacement or a contradiction), the
  **changes** word by word, removed words struck through and new ones underlined;
- a **Site Policy** it may contradict, with **Not a conflict? Save anyway** (recorded), and a
  similar memory you already have;
- for something about the conversation's project, one line on how project notes differ: adding to
  the project's notes asks for a signed approval of the change, while a project file's Accept
  changes only that file.

**Save** keeps it as a memory (with the same [checks](#what-kobe-checks-before-a-memory-is-saved)
as any save) and **Dismiss** drops it: later learning in the same conversation doesn't suggest it
again. **Save all mine** saves every new personal suggestion at once; if one of them needs your
attention, nothing is saved and the cards say why. After a save or **Save all mine**, **Undo**
takes it all back and the suggestions return to To review. Kobe checks your rights, the switches
and the limits again on every click. Suggestions you leave expire after 14 days (they are not
counted as dismissed), and learning again adds new suggestions to the ones still open, without
repeating any. When Kobe thinks a procedure could be a skill it says so, with a link to the
**Skill Workbench**.

### Add to project notes

In a conversation that belongs to a project, each card also offers **Add to project notes** if
you are an editor or owner of the project, or a Team admin. It adds the statement (as you edited
it) as one line under `## Learned` in the project's `MEMORY.md`, starting that section if the file
has none. Kobe first shows you the exact line and the file; **Approve and add** is your signed
approval of that change, and Kobe writes it only if nothing changed since: your role in the
project, the project memory switch, the conversation still being in the project, and the file
itself (otherwise add it again to see the new change). The line is in the project's **Notes**, so
everyone who can read the project sees it and the agent reads it in project conversations; change
or remove it there (its history shows you added it). The suggestion then leaves To review. It
never becomes a Workspace memory, and there is no **Undo** in To review for it.

The button is disabled, with the reason beside it, while project memory is turned off or the
project's `MEMORY.md` is full (200 lines). Readers of the project see **Suggest to editors**
instead; suggesting a note to the project's editors is coming soon. Only you can add from your
own conversation, and only by clicking: agents and scheduled or automatic runs never add to
project notes this way (an agent's own **remember** into project notes still asks for approval).

## See and edit your notes

Open the **Notes** tab of **My memory** (`/me/memory?tab=notes`). It lists your memory files with
their size and when they were updated. Open a file to read it, **Edit** and **Save** it, **Delete** it, or open
its **Version history** to restore an earlier version. Everything is shown as plain text.

To see a project's memory, pick the project at the top of the Notes tab, or use **Project memory**
on the project's page (it opens on the Notes tab). Readers can read it; what you can change follows your project role.

## Switches that control memory

Memory has switches at two levels, the site (site admins, in the site console's **Settings ›
Memory**) and each workspace (team admins, in **Workspace settings › Memory**). A switch works only
while it is on at both levels that have it. Every switch is on unless an admin turned it off.

- **Allow memory** (site and workspace) is the master switch. Off means no notes (the remember and
  recall tools and the memory index) **and** no memories in that workspace or on the site; Site
  Policy still applies unless the site's switch is off (below).
- **Allow project notes** (site and workspace): project memory, as above. Needs memory.
- **Allow memories** (site and workspace): short statements Kobe knows about you, your workspace
  and the site, given to the agent at the start of each run. Needs memory. Turning **Allow
  memory** off now also turns memories off, not only notes.
- **Workspace memories** (workspace): memories everyone in the workspace shares, curated by team
  admins and memory stewards on the Team console's **Memory** page, with import and export (see
  [Workspace memories](admin/team-admin.md#workspace-memories)).
- **Site memories reach this workspace's runs** (workspace): knowledge the site keeps for every
  workspace. **Site Policy** reaches the workspace's runs even when this is off.

**Site Policy** is governance: the site's rules reach every workspace's runs even when a
workspace turns memory, memories or Site memories off. Only the site's own **Allow memory** switch
turns Policy off.

- **Portable preferences** (site): your preferences (how you like answers, units, tone) follow you
  into every workspace you belong to. Facts about work never leave their workspace. Only you can
  read them; a site admin can read them only under a time-boxed, read-only break-glass grant that a
  second site admin approved. You are emailed when it starts and ends (unless it is a legal hold),
  and every read is in the site audit log and the audit view of each of your workspaces.
- **Learn from this chat** (site and workspace): you can ask Kobe to suggest memories from a
  conversation and review every suggestion before anything is saved.
- **Members may propose to the Site** (site and workspace): workspace memories can be proposed to
  the site; a team admin confirms before anything leaves the workspace. Needs **Workspace
  memories** on.

Turning a switch off stops its use from the next run on; nothing stored is deleted, and turning
it back on brings everything back.

An agent can also use less memory than the switches allow: its **Memory** setting (**All
memory**, **Notes only** or **Off**, see [Agents](agents/agents.md#memory)) is part of each
published version. It always uses your memory when you run it, never its owner's. Site Policy
reaches its runs whatever the setting.

### The learning model

Learn from this chat uses a **learning model** an admin chose: the workspace's own learning model
when a team admin set one (Workspace settings › Memory, from the models enabled in the workspace),
otherwise the site's learning model, which the workspace must have enabled. If the chosen model is
not enabled in the workspace, or none is set, Learn is unavailable and says why: it never switches
to another model, and never uses the conversation's model. The Memory page of Workspace settings
shows which model Learn uses now, or the reason it can't run (which switch, at which level, or
which model is missing). A chosen model that was disabled or removed stays shown as such until
an admin picks another.

### Site memory settings

Site admins also set, under **Settings › Memory**: where the memories for each message go
([memory placement](#memory-placement), with each message by default, and how often the held set is
re-picked, every 20 messages), the context budget (how much room memories may
take at the start of a run, 4 to 16 KiB, 8 by default), the most memories each place may hold (by
default 300 per person only in a workspace, 50 per person in all their workspaces, 1,000 per
workspace and 1,000 on the site), how
many versions of a memory are kept (50), when a memory counts as stale (90 days: an active memory not changed, and not dated with an as-of date, within that time; stale memories are only marked for review, never removed), the
retention window for archived memories (365 days), learning rate limits, and an embedding model
that is not used yet. Search always uses English word matching; there is no language setting.

The embedding model goes through the model gateway like every other model. A standard install runs
a small one inside your cluster, on CPU: **nomic-embed-text**, listed in the gateway as
`kobe-local/nomic-embed-text`. Only the gateway can reach it, so no team or sandbox calls it
directly. The people who install Kobe can turn it off and use an external model instead, such as
an Ollama server on your network or a hosted provider with a site key, added under **Models and
providers**.

### Legal hold on Site memory

A site admin can place a **Site-wide legal hold** under **Site console › Legal hold** (a second
site admin approves, as for any legal hold). While it is in force, no Site memory and no earlier
version of one is deleted: editing a Site memory past the versions-kept limit keeps every version,
and Site memory cleanup skips it. Changes to a Site memory's kind, tags, Policy flag or as-of date
are still allowed, and the site audit log records the earlier and new kind, Policy flag and
as-of date, and for tags a count and a fingerprint (not the tags themselves). A hold on one person also keeps every version of the Site memories that person wrote, for as long
as it lasts (edits still work; nothing of those memories is pruned or cleaned up). A hold on a whole
workspace covers that workspace's memories, not the Site's.

## How long memories are kept

Kobe never deletes a memory you still use: a live memory stays however old it is, and nothing is
archived for you. What goes, and when:

- **Archived and replaced memories, and earlier versions.** In a workspace they are deleted once
  they are older than the workspace's retention period (none while the workspace keeps
  conversations forever). Memories that follow you across workspaces and Site memories use the
  site's retention window for archived memories (**Settings › Memory**, 365 days by default). The
  current version of a memory is never deleted, nor a version a run used (the run's record keeps
  it).
- **Evidence.** When the conversation a memory was learned from is deleted for good, the quote and
  the link to that conversation go with it; the memory itself stays (its source is deleted).
- **Leaving a workspace.** Your own memories in a workspace are deleted 30 days after you leave it
  (or after your account is deactivated); coming back within the 30 days keeps them, and leaving again later starts a new 30 days. Workspace and
  Site memories you wrote stay (once you are removed from the workspace, they show as written by a former member). Leaving a workspace changes
  nothing for the memories that follow you.
- **Deactivation.** When your account is deactivated (by a site admin, or by your organization's
  identity provider through single sign-on), the memories that follow you are kept, unchanged,
  and are there again when your account is reactivated. Only a site admin removes them earlier,
  with **Purge memories** on the deactivated account (Site console › Users), never while a legal hold covers you or a Site-wide hold is in force. A new account made
  for you by single sign-on, instead of your old one, starts with no memories.
- **Legal holds.** A legal hold suspends all of this: a hold on a person keeps their memories (in
  every workspace and the ones that follow them) and the Site memories they wrote; a hold on a
  workspace keeps that workspace's memories and the memories that follow each of its members; a
  Site-wide hold keeps Site memories and every memory that follows a person.

## What Kobe checks before a memory is saved

Memories are short statements: facts, preferences, conventions, definitions and decisions. Every
way of saving one (the editor, an edit or **Undo**, restoring from the archive, turning Site Policy
on or off, an import, accepting a suggestion from **Learn from this chat**, approving a proposal)
runs the same checks first. Restoring an archived memory is checked like a new save, so Policy
added or rules changed while it was archived apply to it. The checks read the text the way a
person would: look-alike letters from other alphabets, invisible characters and accents, blank
filler characters (read as spaces), full-width letters, letters spaced out ("i g n o r e") and
links written as `hxxp://example[.]com` are read as the plain words they stand for.

- **Secrets are never saved.** A password, API key, access token or private key stops the save,
  at every level, Site Policy included, and nobody can save it anyway. That includes a password in
  a connection string (`postgres://user:password@host`), "the password is …" written in a
  sentence, Stripe and GitLab keys, sign-in tokens (JWTs), a token typed in groups or split with
  hyphens, and a token hidden in base64 or hex. Tags are checked too. Remove it and save again;
  keep credentials in a connector or your password manager.
- **Instructions to the agent get a warning.** A memory states something; it never gives the agent
  orders. You are warned when a memory reads like an order to the agent ("you must…", "from now
  on…", "ignore previous instructions"), mentions tools, approvals or the system prompt ("skip
  approval", "call the shell tool"), asks the agent to fetch or open a web address, or asks to
  widen internet access or use a connector ("add example.com to the allowlist", "use the CRM
  connector"). A memory can't change any of these: internet access is asked for with **Request
  access**, connectors are set up by admins, and approvals follow the site's rules. Site **Policy**
  is exempt from this check, because Policy is the site's own rules.
- **Personal data in shared memories gets a warning.** In Workspace and Site memories, which many
  people read, you are warned about email addresses, phone numbers, and a person's name near
  sensitive information (health, pay, discipline, family or identity documents). Your own memories
  are not checked for this.
- **Links are shown with their host.** A link is a web address in any spelling (with
  `https:`, `www.` or a path). You are warned when a link points to a host this workspace's sandboxes can't reach (it isn't on the workspace's internet
  allowlist, or the site's allowlist no longer holds it). Site memories and memories in all your
  workspaces are judged by the site's allowlist, since they reach every workspace (each workspace
  may still allow less). A host written
  with look-alike letters (`gіthub.com` with a Cyrillic "і") is shown in its encoded form
  (`xn--…`) with its own warning, so it can't pass for the real site.
- **Similar memories get a warning.** When the same place already holds a very similar memory,
  you are shown it first.
- **Contradicting Site Policy stops the save.** When a memory may contradict a Policy item (it is
  about the same thing but says otherwise, or adds to it), the save stops and names the Policy
  item. Restating Policy is fine.
- **Length limits.** A memory holds at most 500 characters; the reason given with a suggestion or
  proposal at most 1,000, and a reviewer's note at most 500.

For each warning you can **Save anyway**. On your own memories that is your call. On Workspace and
Site memories it is a deliberate tick. Either way the memory's version records that it was saved
over a warning (for a restore or a Policy change, which add no version, the audit log alone
records it), and the audit log records who did it, on which memory and version, and which warnings
it overrode (never the text). Saving over a Policy conflict is a separate choice, made by the
memory's owner for your own memories and by curators (team admins and memory stewards, or the
site's memory curators) for shared ones; it is recorded and audited the same way, naming the
Policy items saved over.

## Memory in your notifications

Shared memory needs people to review it, so the **Notifications** bell in the top bar tells you
when it is your turn. Each notification has a button that opens the place where you act:

- **A proposal or suggestion arrived** (to the people who review it): a Workspace memory proposal
  (opens the team console's **Memory** page), a reader's suggestion for a project's notes (opens
  the project) or a Site memory proposal (opens Site memory).
- **Your proposal or suggestion was accepted, dismissed or sent back for changes**, naming who
  decided, or **expired** undecided. A Site proposal also tells the Site's curators when its Team
  admin **confirmed** it.
- **Memories to review**: Kobe found things to remember in a conversation while you were
  elsewhere ("3 memories to review"); **Open To review** opens that conversation's
  [To review](#to-review) section. When To review opened by itself, the notification is already
  read.
- **A memory is 80% full**: Workspace or Site memory is close to its limit (to its curators).
- **A reminder**: something you review has waited a week. Each waiting item reminds you once.
- **A digest**: more than five notifications of one kind within an hour are rolled into one item
  ("4 more Workspace memory proposals in the last hour"); the first five arrive one by one. The
  digest becomes unread again when it grows.

Notifications name people and items, never the text of a memory. These notifications come with
the semantic memory features that are being rolled out; until then the bell shows none of them.

## What memory is not

Recall finds text in your memory files; it does not search by meaning. Memories are matched to a
conversation by their words, not by meaning.

## Related

- [Workspaces, My files and projects](files/workspaces-and-projects.md)
- [Approvals](internet-and-approvals/approvals.md)
