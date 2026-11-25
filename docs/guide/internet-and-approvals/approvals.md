---
title: Approvals
summary: When Kaiju asks before a tool call runs, how to allow or deny it, how remembered approvals work and where to revoke them.
section: Internet access and approvals
order: 2
audience: member
---

Kaiju's server decides every tool call the agent makes. Some calls run at once, some are refused,
and some wait for you to say yes. This page explains the approval card, remembering an approval,
and how to take one back.

## When Kaiju asks

Whether a call asks depends on the agent's approval mode and your team's rules:

- **Ask on write** (the usual mode): Kaiju asks before the agent changes something outside its
  sandbox, such as a connector tool that writes, project memory, or a commit to a project. Work
  inside the sandbox (files in My files, shell commands, Python) runs without asking unless your
  team added a rule that asks.
- **Ask for every tool**: every call asks.
- **Auto (allow-listed tools only)**: nothing asks; a call that would ask is refused instead.
- Team and site **ask rules** make particular tools always ask, and **deny rules** refuse them.

Scheduled runs never ask either: a call that would need approval is skipped and listed under
**Skipped actions** at the end of the scheduled run's conversation (the "Scheduled run finished"
notification gives the count).

Connector tools, and the tools Kaiju runs for the agent itself (memory, artifacts, sharing and
opening files, file edit proposals, notebooks, skill drafts and project commits), look at all your
conversations running at the same time: your conversations share one sandbox, and Kaiju can't tell
which of them made a call. Such a call asks whenever any of them would ask for it or refuse it (a
stricter agent or mode in another conversation, or a scheduled run going meanwhile, for example),
even if this conversation alone would run it. The card then says another conversation of yours is
running. A call this conversation's own agent refuses stays refused.

### When a scheduled or automatic run overlaps a chat

The most restrictive of your overlapping runs decides. So while you chat, a scheduled run of yours
(or one in **Auto**) loses every action Kaiju runs for the agent that your chat would ask about:
sharing files, saving project memory and project commits, and running Python where your site asks
before sandbox writes. In a chat set to **Ask for every tool** that is every such action, reads
included (recalling memory, opening a file, proposing an edit, skill drafts). Connector tools behave
the same way. A scheduled run skips them and lists them
under **Skipped actions** in its conversation; an automatic run refuses them on the tool card.
They run as usual when the schedule doesn't overlap a turn of yours.

The other way round, while a scheduled or automatic run goes, your chat asks before actions that
usually run at once (artifacts, personal memory, skill drafts), because that run only does what
your team allow-listed. Remembering such an approval doesn't stop the asking: unattended runs never
use remembered approvals, and the card says so. A team allow rule does (team admins add it).

## The approval card

The card reads "Approval needed to run _tool_" with a badge: **Reads data**, **Changes data** or
**Can delete or overwrite**. It shows "Exactly this input runs if you allow it:" with the input.
Press **Allow** or **Deny**. Only you, the conversation's owner, can decide; people you shared the
thread with cannot.

- Kaiju signs the exact input you allowed, so only that call runs, once.
- An approval waits up to one hour, then expires and the run stops.
- Stopping the run expires its waiting approvals.
- After deciding, the card says "Denied. The tool did not run." or shows the result.
- While an approval waits, "Waiting for your approval" shows above the composer and the edge of
  the conversation glows gold until you decide. See
  [Writing messages](../chat/composer.md#when-the-conversation-waits-for-you).

When several calls of one run wait, **Approve all waiting (N)** allows them together after a
confirmation (**Allow all N**). It is not offered when any of them could delete or overwrite,
writes project memory or commits to a project, or when your team turned it off.

## Admin changes

When the agent changes a Kaiju setting for you through the built-in Kaiju connector (for example a
member's role, a budget or a team connector), the card starts with **Admin change:**. It shows the
**Scope** ("Team _name_" or "Whole site"), a summary Kaiju built from the input (with names, not the
model's words), a **Before and after** table, and the exact input.

- It asks every time, in every approval mode, Dangerous included.
- It has no Remember controls and is never part of **Approve all waiting**.
- If the setting changed before you allowed it, nothing is changed and the agent has to ask again.

See [Admin from a conversation](../admin/admin-from-a-conversation.md).

## Git changes

When the agent creates a repository, opens a pull request, comments or creates an issue on a
connected git organization, the card says what will happen on which host, organization and
repository, and shows the title and the full text that will be posted (shown as plain text; long
text has **Show all**), including the last line Kaiju adds with your name and a link to the
conversation. For a new repository it shows the visibility (private, or internal; never public).
The exact input is below.

- Once posted, the text is on the git host, outside Kaiju: Kaiju cannot take it back.
- Creating a branch and reading do not ask, unless your team's policy says so (in scheduled runs
  and auto mode creating a branch is refused unless your team allow-lists it).
- These cards are never part of **Approve all waiting**. You can remember them like other tools;
  prefer remembering exactly this input, since a broader one also allows other repositories and
  texts.

When the agent commits to a **Repo** with `commit_project`, the approval is a separate kind,
`commit_repo`: the card names the host, repository and the pull request or branch the commit goes
to. It always asks: rules that allow `commit_project` do not cover it, and it cannot be
remembered.

See [Git organizations](../admin/git-organizations.md).

## Remember an approval

Tick **Remember: allow _tool_** before pressing Allow, and pick how long under **Remember for**:
**this conversation**, **until end of today**, **this run only**, **for 1 day**, **for 30 days** or
**until revoked**. For file tools, **Only this path** limits it to that one file; for other tools it
can be limited to exactly this input. Your team may offer fewer choices.

Exactly this input means the same values of the same kind: the number `5` and the text `"5"` are
different inputs, as are a list and the same list written out as text (the order of the fields
doesn't matter). An approval limited this way before November 2026 asks once more when its input
holds numbers, true/false or nested values; remember it again to keep it.

A remembered approval:

- applies only to you, in this workspace, and only in conversations where you are present (never in
  scheduled or auto runs);
- never overrides a team or site deny or ask rule;
- cannot be made for tools that can delete or overwrite, or for admin changes;
- for "this conversation" ends for good when the thread is archived, deleted or moved to another
  project.

A tool card allowed by one says "Allowed by your rule (_scope_)". For a connector tool or a tool
Kaiju runs itself, one remembered for **this conversation** or **this run only** applies only while
no other conversation of yours is running: meanwhile Kaiju asks again (it can't tell which
conversation the call came from). A longer one, such as **until revoked**, keeps applying.

## Revoke a remembered approval

Open **Profile → My approvals** (`/me/approvals`). **Remembered approvals** lists yours in this
workspace; remove any of them, effective from the next call. Rules that no longer apply (for
example after your team tightened its limits) are marked "No longer applies" with the reason. The
page also sets your **Time zone**, used for "until end of today". Team admins can see and revoke
members' rules on the team console's **Policy** page; they see the tool and scope, not the content
of your private conversations.

## The file you are viewing

When you send a message with a file open, the agent cannot overwrite that file with its file tools
in any mode: it proposes the change for your review instead. See
[Editing files](../files/file-editor.md).

## Related

- [Internet access](internet-access.md)
- [Agents](../agents/agents.md): approval modes and Dangerous mode
