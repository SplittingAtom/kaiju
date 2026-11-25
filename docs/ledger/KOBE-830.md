# KOBE-830: RN-17: sandbox Unix users and home renamed, same numeric ids, `/home/kobe` link

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (no PR yet; branch only)
- **Branch / worktree:** `group-135-rename-17-users` in `../Kobe-g135`, stacked on
  `group-134-rename-16-apps` (KOBE-829, PR #731) on KOBE-828 (#730) and KOBE-827 (#729)
- **Spec:** `docs/specs/rename-kaiju.md` §11 answer A7 (rename, same numeric ids, `/home/kobe`
  symlink); tooling `scripts/rename/README.md`

## Users and ids (ac-1)

| Before                        | After                           | uid       | gid                    |
| ----------------------------- | ------------------------------- | --------- | ---------------------- |
| `kobe` (agent)                | `kaiju`                         | 1000      | 1000 (workspace group) |
| group `kobe-agent`            | group `kaiju-agent`             | —         | 1001                   |
| `kobe-pi-0`..`kobe-pi-63`     | `kaiju-pi-0`..`kaiju-pi-63`     | 2000-2063 | = uid                  |
| `kobe-tool-0`..`kobe-tool-63` | `kaiju-tool-0`..`kaiju-tool-63` | 3000-3063 | = uid                  |
| home `/home/kobe`             | `/home/kaiju` (+ link)          |           |                        |

Also renamed: the uid-1000 user and group `kobe` of the orbit-eval and skill-scan images (home
`/tmp/home`, nothing persisted, same ids). Nothing resolves these users by name: `kaiju-runas`
takes uids and compile-time numeric macros (`KAIJU_AGENT_UID`, `KAIJU_WORKSPACE_GID`, the slot and
partner ranges), the agent passes uids, the pod spec is numeric (`runAsUser`, `fsGroup`,
`supplementalGroups` from `SANDBOX_UID`/`SANDBOX_AGENT_GID`/`PI_IDENTITY_BASE`/
`PARTNER_IDENTITY_BASE`), the Dockerfile's `chown`s of `kaiju-runas` and `/run/kaiju-agent` are
numeric, there is no sudoers or setpriv by name in the image, and `e2e/gate2/scan.sh` names no
user. The only by-name readers were checks: `test-image.sh` (`id kobe-pi-$n`, `root:kobe-agent`)
and `e2e/run/42-model-gateway-run.sh` (`stat %U:%G` = `kobe:kobe-pi-N`), both renamed. Volumes own
files by number, so nothing is chowned; `test-image.sh` asserts every id above and that no
`kobe*` user or group is left.

## Where the home folder lives (ac-2)

`$HOME` is the pod's `home` **emptyDir** (`manifests.ts`, `sandbox.homeSize`), wiped on every
hibernate (D12/D13); it is not on the workspace volume. So no pre-rename `/home/kobe` content
survives into a new pod: the stored absolute paths that matter are those in `/workspace` (tool
configs, scripts, a venv's files written by a member who used `$HOME` paths, shell history files
kept there) and in Pi sessions and thread entries rebuilt from Postgres. The server now writes
`HOME=/home/kaiju` and mounts `home` at `/home/kaiju`; the image has `/home/kobe -> /home/kaiju`,
so every such path resolves to the live home. A venv in `/workspace/.venv` (what the guide
recommends) names only `/workspace` and `/usr/local`, so it is unaffected either way.

**Mixed rollout:** as in KOBE-750, the SandboxTemplate carries the image with `HOME` and the mount
path, so the new paths reach only pods on the new image; old pods keep the old image and paths
until they stop, and a woken sandbox gets the current pod spec. Pi's private home (KOBE-196) is
under `/tmp` and per identity, untouched. Server unit test asserts the mount and `HOME`.

## The link and isolation (ac-3)

- Made in the image's user `RUN` (`ln -s /home/kaiju /home/kobe`, `chown -h 0:0`, `/home` 0755
  root): root-owned, in a root-owned directory, on `readOnlyRootFilesystem`. Replacing or removing
  it needs write on `/home`, which no sandbox uid has, read-only root or not.
