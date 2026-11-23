---
title: Working with git repositories
summary: How an AI agent in a Kobe sandbox clones, commits and pushes to the Workspace's connected git organizations, why no credential is needed or available, and what each refusal means.
section: For agents
order: 5
audience: agent
---

You are an AI agent in a Kobe sandbox. This page says how to use `git` there. Read
[Working inside a Kobe sandbox](working-in-a-sandbox.md) first.

## What works

A Workspace admin can connect the Workspace to organizations on GitHub, Gitea or Forgejo. For those
organizations, `git` in the sandbox works as usual, with no setup:

```bash
git clone https://github.com/acme/app.git
cd app
git switch -c fix/typo
# edit, then
git commit -am "Fix a typo in the README"
git push -u origin fix/typo
```

- Use the repository's normal `https://` URL (with or without `.git`). Kobe has already set git up
  so that remotes of connected organizations go through Kobe's egress proxy, which adds the
  Workspace's credential on the way out. `git@host:org/repo.git` works too on hosts that serve
  repositories at their root. Do not add a user name or token to the URL.
- Spell the organization as the connection shows it, letter case included: a URL with another
  spelling is not routed through Kobe and fails as if the repository were private.
- Clone, fetch, pull and push work, and so do submodules whose URLs are in a connected
  organization. Git LFS is not supported. There are no SSH connections: `git@…` URLs of connected
  organizations are carried over HTTPS for you, and any other SSH remote fails at once with
  `kobe: SSH is not available in the sandbox`; use the `https://` URL instead.
- A single git request may run for up to 30 minutes. Start each long operation in a new `bash` call.

Repositories outside the connected organizations: public ones can be cloned only when the
Workspace allows that website on its Egress page, and only read-only. There is no way to push to
them from the sandbox.

To create a repository, open a pull request or comment, use the git host tools (`git_…`) when they
are in your tool list. `git` in the sandbox cannot do that; some of these tools ask the user first.

## Credentials: there are none, and you must not ask

The sandbox holds no git credential, and none is needed. Do not ask the user for a token or
password, do not put one in a remote URL, a file or the git config, and do not try to find one.
Git is set up never to prompt and never to use a credential helper; a request that carries its own
credentials is refused.

## Who the commits are from

Commits you make carry the user as author: their name and their Kobe email, or, if the Workspace
chose that, a no-reply address of the form `<short id>+<name>@users.noreply.<this site's address>`. The committer is the user's name followed by "via Kobe". Do not change
`user.name`, `user.email` or the author of a commit. The global git config belongs to Kobe and is
rewritten before every message: do not use `git config --global`. In a normal sandbox it fails with
"could not lock config file", which is expected; where the sandbox runs without separate tool
users (some development setups) the change goes through, and Kobe then stops your session at the
next message because its file was changed. Settings for one repository (`git config <key> <value>`
inside it) work.

On the host, the push itself appears as the Workspace's app or bot account.

## When a push or clone is refused

Errors from Kobe's egress proxy start with `Kobe egress:`. Git shows them as `remote:` lines or in
the `fatal:` message. Do not retry a refusal; tell the user what happened and what fixes it.

| Message contains                                         | Meaning and what to tell the user                                                                                                             |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `is outside the organization this Workspace connected`   | The repository is in another organization. Only the connected organizations (listed in the message) can be used.                              |
| `is read-only: pushing needs Read and write`             | The connection allows fetching only. A Workspace admin can raise it to **Read and write** in the Git section.                                 |
| `Pushing needs the Contributor role`                     | The user is a reader in this Workspace. A Workspace admin can change their role.                                                              |
| `pushing needs the editor or owner role on its project`  | The repository is a Repo, and the user cannot edit its project. Its owner can make them an editor.                                            |
| `is limited to chosen agents`                            | The connection is limited to chosen agents, so git in the sandbox cannot use it. Use the git host tools if listed, or ask a Workspace admin.  |
| `is turned off`                                          | A Workspace admin turned the connection off.                                                                                                  |
| `are limited to … bytes`                                 | The push is larger than the connection's push limit. Push less at a time, or ask a Workspace admin to raise the limit.                        |
| `too many git requests`, `too many git requests running` | Wait a few seconds, then try once more.                                                                                                       |
| `refused the Workspace's git credential`                 | The host rejected the Workspace's credential. A Workspace admin should check the connection.                                                  |
| `answered with a redirect`                               | The repository was renamed or moved. Use its current name.                                                                                    |
| `does not exist in the connected organization`           | Check the name; the Workspace's credential may also not see that repository.                                                                  |
| `is not in this site's egress ceiling`                   | The site does not allow this host yet. The user can ask for access (see [Asking the user for access](asking-for-access.md)).                  |
| `terminal prompts disabled` or `could not read Username` | The host asked for a password: the repository is not in a connected organization (or the organization's spelling differs). Do not supply one. |

The host may also refuse a push itself, for example to a protected default branch. Then push to a
new branch and open a pull request instead.

## Related

- [Working inside a Kobe sandbox](working-in-a-sandbox.md)
- [Asking the user for access](asking-for-access.md)
- [Concepts for agents](concepts.md)
