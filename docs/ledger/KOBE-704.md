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
- Payloads: all ids (largest the bus `sync:<uuid>:<uuid>`, 78 bytes), far below the 8000-byte limit.

## Evidence (acceptance criteria → test or command output)

- ac-1: `pg-listen.test.ts` (fake client): growing retry delay, error → polling → listening,
  half-open ping, probe without echo, close() during connect, subscriber isolation, UNLISTEN on last.
- ac-3: `event-stream*.test.ts`, `event-stream.db`, `event-stream-scale.db`, `sandbox-wire.db` green.
- Docs: no member/admin-visible change (connection plumbing); operator docs come with KOBE-736.
