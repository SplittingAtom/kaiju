# KOBE-769: GIT-13: Guide, install notes, release note; gate run

- **Status:** documentation half done on `group-110-git-13-docs`; the gate run (ac-1) waits for
  test hosts and is not claimed. See [git-gate.md](git-gate.md).
- **Depends on:** KOBE-757..768.

## What changed

- Guide audit against the code on this branch: the git pages already matched the code on every
  known fact (working copy at `/workspace/.kobe/repos/<slug>`, never synced; `commit_repo` always
  asks; direct commits off by default; mirror 500 files, 50 MiB each, 256 MiB; Gitea 1.26.0 and
  Forgejo 15.0.0; Site switch and host list; Repo reads by project read rule). Fixed: the no-reply
  form named `<name>`, the code uses the name slug (two pages). Added: What's new (v1.4), glossary
  (Repo, Git connection), approvals (`commit_repo`), retention and deletion (repositories are
  outside Kobe's retention).
- Install notes: a per-host-kind table at the top of "Git for connected organizations", pointer
  from Upgrade notes.
- Spec: G7 lists `write:issue`; GQ7 records the built minimums.
- Release note: [docs/releases/v1.4.md](../releases/v1.4.md).
- Gate document: [git-gate.md](git-gate.md).

## Docs evaluation

This ticket is the docs change. No product behaviour changed.
