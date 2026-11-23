---
title: Git organizations
summary: How Workspace admins connect a Workspace to an organization on GitHub, GitHub Enterprise Server, Gitea or Forgejo with a GitHub App or an access token, the exact permissions and scopes to choose, testing, access levels, repository defaults, replacing and disconnecting, what members see, and the Site admin's switch and allowed hosts.
section: Team admin
order: 3
audience: admin
---

A Workspace can be connected to an organization on a git host: **GitHub** (github.com),
**GitHub Enterprise Server**, **Gitea** or **Forgejo** (Codeberg and other hosted Forgejo servers
work the same way). Agents in the Workspace then work in that organization's repositories through
Kobe. The credential is stored encrypted on the server and never enters a sandbox, a browser or a
model; it is never shown again after you save it, not even to you.

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
   user) as it appears in its address. Agents act only there; everything else on the host stays
   out of reach. Choose the [access level](#access-levels) and the credential. The dialog shows
   the exact permissions to select, with a link to the host's own form.
3. **Test and connect.** **Test** reads the organization and lists what the credential may do
   (read, push and open pull requests, create repositories, administer) without saving anything.
   It names who actions will appear as, the host's version and the credential's expiry, and warns
   when the credential can do more than Kobe needs. **Connect** is offered once a test passes; it
   tests again and stores the credential. You can also set the display name members see (by
   default "_organization_ on _provider_") and the [repository defaults](#settings).

When a test fails, the dialog says why in plain words: the credential was not accepted, a
permission is missing (it names the one the host asked for), the organization does not exist or
is not visible to the credential, the GitHub App is not installed or is suspended, the host runs
a version Kobe does not support, or Kobe cannot reach the host. A server on a private network
must also be reachable under the Site's egress rules: ask a Site admin to add it as an internal
target.

### GitHub: a GitHub App (recommended)

Create a GitHub App in the organization (**Settings → Developer settings → GitHub Apps → New
GitHub App**) with these **repository permissions** and no organization or account permissions:

| Permission     | Level          | Why                                                                                                                               |
| -------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Metadata       | Read           | Required by GitHub; listing and reading repositories.                                                                             |
| Contents       | Read and write | Clone and fetch (read), push (write).                                                                                             |
| Pull requests  | Read and write | Open pull requests and comment.                                                                                                   |
| Issues         | Read and write | Create issues and comment.                                                                                                        |
| Administration | Read and write | Only if agents may create repositories. GitHub requires it for that; it also allows deleting repositories, which Kobe never does. |

At **Read**, Read is enough for Contents, Pull requests and Issues, and Administration is not
needed. Install the App on the organization (all repositories when agents create repositories),
generate a private key, and give Kobe the **App ID**, the **installation ID** (the number at the
end of the installation's settings address) and the **private key** (choose the `.pem` file or
paste it; an encrypted key cannot be used). Kobe mints a one-hour token for each use, limited to
the repository and permissions that use needs. Actions appear as the App's bot, no user account is
used, and removing the App's installation revokes access at once.

### GitHub: a fine-grained personal access token

Create a fine-grained personal access token (**Settings → Developer settings → Personal access
tokens → Fine-grained tokens**) with the organization as **resource owner** (an organization owner
may have to approve it), access to all repositories (or the ones agents may use), an expiry date,
and the same repository permissions as the App above, with no organization permissions. The token
is the whole grant: Kobe cannot narrow it per use, and actions appear as the token's owner. GitHub
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

Kobe supports Gitea 1.26.0 and Forgejo 15.0.0 and later, and refuses older servers with a message
naming the minimum. If you pick Gitea for a Forgejo server (or the other way round), Kobe records
what the server reports.

## Access levels

| Level              | Agents can                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Off**            | Nothing: the connection is kept but unused.                                                                                           |
| **Read**           | List and read repositories, branches, pull requests and issues, and clone.                                                            |
| **Read and write** | Also create private repositories, branches, pull requests, issues and comments, and push. Members need the Contributor role to write. |

Creating a repository, opening a pull request, commenting and creating an issue ask for approval
by default; Workspace admins change that with ordinary policy rules. Agents never delete
repositories, make them public, change organization settings or merge pull requests.

## Settings

Each connection card shows the provider, host, organization, credential (the App's ids, or the
token's last characters), access level, health, when it was last checked, the token's expiry and
what the credential may do. Its buttons:

- **Settings**: display name, access level, defaults for new repositories (private, or internal
  on GitHub where the organization has it; an optional name prefix; the default branch), the
  push size limit (default 1 GiB), whether commits from Kobe may go straight to the default branch
  (off by default: a branch and a pull request), and whether every agent in the Workspace may use
  it or only agents you choose.
- **Replace credential**: paste a new token or key. Kobe tests it first; the old one is then
  discarded.
- **Check now**: tests the stored credential and updates the health. Kobe also checks every
  connection every few hours.
- **Disconnect**: deletes the stored credential. Nothing on the host changes: repositories there
  stay. Repos in Kobe linked to the connection stay too, read-only from their last copy and marked
  unreachable, until a Workspace admin links them again.

When a token's expiry is less than 14 days away (or has passed), the page shows a banner and
Workspace admins get one email. Create a new token on the host and use **Replace credential**.

## What members see

Members see which organizations the Workspace is connected to, read-only, under **Profile → My
connectors** (`/me/connectors`), section **Git organizations**: the host, organization, access level and whether it works,
with no settings and nothing about the credential.

## Site admins: allow git connections and limit hosts

In the **Site console → Settings → Git connections**:

- **Allow Workspaces to connect git organizations** (on by default). Off: no Workspace can connect,
  test or check a git organization, and agents stop using existing connections until it is on
  again. Connections and their stored credentials are kept. Workspace admins see a notice on the
  Git page.
- **Allowed git hosts**: one host per line, such as `github.com` or `*.example.com` (a wildcard
  covers subdomains only, never a public suffix such as `*.co.uk`), at most 50. Empty allows any
  host. Enter host names only, without `https://`, port or path. A connection to a host the list
  no longer allows stays listed but cannot be used.

Both changes apply at once and are recorded in the audit log.
