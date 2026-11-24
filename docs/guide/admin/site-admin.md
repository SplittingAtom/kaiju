---
title: Site admin overview
summary: What site admins do and where each setting lives in the Site console (people, grants such as Site memory steward, teams, models, connectors, egress ceiling, policy floor, Site memory and Policy with import and export and the Site proposals queue, appearance, legal holds including the Site-wide hold on Site memory, audit, break-glass for teams and for one person's portable memories, and backups).
section: Site admin
order: 1
audience: admin
---

Site admins run one Kaiju site for the whole organization: they invite people, create teams, connect
model providers and connectors, set the limits every team works within, and look after branding,
audit and backups. This page is a map of the **Site console** (`/admin/site`), opened from **Site
console** in the top bar.

## Site roles

There are three site roles: **Owner**, **Admin** and **User**. Owners and Admins are site admins and
can use every Site console page. Only the Owner grants or removes Admin and transfers ownership.
Site admins cannot read a team's conversations or files; when they must, they use break-glass
access, which is time-boxed, read-only, audited and shown to the team. Nobody but their owner can
read a person's portable preferences either; reading them needs its own break-glass grant on the
**Portable memory access** page (see below).

## People

- **Users**: everyone with a Kaiju account: site role, two-factor status, deactivate and reactivate.
  Deactivating keeps the person's memories that follow them across workspaces, so reactivating
  restores them unchanged. It deletes their connector keys in every workspace: after reactivation
  they enter them again. On a deactivated account, **Purge memories** deletes those memories for
  good once you type the person's email address to confirm (refused while a legal hold covers the
  person or a Site-wide hold is in force; memories a run in a held workspace used stay; a very
  large purge reports how many are left: choose it again to continue). Every purge is in the
  site audit log (`retention.site_memory_purged`), also one that found nothing. Their own memories in each workspace go 30 days after deactivation,
  as when they leave a workspace. See [Memory](../memory.md#how-long-memories-are-kept).
  With single sign-on on, **Single sign-on** on a row shows the person's linked organization
  sign-ins (**Unlink**) and **Expect SSO link**: their next sign-in from the chosen provider links
  automatically when its verified address matches theirs and lies in one of the provider's
  verified domains (once, within 14 days). The Owner and Admins link only by signing in themselves.
  **Sign-in protection** notices at the top: an account that had 10 failed password or
  authenticator-code attempts in 15 minutes (from any address, counted together) gets one attempt
  a minute until the 15 minutes are over, and shows **Sign-in slowed**. Kaiju never locks an
  account; passkeys and single sign-on still work. A password reset, or signing in with the
  password (and code) or through single sign-on, clears it; a passkey sign-in does not, since
  anyone holding a session could add a passkey. Each time an account starts being slowed down the audit log records
  `auth.sign_in.throttled` (once per 15 minutes, not per attempt; no email is sent). Addresses
  with no account are slowed down the same way, so the answer never tells whether an account
  exists. A second notice appears when, in the last day, sign-in or SCIM requests arrived without
  a client address Kaiju can trust: per-address limits are then shared by everyone. Fix the trusted
  proxies (`auth.trustedProxies` in the Helm values, `KOBE_TRUSTED_PROXIES`) so they name the
  proxies in front of Kaiju; the server also warns in its log.
- **Single sign-on** and **SSO access mappings**: let people sign in with Microsoft Entra ID or
  another OpenID Connect provider, decide which app roles or groups give which team role,
  create SCIM tokens so the provider provisions and deactivates accounts, and **Require single
  sign-on** (password and passkey sign-in off). See
  [Single sign-on](single-sign-on.md).
- **Invitations**: invite people by email; resend or revoke open invitations.
- **Site roles**: who is Owner and who are Admins, and two grants that sit beside the roles and
  are given and taken by Site admins (audited as `identity.site_grant.granted` and `.revoked`):
  - **Skill reviewers** review Skill Registry submissions.
  - **Site memory stewards** curate Site memory: they add, edit, archive and pin the facts and
    conventions every workspace sees, and accept or dismiss the proposals team admins send to
    the Site. They can't make an item Policy, change Policy or change memory switches, and the
    grant gives no other Site right (only the Site console's **Memory** page). Site admins can already do all of this, so only users are
    offered. **Take Site memory steward** ends it after a confirmation; what they saved stays.

## Teams and agents

- **Teams**: create teams (workspaces) with their first team admin and rename them (Kaiju has no
  way to delete a workspace; see [Legal hold on Site memory](../memory.md#legal-hold-on-site-memory)
  for what a deletion would have to respect). **Manage
  members** opens a team's members: name, email, team role, how they joined (invitation, site
  admin, or "Managed by _provider_" for single sign-on) and whether the account is active. From
  there you can:
  - **Add existing users** without an invitation: search by name or email, tick one or several,
    choose a team role (Member, Contributor or Team admin) and **Add**. They are in the team at
    once and are told in Kaiju (and by email); a pending invitation of theirs to the team is
    withdrawn. Deactivated users and accounts whose email address isn't verified (for example a
    single sign-on account whose provider didn't vouch for the address) can't be added: invite
    those people instead.
  - **Change a team role** or **Remove** a member, with the same rules and effects as the Team
    console: a team always keeps one active team admin; a removed member's schedules there pause,
    their sandbox is cleaned up and their shared threads go private.
  - **Take over** a membership the identity provider manages: it can't be changed or removed
    until you do, and the identity provider stops managing it from then on.

  You can't add yourself or change your own membership here: site admins reach team content only
  through break-glass. Site roles never change here. Every change is in the team's own audit log
  under your name, marked as made by a site admin, and the team's admins are told in Kaiju (and by
  email) each time.

- **Gallery agents**: the site's agents on the Agents page's Site tab: edit, set memory, compare
  with the repository, reset, evaluate, export, approve proposals, and **Adopt into the site** to
  turn a member's assigned agent into a site-owned gallery agent (see
  [Agents](../agents/agents.md#adopt-an-agent-into-a-roster)).
- **Skill Registry**, **Skill reviews** and **Skill tags**: the registry's rules and judge, the
  review queue for submitted skills, and topic tags and site default skills.

## Models and connectors

- **Models and providers**: provider keys and the model catalog with aliases. Teams choose from
  this catalog.
- **Connector registry**: register MCP servers teams may enable, their credentials (a site key or
  each member's own key), pinned tools, and where their apps open (in the conversation, the
  artifact column or the rail). Select a connector's name to open its details at the side: server
  URL, authentication and whose key it uses (never the key itself), status and when Kaiju last
  checked it for changes, which teams enabled it and with what exposure, its app templates
  (`ui://`) with their approval and where each opens, and every tool under **Read only** or
  **Write** with its description, risk hints (destructive, idempotent, open world), inputs, whether
  it is pinned or awaiting approval, and an **MCP-UI** badge when it opens an app. From 12 tools
  on, a **Filter tools** field narrows the list by name or description ("12 of 140 tools") and
  each column scrolls on its own. The details are read-only, apart from **Your account** for an
  OAuth connector (below); **Review**, **Re-probe**, **Enable**/**Disable** and **Site key** stay
  in the row. Escape or **Close** returns to the list.
- **Adding a connector that uses OAuth.** Kaiju lists an OAuth server's tools with a site admin's
  own connected account, so a new one has **No tools yet: connect an account** in the list until
  someone connects. The server is reached through Kaiju's connector policy like any other.
  1. Register it with **Authentication** set to **OAuth**.
  2. Have a team enable it (Team console → **Connectors**). Kaiju keeps your sign-in in your
     active workspace, so that workspace must be one that enabled it; otherwise **Your account**
     says so and **Connect your account** is off.
  3. Press **Connect your account** in the row (or open its details), sign in at the service, and
     you come back to the registry with the connector's details open and "Connected your account
     to _connector_.".
  4. Press **Re-probe** under **Your account**: Kaiju lists the server's tools with your sign-in and
     pins them ("Pinned 120 tools.").
     Members then connect their own accounts at **Profile → My connectors**. A team admin who picks
     **Chosen tools** for a long list can filter it and use **Choose all shown** and **Clear all
     shown**.
- **How Kaiju checks a connector's tools.** Pinning, **Re-probe** and the periodic check for
  changed tools ask the server for its tool list with a credential when the server wants one:
  the site-wide key if the connector has one, else your own key (when you pin or re-probe) or the
  key of the site admin who last pinned or approved its tools (the periodic check); never a
  member's. A connector that uses **OAuth** is checked the same way with a site admin's own
  connected account: before you can pin one whose server asks for sign-in, connect your own
  account for it (**Connect your account** in its details, or **Profile → My connectors**, in a
  workspace that enabled it), then **Re-probe** (the pin otherwise fails with "connect your own
  account first"). Kaiju uses
  that sign-in only to list the server's tools and app templates, never to run a tool or in a
  sandbox, and renews it when it runs out. The **Audit** shows which was used
  (`mcp.connector.probe_credential`: `site_key`, `admin_key`, `admin_oauth` or `none`).
- **Changing a connector's server URL or authentication** (none, API key, OAuth) deletes every
  member's stored key or sign-in for it, in every team (audited as `mcp.grant.removed`), and the
  OAuth client Kaiju registered with its server; switching back does not bring them back. Members
  add their key or sign in again.

## Safety

- **Egress ceiling**: the domains any team may enable, with presets; site-scope access requests;
  marking a domain internal (same cluster). See [Internet access](../internet-and-approvals/internet-access.md).
- **Policy floor**: site-wide deny and ask rules, the minimum approval mode every team inherits,
  and remember limits.
- **Skill blocklist**: skill content that never loads anywhere on the site.

## Governance

- **Audit log**: the site-wide, append-only audit log. A workspace's events show here without
  anything that points into its conversations (thread, message, run, learning pass, candidate,
  tool call or approval ids, thread folder names, and the "via agent" line); the workspace's own
  audit log (Team console › **Audit view**) keeps them. The same holds for the export and for
  audit forwarding. A short note above the events says so.
- **Usage and spend**: spend by team, user, agent and model, and the site budget every team's
  spend counts against.
- **Retention maximum**: the longest retention any team may choose. What else Kaiju deletes on its
  own is in [Retention and deletion](../reference/retention-and-deletion.md).
- **Legal hold**: suspend purges for a team or user, or hold the Site's own memory with a
  **Site-wide hold** (each needs two people). See
  [Memory](../memory.md#legal-hold-on-site-memory).
- **Break-glass**: request and approve time-boxed, read-only, audited access to one team.
- **Memory**: the Site's memories and Policy, for Site admins and Site memory stewards. The
  **Memories** tab lists them with filters (kind, status, tag, and Policy only or not Policy) and
  adds, edits, archives, restores, pins and tags them through the save checks, with **Undo**.
  Only Site admins see the **Policy** button on a memory (make it Policy, or ordinary again) and
  change a Policy item; stewards read Policy. Policy is given to every agent in every workspace
  in every run, so it is small: the **Policy budget** meters show items of 25 and text of 2,048
  bytes and warn from 80%. **Quality** shows the Site proposal queue's health (waiting now,
  oldest, median time to a decision over 30 days), each Site memory's runs across all workspaces
  with thumbs-down runs and the **Check this** and **Not used lately** flags (filterable), and
  Learn's numbers per workspace and in total, numbers only (see
  [Memory quality](../memory.md#memory-quality)); nothing is archived by them. **Import and export** works as on a workspace's Memory page
  ([Workspace memories](team-admin.md#workspace-memories)): Markdown bullets, CSV or a Kaiju
  export, at most 200 rows, a preview that checks every row with no model, then the new rows
  only; a Policy row imports only for Site admins and only while Policy has room. Exports are
  audited. Your own workspace's memory switches don't limit what you curate here (they decide
  what reaches that workspace's runs). The **Proposals** tab is the queue of workspace proposals
  a Team admin confirmed for the Site, with counts per state and filters by state and workspace:
  open one to see its statement, kind, justification, source workspace, proposer, date,
  endorsement and round, and what the checks find against Site memories and Policy (each with a
  word diff), then **Approve**, **Merge into existing…**, **Reject…** (reason required) or
  **Request changes…** (see [Decide on Site proposals](../memory.md#decide-on-site-proposals-site-admins-and-site-memory-stewards)).
  The memory switches stay under **Settings**.
- **Portable memory access**: break-glass for one person's portable preferences, which follow
  them into every workspace and so are outside any team's break-glass. A site admin picks the
  person, gives a reason and a window (up to 24 hours, 1 hour by default); a second site admin
  approves (on a site whose only other admin is that person, the requester approves alone and the
  grant is flagged). The person can never approve, deny or end a request about themselves. While
  the grant is active only the requester can open the person's portable memories, read-only.
  The person (not for a **legal hold**) and the site admins are emailed when it is approved and
  when it ends. Every page opened is recorded in the
  site audit log and in the audit view of each of those workspaces
  (`governance.site_break_glass.read`). A person's memories inside one workspace, and the
  workspace's own memories, still need that workspace's break-glass.

## System

- **Appearance**: the site name, logo, dark logo, favicon and style preset. See
  [Appearance](../appearance.md).
- **Settings**: site-wide settings such as required two-factor authentication (local accounts
  enrol an authenticator app; a single sign-on sign-in counts only when the identity provider
  proved multi-factor authentication, for Microsoft Entra through a Conditional Access
  authentication context, and is refused otherwise; see
  [Single sign-on](single-sign-on.md#multi-factor-authentication)), and the site's
  memory switches and settings: **Allow memory** (the master switch: off means no notes, no
  memories and no Site Policy anywhere; it is the only switch that stops Policy), project notes, memories, **Portable preferences**, **Learn from this chat**
  and **Members may propose to the Site**, each also needing the workspace's own switch;
  **Nudge to learn** (site only: the composer's **+** dot pulses once after about 10 new messages
  or a correction, never starting learning itself; see
  [Memory](../memory.md#learn-from-this-chat)); the
  **learning model** (used by workspaces without their own, where enabled; learning never falls back
  to another model or the conversation's model), **where memories for each message go** (memory
  placement: with each message, kept, by default; with the newest message only; a held set in the
  system prompt plus changes, re-picked every 20 messages by default; or in the system prompt;
  see [Memory placement](../memory.md#memory-placement)), the context budget (4 to 16 KiB), scope limits (by default 300 memories per person in each workspace, 50 portable preferences per person, 1,000 per workspace and 1,000 on the Site; saving stops at the limit and nothing is ever removed to make room, and curators are told when a workspace or the Site reaches 80%), versions kept per memory (default 50; older versions are pruned on edit, except versions a run used and while a legal hold applies: a Site-wide hold for Site memories),
  the stale threshold, **Not used after** (days without a run receiving a memory before the
  Quality tab flags it, default 90), the retention window and learning rate limits. Turning a switch off deletes
  nothing. See [Memory](../memory.md#switches-that-control-memory). The **embedding model**
  (search by meaning) sends every run message (up to 4,000 characters) and every saved memory to
  its provider, and **Build vectors** sends the memories of every workspace, every member's portable
  memories and the Site's (saving a new model starts it too, whether or not you have an active
  workspace), charged to you in your active workspace or, with none, to each workspace for its own
  memories: choose a provider your
  organization may send that to (the in-cluster model keeps it in your cluster). See
  [Search by meaning](../memory.md#search-by-meaning). The **Kaiju connector** setting is **Off**, **Docs only** (the
  default) or **Docs and admin tools**; see below. It does not affect agents' git host tools,
  which follow **Git connections**. **Kaiju admin limits** set how many admin reads
  per minute (default 60) and admin changes per hour (default 30) one person's agents may make,
  1 to 10,000 each; they apply to the next call, and every change is audited. **Git
  connections**: whether Workspaces may connect git organizations (on by default; off stops every
  connection without deleting it) and the **allowed git hosts** (empty allows any host); see
  [Git organizations](git-organizations.md#site-admins-allow-git-connections-and-limit-hosts).
- **Isolation**: whether agents can run. Kaiju refuses to run agents unless the cluster offers a
  gVisor or Kata sandbox runtime; this page shows the check and how to fix it.
- **Backup and restore**: how to back up and restore the site, and the last restore.
- **Audit forwarding**: whether audit events reach your security monitoring system (SIEM).
  Workspace events are forwarded with the same Site-safe details as the Audit log; site events
  as recorded.

### Ingress rate limit

The Site console's overview page shows an information notice when nothing limits how many requests
one address may send through Kaiju's ingress. Kaiju still limits sign-in, uploads and other costly
requests itself; the notice is not an error and nothing stops working.

- **No rate limit at the ingress**: Kaiju's Helm chart manages the ingress and its optional rate
  limit is off (the default).
- **Ingress rate limit unknown**: the ingress is not managed by the chart (your organization runs
  its own), so Kaiju can't tell.

Either way it is a deployment setting, not a Site console one: ask whoever installed Kaiju. They can
turn on the chart's limit (`ingress.rateLimit.enabled`), or, when a load balancer, firewall or
their own ingress already limits requests per address, declare it with
`ingress.rateLimit.external: true`; the notice then goes away. The install guide's section "Rate
limit at the ingress" has the details.

## From a conversation

The built-in **Kaiju** connector gives every agent the guide's docs tools. Its admin tools are off
until you choose **Docs and admin tools** under **Settings → Kaiju connector**; each team admin then
chooses a level for their team (**Docs only**, **Read** or **Read and write**). In a team at Read
and write, a site admin can ask the agent to deactivate or reactivate a user, create a team, add
people to a team, change their team role or remove them, invite someone, update the model catalog, change a connector's status, edit the egress ceiling,
decide access requests, manage the skill blocklist and site grants (Skill reviewer, Site memory steward), change branding or
the site budget, and read usage and the audit log. Each change shows an **Admin change** card
("Whole site") first and is audited "via agent". Site roles, ownership, break-glass, legal hold,
retention, deletions, connector registration, provider keys and the site settings themselves stay
in the console. See [Admin from a conversation](admin-from-a-conversation.md).
