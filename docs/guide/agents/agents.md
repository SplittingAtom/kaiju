---
title: Agents
summary: How to pick an agent for a conversation, browse the Personal, Team and Site rosters, create and publish your own agent, choose how much memory it uses, and schedule it.
section: Agents and skills
order: 1
audience: member
---

An agent is a configured assistant: a system prompt, a model, skills, connectors, allowed and
denied tools and an approval mode. Every conversation runs one agent; if you pick none, it runs your
team's default agent. This page shows how to choose, find, create and schedule agents.

## Pick an agent for a conversation

The agent picker in the composer's toolbar lists the agents you can run here, grouped as
**Personal** (your own), **Team** (the team's agents and agents assigned to the team) and **Site**
(gallery agents and agents assigned to the whole site). A thread keeps the agent version it started
with, even if the agent is updated later.

## The Agents page

**Agents** in the top bar (`/agents`) has three tabs:

| Tab          | Shows                                                                                 |
| ------------ | ------------------------------------------------------------------------------------- |
| **Personal** | Your own agents, drafts included, with a **Reach** column saying where each one goes. |
| **Team**     | The team's own agents, plus members' agents assigned to the team.                     |
| **Site**     | Gallery agents, plus agents assigned to the whole site.                               |

Each row shows the name, description, owner, **Version in effect**, status and the actions you
have. **View** opens a read-only copy of the version a roster runs. Statuses include **Active**,
**Proposed**, **Draft**, **Suspended here** (the team suspended it) and **Suspended site-wide**.
An agent marked **Dangerous** runs its allowed tools without asking (see below).

## Create an agent

**New agent** on any tab creates a personal agent, which only you can edit. On the Team tab,
contributors also get **Create for the team**: a team-owned agent that outlives its creator's
membership, edited by its creator or a team admin.

The builder has two tabs, **Identity** and **Behaviour**:

- **Identity**: **Name**, **Slug**, **Description** (one line on what it is for), an icon, the
  **System prompt** ("What the agent is told at the start of every conversation") and up to eight
  **Conversation starters**.
- **Behaviour**: **Model**, **Skills** (with "Use only the listed skills"), connectors (all the
  team enables, or chosen ones), **Allowed tools** and **Denied tools**, and **Approval mode**:
  **Ask on write**, **Ask for every tool** or **Auto (allow-listed tools only)**. The mode is never
  looser than the team's floor.

**Allowed tools** limits the agent; Kaiju's server refuses every call the list rules out, whatever
the approval mode:

- **Connector tools** (named `mcp__<connector>__<tool>`, globs like `mcp__github__*` allowed):
  only the ones the list names, as soon as the list names anything.
- **Built-in tools** (read, bash, write, edit, memory, projects and the like): limited only when
  the list names at least one of them; then only the named ones. A list of connector tools alone
  leaves every built-in available.

For example, `mcp__github__get_issue` alone lets the agent use that one GitHub tool plus every
built-in; `read`, `grep` and `mcp__github__get_issue` let it use exactly those three. An empty list
limits nothing. **Denied tools** always wins. Neither list ever skips an approval: an allowed tool
still asks when the mode or a rule says so. Each conversation uses the lists of the version it runs.

**Save draft** keeps your changes; **Test chat** tries the draft without publishing. **Publish…**
creates a new version, after a safety check. Each published version is kept in **Version history**.

**Export to Orbit** (in the builder and on each version in Version history) downloads a published
version as an Orbit YAML file (`<agent>-v<n>.orbit.yaml`) for safety evaluation. Its `metadata`
has a `kaiju:` section with the version, approval mode and connectors. Files exported before the
rename have a `kobe:` section instead; Kaiju's evaluation runner still reads them, with no change
needed. A file with both sections is refused: keep `kaiju:` only.

### Memory

The builder's **Memory** section sets how much memory the agent uses, per published version:

| Setting        | What the agent gets                                                                       |
| -------------- | ----------------------------------------------------------------------------------------- |
| **All memory** | Memory notes (My memory, project memory) and any other memories Kaiju keeps. The default. |
| **Notes only** | Memory notes and Site Policy.                                                             |
| **Off**        | Site Policy only: no memory index, no **remember** or **recall** tools.                   |

**Site Policy** (the site's rules) reaches every run whatever this setting says; only the site's
**Allow memory** switch stops it.

The agent always uses the memory of the person running it, never yours: sharing an agent never
shares your memory. **Save as a new version** publishes the current version again with the new
setting (the draft is untouched), so threads keep their version and rosters that follow your latest
version get it. The new version shows **Not evaluated** in Version history: memory changes how
the agent behaves, so evaluate it again before relying on its old score. Publishing the draft keeps
the current setting; restoring a version restores its setting (the confirmation says when that
changes memory). An adopted copy keeps the setting of the version it copied; a fork starts at
**All memory**. A **Test chat** uses the current version's setting. Site admins set it the same way
for gallery agents. Team and site memory switches still apply on top: an agent set to **All
memory** has none where memory is switched off.

**Dangerous** mode ("allowed tools run without asking") can only be set by team and site admins. It
applies only to tools named one by one in Allowed tools, and only in interactive conversations;
deny rules and the team's ask rules still apply.

## Share an agent with a team or the site

A roster lends an agent to a team or the whole site without copying it; you stay the only editor.
From your agent's row menu:

- **Assign to _team_** (contributors and team admins) or **Propose to _team_** (members; a team
  admin approves or declines).
- **Assign to the site** (site admins) or **Propose to the site** (anyone, for a published agent).

A roster follows your latest published version unless its admins pin one. **Withdraw from _team_**
or **Withdraw from the site** takes it back. The Reach column shows where it went, including
"Declined for _team_" with the admin's note.

### Adopt an agent into a roster

A roster's admins can make a lent agent their own. On an assigned entry's row menu, **Adopt into
_team_** (team admins, Team tab) or **Adopt into the site** (site admins, Site tab) asks "Adopt
_agent_ into _team_?" and, on **Adopt**, does it all in one step:

- the agent's current published version is copied as **v1** of a new agent: on a team roster a
  team-owned agent whose creator is the admin who adopted it; on the site roster a site-owned
  gallery agent with no repository definition, which releases never update or reset;
- the roster entry is removed, so the roster runs the copy from then on;
- the copy remembers which agent and version it came from, and keeps that version's memory
  setting.

Adopt works whether or not the agent's owner is still around, and leaves the owner's agent as it
is. An agent bound to a team (a fork of that team's content) can only be adopted into that team.

## Schedule an agent

A schedule sends a prompt to one of your agents at set times; its runs appear as conversations.
Open **My schedules** from the profile menu at the right end of the top bar (or `/schedules`;
`/me/schedules`) and press **New schedule**: pick the **Agent**, write the
**Prompt**, choose how it **Repeats** (or a cron expression) and the time zone, and optionally
**Email me when a run ends**. Each schedule can be edited, paused, resumed or deleted; one a team
admin paused can only be resumed by a team admin. Scheduled runs cannot stop to ask you, so
a tool call that would need approval is skipped instead and listed under **Skipped actions** at
the end of the run's conversation; remembered approvals do not apply there. While a scheduled run
overlaps a chat turn of yours, the most restrictive of the two decides: anything Kaiju runs for the
agent that your chat would ask about (sharing files, project memory, commits, Python where the
site asks before sandbox writes; in an **Ask for every tool** chat everything, reads included) and
connector tools your chat would ask about are skipped for the scheduled run too. See
[Approvals](../internet-and-approvals/approvals.md#when-a-scheduled-or-automatic-run-overlaps-a-chat).
A team admin who wants a tool to run unattended adds a team allow rule.

## Related

- [Skills](skills.md)
- [Approvals](../internet-and-approvals/approvals.md)
- [Models and thinking levels](../models.md)
