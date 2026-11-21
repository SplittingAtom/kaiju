# KOBE-704: One Postgres LISTEN client with reconnect/backoff/half-open handling

- **Status:** in review (group 55)
- **Branch / worktree:** `group-55-listen-connections` in `../Kobe-g55`
- **Depends on:** KOBE-732 (session hook, group 51)

## Plan

`services/server/src/pg-listen.ts` `createListenClient()`: one connection per server process for
every channel, many subscribers per channel, reconnect with half-jitter backoff, ping (half-open
detection, socket destroyed), delivery probe on its own channel `kobe_listen_probe`, per-subscriber
`polling()` / `listening(session)` callbacks, LISTEN on a channel's first subscriber and UNLISTEN on
its last, `close()`. `createServerDeps` builds it (`deps.listen`, application_name
`kobe-server-listen`) and closes it last. Commit 1: hub + bus; commit 2: the other four.

## Decisions

- Per-process count: a server pod went from up to **6** LISTEN connections (hub, bus, budgets,
  skill evals, egress relay, gateway sync) to **1**. The scheduler (same image) only ever started the
  bus (its hub has no streams, budgets/relay/sync/skill evals are server jobs): 1 before, 1 after.
- Hub and bus still accept a `connectionString` instead of `listen` and then own a connection
  (tests, the operator CLI's router-only replica `cli/replica.ts`).
- Dispatch is synchronous in delivery (commit) order, so per-channel order holds; each subscriber
  call is guarded (a throwing one is logged, the rest still run; nothing awaits a subscriber).
  The hub had no guard before (a throw escaped into pg's emitter); the bus had one.
- Queries on the connection are serialised (ping, late LISTEN, session queries): pg 8 warns on
  concurrent `query()` and pg 9 drops it.
- `SET idle_session_timeout = 0` on connect (a role default must not end an idle listener; tolerated
  on servers without the setting). The KOBE-732 session hook only applies to pools, not here.
- The hub's probe moved from `kobe_run_events` (`probe:` payloads) to `kobe_listen_probe`; the hub
  still ignores `probe:` payloads from not-yet-upgraded replicas during a rollout.
- The other four, per listener (kept = deliberate, removed = accidental):
  - **Budgets** (`kobe_models`, `spend:` hints): kept no resync on reconnect, the 30 s sweep over
    every team is the safety net. Removed: fixed 2 s retry without jitter, no ping, no
    application_name, warn only on connect failure.
  - **Skill eval progress** (`kobe_skill_eval`): kept no resync, each stream re-reads every 5 s.
    Removed: fixed 2 s retry, no ping; the constructor now takes the shared client.
  - **Egress relay** (`kobe_egress_blocked`): kept the sweep on every (re)connect (`listening`)
    and the 30 s sweep. Removed: fixed 5 s retry without jitter, no connect timeout, no ping.
  - **Gateway sync** (`kobe_models`, shares the channel with budgets): kept the leader lock as a
    session advisory lock on the LISTEN connection (`ListenSession.query`), leadership dropped on
    `polling`, re-tried on `listening`, `leaderRetryMs` loop. New: `close()` unlocks explicitly
    since the shared connection outlives it; a half-open leader connection is now noticed by the
    ping (before, a replica could keep "leading" on a dead socket until TCP gave up).
  - Same backoff (250 ms doubling to 10 s, half jitter), ping 30 s / 10 s, connect timeout 10 s,
    keepAlive and the delivery probe for all six now.
- Each component still accepts a `connectionString` and then owns a connection (tests, CLI),
  named `kobe-budgets`, `kobe-egress-relay`, `kobe-model-sync`, `kobe-event-hub`, `kobe-sandbox-bus`.
- `ServerJobsOptions.databaseUrl` removed (no job opens its own LISTEN connection any more).
- Payloads: all ids (largest the bus `sync:<uuid>:<uuid>`, 78 bytes), far below the 8000-byte limit.

## Evidence (acceptance criteria → test or command output)

- ac-1: `pg-listen.test.ts` (fake client): growing retry delay, error → polling → listening,
  half-open ping, probe without echo, close() during connect, subscriber isolation, UNLISTEN on last.
- ac-2: all six on `deps.listen`; no `as unknown as { connection... }` cast left (the typed
  `client.connection.stream.destroy()` is used in `pgListenConnection`).
- `pg-listen.db.test.ts`: hub, bus, budgets, skill evals and egress relay on one session
  (`pg_stat_activity` shows one `kobe-server-listen`, no other dedicated listener).
- budgets, egress, models, models-discovery, startup-seeds, skill-eval-runner db tests green.
- ac-3: `event-stream*.test.ts`, `event-stream.db`, `event-stream-scale.db`, `sandbox-wire.db` green.
- Docs: no member/admin-visible change (connection plumbing); operator docs come with KOBE-736.

## Review follow-ups (2026-11-21)

- MEDIUM: a half-open leader connection left the old backend holding the gateway sync's lock
  (~2 h of TCP keepalive). Now (a) the LISTEN session sets server-side keepalives 30/10/3 (a pooler
  may refuse them: warned, not fatal; documented in install.md), and (b) `models/leader-lock.ts`
  records `pg_backend_pid()`, `backend_start` and `application_name` when it takes the lock and,
  after losing its own connection, ends that backend once if all three still match, then retries.
  The app role may end its own role's backends (PostgreSQL allows it for members of the target's
  role, no superuser needed); `leader-lock.db.test.ts` proves it as the non-superuser test app
  role. Refused (42501): logged, keepalives remain.
- LOW: a subscriber joining a channel whose LISTEN is in flight is told on completion (`pending`).
- LOW: `close()` destroys the socket when `end()` does not return within 2 s.
