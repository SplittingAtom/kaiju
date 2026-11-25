---
title: Connectors and apps
summary: How MCP connectors give the agent tools, how to connect your own account (OAuth) or add your own key for a connector, turn connectors on or off per conversation, and use app cards in answers.
section: Connectors and apps
order: 1
audience: member
---

Connectors link Kaiju to other systems (a ticket tracker, a data platform, an internal API) through
the Model Context Protocol (MCP). Each connector gives the agent a set of tools. Some connectors
also bring apps: small interactive views that appear in the conversation. This page explains how to
use both.

## Where connectors come from

A site admin registers a connector in the **Connector registry**. Team admins then enable it for
the team in the team console's **Connectors** page and choose which of its tools the team may use:
**Read-only tools**, **All tools** or **Chosen tools**. You see the connectors your team enables.
That page lists each connector's tools under **Read only** and **Write**; a tool that opens an app
card is marked **MCP-UI**.

The agent never holds the connector's credentials. Its calls go through Kaiju's MCP proxy, which
adds the credential on the way out, checks the call against your team's rules and records it.

## The built-in Kaiju connector

Every site has one connector it did not have to register: **Kaiju**, Kaiju's own. It needs no key
and no internet access, and it cannot be turned off for a conversation. Its docs tools let any
agent read this guide, so you can ask "How do I…" anywhere. Where a site admin and your team admin
turned them on, its admin tools let the agent read or change Kaiju settings as you, within your own
permissions, and every change asks you first with an **Admin change** card. In the composer,
**+** → **Connectors** lists it first, with "Docs always on" and which admin tools you have. In
the agent creator you can name **kaiju** among an agent's connectors to give it the admin tools.
See [Admin from a conversation](admin/admin-from-a-conversation.md).

## Connect your account or add your own key

Some connectors act as you, with your own account. Open **Profile → My connectors**
(`/me/connectors`). It lists every connector your workspace enabled that needs something from
you, even one that has no tools yet.

### Connectors that use OAuth

A connector that uses OAuth asks you to sign in at the service with your own account; there is no
key to copy. Its card shows **Not connected**, **Connected** (with when you first connected) or
**Sign-in expired, reconnect**.

1. Press **Connect**. Kaiju sends you to the service's own sign-in page.
2. Sign in there and allow access.
3. The service sends you back to **My connectors**, which says "Connected your account to
   _connector_." If it did not work, it says why ("The sign-in was cancelled or refused at the
   service.", "Could not reach the connector's authorization server. Try again later.", ...).
   Press **Connect** to try again. If you switched workspace in another tab meanwhile, or took
   longer than 10 minutes, it says so; if you were signed out, you land on the sign-in page.

**Reconnect** signs in again (for example with another account). **Disconnect** deletes your
sign-in for that connector in this workspace (audited as `mcp.grant.removed`); your runs can't use
the connector until you connect again. Disconnecting does not sign you out at the service itself:
to revoke Kaiju's access there too, use the service's own account settings.

Kaiju keeps the sign-in on the server, encrypted, and uses it only for your runs: the browser and
your agent never see it. It renews the sign-in by itself when it runs out, and also when the
connector's server turns it down before then (the call is then tried once more), so the card
stays **Connected** while Kaiju can renew it. **Sign-in expired, reconnect** appears only for a
sign-in Kaiju cannot renew (the service gave no renewal token and the sign-in ran out); press
**Reconnect**. If the service ends a sign-in for good, Kaiju deletes it and the card shows **Not
connected** again. Starting a connection is limited to 30 tries in 10
minutes per person ("Too many connection attempts. Try again in a few minutes.").

### Connectors that need an API key

- A connector that needs your key shows **No key added**; press **Add key**, paste your **API
  key** and save. Kaiju stores it encrypted, uses it only for your runs and never shows it again.
- **Replace key** and **Remove key** change or delete it.
- "Provided by your organization: you need no key of your own." means a site-wide key is used.

