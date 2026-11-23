# KOBE-764: GIT-8: Sandbox agent: git configuration, authorship, guide page for agents

- **Status:** in review (not pushed; the coordinator lands it)
- **Branch / worktree:** `group-102-git-8-sandbox-git` in `../Kobe-g102`, stacked on
  `group-99-git-7-egress-git` (KOBE-763)
- **Depends on:** spec `docs/specs/workspace-git.md` G11, G13, GQ10; KOBE-763's proxy contract

## How it works

1. **Wire** (`packages/protocol/src/sandbox-wire/git-config.ts`): capability `git`; optional
   `run.start.git = {author, committer, remotes[{base_url, organization}] ≤ 5}`. No credential, no
   token, no proxy URL. Identities refuse `<>"\` and controls; base URLs are canonical https with no
   port (the proxy carries git only to 443). Unknown keys stripped; older agents never get the field
   (capability-gated), older servers never send it (agent keeps safe defaults).
2. **Server** (`services/server/src/git/sandbox-git.ts`, `delivery/run-start.ts`): for agents with
   `git`, not eval sandboxes, reads the member (name, email), `teams.settings.git_commit_email`
   and the Workspace's connections (credential-free reader). Remotes: access not `off`, not
   limited to chosen agents (transport refuses those, KOBE-763), `reachableBase()` (https/443). A
   failed read sends the start without `git`. Site host from `KOBE_PUBLIC_URL`
   (`SandboxWireOptions.gitSiteHost`; the operator CLI wire has none, so no git context there).
3. **Agent** (`services/sandbox-agent/src/git/git-config.ts`, `threads/spawn.ts`, `thread.ts`):
   each Pi process gets `gitconfig` next to its egress token file (runtime dir, or the executor's
   tool dir; 0600, 0640 under a Pi identity, so tools read it and cannot write it). Env
   `GIT_CONFIG_GLOBAL=<file>`, `GIT_TERMINAL_PROMPT=0`; `GIT_ASKPASS`/`SSH_ASKPASS` dropped (also
   for the executor's env). Written with safe defaults at spawn, rewritten from `run.start.git`
   before each prompt (`attachGit`), verified by the runtime tripwire and listed in its allowed
   entries; removed with the process.
4. **Config content:** `credential.helper =` (resets any system helper), `core.askPass =`,
   `http.proxyAuthMethod = basic` (egress token on the first request, no 407 round trip),
   `user.useConfigOnly = true` (never a guessed address), `user/author/committer` name+email,
   `url."http://<host>[/base]/<org>/".insteadOf` for `https://…/<org>/` (plus `git@host:org/` and
   `ssh://git@host/org/` on hosts without a sub-path). The proxy URL with the token stays in
   `http_proxy`, set per command by the BASH_ENV script (KOBE-39). No `http.extraHeader`. The
   member's repositories' own config is never written; `~/.gitconfig` is never read.
   `safe.directory` for `/workspace` stays the image's system config.

## Decisions

- **Authorship (G13, GQ10):** author = member's name + Kobe email; committer = "<name> via Kobe"
  - same email. Workspace setting `teams.settings.git_commit_email = "noreply"` switches both to
    the owner's form (2026-11-22): `<short id>+<name slug>@users.noreply.<Site host>`. Short id =
    first 10 hex of SHA-256(user id): stable, not reversible, never the internal UUID (collisions
    harmless: never delivered). Slug = display name NFKD, accents dropped, lowercase `[a-z0-9-]`,
    runs collapsed, trimmed, ≤ 39, else `member`; local part ≤ 50. The host follows
    `KOBE_PUBLIC_URL`: if the Site's public address changes, new commits get the new host and
    existing commits keep the old one. An email git would misread also falls back to it. Names are
    cleaned (`<>"\`, controls) and capped so the suffix fits.
- **SSH fails closed:** `core.sshCommand` prints `kobe: SSH is not available in the sandbox; …` and
  fails, so an ssh remote that was not rewritten never tries a connection.
- **One sandbox per member** (KOBE-763: one sandbox serves all of a member's agents), so the
  identity is per member; it is still written per Pi process and per run, so nothing mixes.
- **Image unchanged:** git is already in `images/sandbox/Dockerfile` (with system
  `safe.directory /workspace`), so no licence change in this ticket.
- **Protocol change in this feature branch** (parallel-work says contracts change in their own
  PR): it is a separate commit, additive and capability-gated; the coordinator may split it.

## Left for other tickets

- **Setting route/UI (ac-2):** no route writes `git_commit_email` yet; per the coordinator it
  goes into the phase-2 integration (routes + console, `team.git.manage`, audited). The reader and
  key are `TEAM_GIT_COMMIT_EMAIL_SETTING` / `gitCommitEmailMode()` here.
- GIT-13: Workspace admin and members' pages; e2e from a real sandbox against Forgejo.

## Open questions

- Organization case: `insteadOf` is case-sensitive, the proxy is not; agents are told to use the
  connection's spelling. Add lower-case variants if this trips agents.

## Evidence

- ac-1: `services/sandbox-agent/src/git/git-config.real-git.test.ts` (real git 2.47): a tool's
  `bash -c` with the BASH_ENV egress script and the generated config runs a plain
  `git clone https://github.com/acme/app.git` through a fake proxy: absolute-form
  `http://github.com/acme/app.git/info/refs?...`, egress token on every request, no
  `Authorization`; a 401 host fails with "terminal prompts disabled", planted system and
  `~/.gitconfig` helpers never run, no `~/.git-credentials`, `git credential fill` gets nothing.
  Also: the connected org's `git@` spelling is rewritten, other ssh remotes fail with the SSH
  message and reach nothing; another organization and another letter case are not rewritten
  (a credential-less tunnel); a submodule in the same organization clones through the proxy.
- ac-2: same test pushes a commit with author `Ada Lovelace <ada@…>` and committer
  `Ada Lovelace via Kobe <ada@…>`; `services/server/src/git-sandbox.db.test.ts` (member email, then
  the setting switches to the no-reply form `<short id>+<slug>@users.noreply.<host>`, other Workspace's connections absent, no credential);
  `git/sandbox-git.test.ts`, `delivery/run-start-git.test.ts` (capability, eval, failure).
- Agent wiring: `src/agent.git.test.ts` (env, file mode, rewrite per run, tripwire), `git-config.test.ts`.
- Protocol: `git-config.test.ts` (schema, compatibility both ways).
- ac-3: `docs/guide/for-agents/working-with-git.md` (new), linked from `working-in-a-sandbox.md`;
  appears in llms.txt/llms-full.txt via the guide generator; guide tests and the server's
  `docs_full` cap test pass.
- Checks: typecheck (protocol, server, sandbox-agent, guide); protocol 1351, sandbox-agent 1221,
  server sandbox-wire + git + kobe-mcp docs, server db test; eslint, prettier, license:check, site
  wording, public hygiene.