- It leads only to `/home/kaiju`, the home the agent and its tools already share (the executor's
  tools get the agent's `HOME` as `KAIJU_TOOL_HOME`); it adds no reach. Pi homes are private dirs
  under `/tmp` (agent-owned, the Pi's group, 2770), not under `/home`.
- `test-image.sh` new checks: ids and names (above); the link is `root:root`, points at
  `/home/kaiju`, `/home` is `root:root 755`, it resolves; on a **writable** root filesystem the
  agent (1000), a Pi identity (2000) and a partner (3000) each try `ln -sfn`, `rm`, `mv` on the
  link and `mkdir` in `/home`, and the link and `/home` are unchanged; a venv made at
  `/home/kobe/venv` (shebang and pyvenv.cfg naming `/home/kobe`, exactly what one made before the
  rename has) runs `pip` by either path and reports prefix `/home/kobe/venv`.
- The real-helper suites (`*.real.test.ts`: identities, partner, exec, KOBE-196 load paths,
  read-only projects) use uids and temp dirs, never the user names or `/home/kobe`; nothing in
  them needed changing. Unit tests with `/home/kobe` as a sample `HOME` now use `/home/kaiju`.

## Rename tooling

`scripts/rename/steps/RN-17.txt` = the RN-17 group (no narrowing needed: every occurrence was a
user name or the home path); applied: 73 occurrences in 19 files. Then hand work: the link, the
new checks, the guide lines. The RN-17 group is gone; one narrow permanent group keeps `/home/kobe`
(Dockerfile, `test-image.sh`, the manifest test's comment, two guide lines) and the old user
names in the Dockerfile comment and the image checks that assert they are gone.

## Checks (2026-11-25)

- `pnpm build`, `typecheck`, `lint`, `format:check`: green.
- Unit suites: sandbox-agent 1310 passed (200 skipped: real-helper and DB cases), server 4617
  passed (8 skipped).
- Site wording, public hygiene, rename guard, rename self-test (24/24): green.
- **Image:** built once on the remote amd64 Docker host, `test-image.sh` 85/85 ok including the
  four new KOBE-830 checks, then the image was removed. By hand on the same image: a partner uid's
  `ln -sfn`/`rm` on the link fail with `Permission denied` (not only EROFS); control: root on a
  writable root can repoint it, so the check can fail; a pod spec from a pre-rename server
  (mount at `/home/kobe`, `HOME=/home/kobe`) on the new image mounts onto `/home/kaiju` under runc
  (that pairing does not happen in practice, see Mixed rollout; not tried under gVisor).
- **Real-helper suites** (`scripts/test-identities.sh`): sudo, gcc and setcap exist on the dev VM,
  but every suite stops at the helper's start probe ("a process can ptrace or read the memory of
  its parent", exit 71): this host has `kernel.yama.ptrace_scope=0`, which the probe rightly
  refuses. Not changed (host setting). They name no user or home path, so the rename does not touch
  them; CI (`ci.yml`, "Sandbox privilege separation") runs them on hosted runners.
- e2e (`20-checks.sh`, `42-model-gateway-run.sh` privsep `stat` line) runs in CI with the image
  built from the same commit.

## Docs evaluation

Changed: the in-sandbox home folder members and agents see. `docs/guide/for-agents/working-in-a-sandbox.md`
names `/home/kaiju` and says `/home/kobe` leads to the same folder (agents see the old path in
earlier messages of a conversation); `docs/guide/files/storage-limits.md` names `/home/kaiju`;
`docs/guide/whats-new.md` gets a paragraph in "Kobe is now Kaiju" (new home and user names, same
ids, old path still works). No system prompt text names the home folder or the users (checked
`services/server/src/**/prompt*` and the run prompt builders). `docs/design/paired-tool-uid.md`
renamed by the step. No admin-facing setting changed (`sandbox.homeSize` keeps its name).
