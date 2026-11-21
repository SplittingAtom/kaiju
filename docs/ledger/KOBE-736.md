# KOBE-736: Postgres connection budget (review STO-5)

- **Status:** in review (group 55)
- **Branch / worktree:** `group-55-listen-connections` in `../Kobe-g55`
- **Depends on:** KOBE-704 (one LISTEN connection per process)

## Decisions

- Pools: `KOBE_DB_POOL_MAX` (1..200, default 10) on server, scheduler, model gateway and egress
  proxy; `KOBE_DB_STREAM_POOL_MAX` (1..100, default 4) on the server. zod-validated per service.
  Chart values `<component>.database.poolMax`, `server.database.streamPoolMax` (schema-checked).
- `application_name` (new `createDb({ applicationName })`): `kobe-server` / `kobe-scheduler`,
  `kobe-server-listen` / `kobe-scheduler-listen`, `kobe-gateway` + `kobe-gateway-listen`,
  `kobe-egress-proxy` + `kobe-egress-proxy-listen`, `kobe-cli`. The stream pool keeps its existing
  `kobe-event-stream` (`event-stream/read.ts` is another lane's file; only its exported default is
  imported).
- Budget check: the chart computes the other components' full pools
  (`KOBE_DB_BUDGET_PEER_CONNECTIONS` = sum of replicas x (pool + 1)) and passes
  `KOBE_DB_BUDGET_SERVER_REPLICAS`; the server adds replicas x (pool + stream pool + 1), compares
  with `SHOW max_connections` - 10 at start and warns (info line otherwise). Estimate only: surge
  pods, migrate Job and backups are documented, not counted. No check without the chart's env.
- `postgres.cnpg.parameters` (string map) rendered into the Cluster's `spec.postgresql.parameters`;
  no `postgresql` section without it. Bundled CNPG documented as a production mode.
- Per-process numbers at chart defaults: server 10 + 4 + 1 = 15 (was up to 20), total 74 (was ~93).
- Docs: `docs/install.md` "Postgres connections" (table, arithmetic, CNPG example,
  `pg_stat_activity` query, the warning) and an upgrade note. No guide change: operators only.

## Evidence

- ac-1: `config.test.ts` (server, egress-proxy, model-gateway), `client.db.test.ts` (pool size and
  name), `pg-listen.db.test.ts` (every app-role session of a server is named).
- ac-2: `charts/kobe/tests/db-connections.test.ts` (env per component, budget inputs, schema
  bounds, CNPG parameters passthrough and string-only values).
- ac-3: `startup/db-budget.test.ts`.
- ac-4: `docs/install.md`.
