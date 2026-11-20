# KOBE-732: Timeouts between server, Postgres and S3 (review STO-2)

- **Status:** in review (group 51, branch `group-51-storage-db`)
- **Branch / worktree:** `group-51-storage-db` in `../Kobe-g51`
- **Depends on:** none

## Plan

Bound every wait that can happen while a transaction holds locks: Postgres session timeouts for
the app role, S3 client timeouts, a total bound on object calls made inside a transaction, and a
check of the Kubernetes client.

## Decisions

- **Timeouts are set per connection, not by `ALTER ROLE` in a migration.** The migration Job runs
  as the database owner, which may not `ALTER ROLE` the app role (needs superuser or
  `CREATEROLE` + `ADMIN`; the runner refuses a superuser owner, and CloudNativePG's `kobe_owner`
  has neither). So `createDb()` (`packages/db/src/client.ts`) runs `SET statement_timeout` and
  `SET idle_in_transaction_session_timeout` in the pool's `onConnect` hook, for every app-role
  service (server, scheduler, gateway, egress proxy, server CLIs). `SET` rather than startup
  parameters: PgBouncer refuses unknown startup parameters. install.md gives external-Postgres
  operators the `ALTER ROLE kobe_app IN DATABASE kobe SET ...` commands for other clients.
- **Values.** `statement_timeout` 2 min: no request legitimately runs that long (thread search,
  vector leg, break-glass reads and workspace sync set shorter ones of their own); the retention
  purge and compaction batches raise it to 10 min (`JOB_STATEMENT_TIMEOUT`) with `SET LOCAL`.
  Backfills are per thread/item. The backup CLI runs as its own BYPASSRLS role (and now turns
  both off for its snapshot session). `idle_in_transaction_session_timeout` 5 min: the longest
  non-DB wait inside a transaction is a bounded object delete (30 s + 10 s grace) or Kubernetes
  calls (10 s each; hibernation is at most 4 x 3 calls). Configurable on server/scheduler with
  `KOBE_DB_STATEMENT_TIMEOUT_MS` / `KOBE_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`.
- **Crash guard.** Postgres ends an idle-in-transaction session with a FATAL while the client is
  checked out; pg-pool has no listener on a checked-out client, so the 'error' event crashed the
  process (reproduced in `client.db.test.ts` without the guard). `createDb()` now adds a
  per-client error listener; the transaction's next query fails and the pool drops the client.
- **S3.** `requestHandler: { connectionTimeout: 5 s, socketTimeout: 60 s }` (server and CLI).
  `socketTimeout` is an idle timeout (no bytes either way), so large streaming uploads and
  downloads are never cut; no `requestTimeout` (in @smithy/node-http-handler it is a total time
  until the response, which would cut a large single PUT). Env overrides
  `KOBE_S3_CONNECT_TIMEOUT_MS` / `KOBE_S3_IDLE_TIMEOUT_MS`.
- **Calls inside a transaction.** `workspace-sync/lost.ts` (orphaned resend discard, under the
  legal-hold lock) now uses `deleteBounded`; memory writes/restores (doc row lock) pass
  `AbortSignal.timeout(30 s)` to `put`/`copy` (new optional `signal` on both). GC, retention,
  uploads expiry and offboarding already used `deleteBounded`.
- **Kubernetes.** `createKubeClient` already bounds every call at 10 s (`withTimeout`); now tested
  against an API server that accepts and never answers. Calls under locks
  (`lifecycle.ts` hibernate, offboarding purge/reinstate `deleteVolume`) are therefore bounded.
- **Chart:** not changed (another lane owns the chart this wave); the env overrides are not chart
  values yet. Follow-up if operators need them.

## Open questions (for Chris or the coordinator)

- ac-2 asks for "by migration"; done per connection instead (see above). A coordinator call on
  whether that is acceptable.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/workspace-sync/s3.test.ts` "S3 client timeouts" (silent TCP server:
  get/delete/put fail with "timed out"); `packages/cli/src/s3.test.ts` same for the CLI lister.
- ac-2: `packages/db/src/client.db.test.ts` (defaults on each connection, statement cut, idle
  transaction ended without crashing, `SET LOCAL` override); full `@kobe/db` and `@kobe/server`
  db suites green with the defaults.
- ac-3: `workspace-gc-legal-hold.db.test.ts` "orphaned resend discard" (hanging store: bounded,
  lock released, claim kept); `sandbox/kube.test.ts` "createKubeClient timeouts".
- ac-4: `docs/install.md` "Timeouts (Postgres and S3)" + upgrade note; `docs/backup-restore.md`
  backup role note; probe suite in the `@kobe/db` db run.
- Guide (`docs/guide/`): no change, nothing a member, admin or agent sees changes.