Until you add a key, your runs cannot use that connector ("Your runs can't use it until you add
one."). An app that is missing only your key shows **Add your key**, linking to this page.

### Who keeps your sign-ins and keys

Your keys (and sign-ins for connectors that use OAuth) belong to one workspace. When you are
removed from a workspace, your account is deactivated, or your identity provider removes your
access, Kaiju deletes them for that workspace (each deletion is in the workspace's **Audit** as
`mcp.grant.removed`). If you are added back, add your keys and sign in again. The same happens
when a site admin changes a connector's server address or how it signs in: add your key or sign
in again. A sign-in you finish after the connector's address changed is refused (**Connect**
again).

## Git organizations

The same page lists the git organizations your workspace is connected to (**Git organizations**):
the host (GitHub, GitHub Enterprise Server, Gitea or Forgejo), the organization, the access level
(**Read**, **Read and write**, or **Not in use**) and whether the connection works. Workspace admins
set them up; there is nothing for you to do and no credential to add, and the credential never
enters your sandbox. With **Read** your sandbox can fetch (clone and pull) there; with **Read and
write** it can also push, if your role is Contributor or above (and, for a Repo, you are an editor
or owner of its project).

Agents also get **git host tools** for these organizations from Kaiju's built-in **git** connector
(listed under **+** → **Connectors**, always on, apart from the Kaiju connector), run by Kaiju's
server: reading
repositories, branches, files, pull requests and issues (at **Read**), and creating branches,
repositories, pull requests, issues and comments (at **Read and write**, with the same role rules as
pushing). Reading a Repo follows its project's read rule (today every member may read every project). Creating a repository, opening a pull request, commenting and creating an issue ask you
first; see [Git changes](internet-and-approvals/approvals.md#git-changes). The full list is in
[Working with git repositories](for-agents/working-with-git.md). See also
[Git organizations](admin/git-organizations.md).

## Turn connectors on or off for a conversation

In the composer, **+** → **Connectors** lists your connectors in this workspace. Each working one
has a checkbox for this conversation only (on by default). In a conversation not started yet, the
choice applies once you send the first message. A connector that is not working shows a red cross
and the reason, with a link to fix it where there is one: "Connect your account to this server."
and "Your sign-in to this server expired. Connect again." link to **My connectors**. A connector
that has no tools your workspace may use yet is not listed there at all (there is nothing to turn
on); connect it from **My connectors** in the meantime.

## Connector tool calls and approvals

Connector tools are marked by the system that provides them as reading or changing data. By
default Kaiju asks you before a connector tool that changes something runs; read-only tools run
without asking. Your team's rules can ask more often, and a tool whose definition changed since a
site admin approved it is turned off until it is approved again. See
[Approvals](internet-and-approvals/approvals.md).

## Apps in answers

Some connector tools return an app: an interactive card (a table explorer, a picker, a chart)
rendered right in the answer. Apps run in a locked-down frame and can only talk to Kaiju, which
checks every call they make like any other tool call.

- **Show response.** When an answer includes an app, Kaiju shows only the app card. Everything else
  in that answer (the text, reasoning steps, other tool cards, the "Used skill" line) is behind a
  collapsed **Show response** toggle under the card; open it to read it in its original order.
  Approval cards, problems and blocked-site cards are never hidden. **Copy** still copies the
  answer's text.
- **Launch an app yourself** from the composer's **+** menu; the card says "You opened _app_ from
  _connector_".
- **Where it opens.** A site admin decides whether an app opens in the conversation, in the
  artifact column ("Opened in the side column", with **Show app**) or in the rail's **Apps** tab
  as a picker. A picker in the rail fills in your message draft but never sends it for you.
- **Size.** In the conversation an app card starts 360 px tall and grows with its content up to
  720 px. In the artifact column an app always fills the column's height and scrolls inside
  itself, following the column when you resize it.

## Related

- [Approvals](internet-and-approvals/approvals.md)
- [Team admin overview](admin/team-admin.md)
