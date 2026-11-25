# Development

There is no `docker compose`: development runs on k3s, locally via k3d, with Tilt.

## Names in the product and the API

Workspace is the place a team works in and the tenant boundary (one `teams` row, one Kubernetes
namespace, one RLS context); Team is the people in it and their roles; Scratchspace is one member's
own volume (`/workspace`); Project is a shared unit of work with versioned files. The API keeps the
old names: Workspace = the team row, so the routes stay `/v1/team`, `/v1/me/teams` and the
`x-kaiju-team` header, and permission names stay `team.*` (Workspaces spec WS1-WS3,
`docs/specs/workspaces.md`). The team role `builder` is now `contributor` in the API and the UI.

## OpenAPI document

The OpenAPI document (`services/server/src/openapi/document.ts`) lists
every route of the member and admin API on the user-facing listener. Some areas are fully
described by hand in `openapi/<area>.ts`; the rest are one line each in `openapi/catalog/`. A
catalog area marked `detailed: true` gives every line a `CatalogDetail` in
`openapi/catalog/details/<area>.ts` (KOBE-771): the request body, query, success status and body,
and extra error statuses. Bodies and answers are referenced from the zod schemas the route
validates with or the `@kaiju/protocol` contract (`named("Name", schema)`; export the route's
schema if it is a local const); only an answer the route builds without any schema is written
out as the fields the handler sends (`untyped(...)`, marked `x-kaiju-untyped`). Errors use the
shared `components.responses` (400, 401 and 403 by default; add 404, 409, 413, 429 and so on as
the route answers them). Lines of areas not detailed yet are marked `x-kaiju-detail: summary`
(summary, tag and path parameters, no bodies). Left out on purpose, each with a reason in
`openapi/undocumented-allowlist.ts`: health probes, Better Auth's handler and the SCIM routes
(listed one by one), the OAuth redirect and client-metadata endpoints, the web app's telemetry
beacon, a catch-all refusal, and the sandbox-facing and internal listeners.
`openapi/coverage.test.ts` reads the routes of the real mounted apps and fails on a route that is
neither documented nor allowlisted, and on a stale entry in either list; `catalog/detail.test.ts`
fails on an operation of a detailed area without its schemas, a dangling `$ref` or an undeclared
path parameter. After adding a route, add its line to the catalog (with its detail in a detailed
area) and update the route-inventory snapshot
(`pnpm --filter @kaiju/server exec vitest run src/routes/route-inventory.test.ts -u`), which is how route
changes show in review. The OpenAPI JSON is not committed (KOBE-815): `pnpm --filter @kaiju/server
build && pnpm --filter @kaiju/server openapi` writes it to `services/server/openapi.json`
(gitignored), and CI keeps every push's copy as the `openapi` artifact of the `unit` job.
`pnpm --filter @kaiju/server openapi:diff [base-ref]` prints how the document changes against a
base (default `origin/main`), building both sides.

## Dev loop

Prerequisites: Docker (local, or remote via `DOCKER_HOST=ssh://user@host`), k3d, kubectl, Helm 3,
Tilt, Node 24 and pnpm 12.

```bash
scripts/dev-cluster.sh   # k3d cluster "kaiju": gVisor, agent-sandbox, local registry on :5005
tilt up                  # builds web/server/mcp-proxy/egress-proxy, deploys the chart + a dev Postgres
```

Tilt rebuilds an image when its sources change and redeploys it; the web app is port-forwarded to
http://localhost:3000. `tilt ci` does the same non-interactively and exits once every workload is
healthy (or fails). `tilt down` removes the deployment; `k3d cluster delete kaiju` removes the
cluster. A dev cluster created before the rename is called `kobe`: keep using it with
`KAIJU_CLUSTER=kobe scripts/dev-cluster.sh`, or delete it and create the new one (the dev release
moved from namespace `kobe-dev` to `kaiju-dev`, so `tilt up` deploys it afresh). The old
cluster still has the old release's team namespaces (`kobe-team-*`), and the new server refuses to
start next to them (KOBE-751, one team namespace prefix per install): delete them first
(`kubectl delete namespace -l kobe.splittingatom.io/team-namespace=true`, which drops their
sandboxes and workspace volumes).

The dev deployment uses `dev/values.yaml` and `dev/postgres.yaml`: a throwaway Postgres with the
production role split (`kobe_owner` migrates, `kobe_app` is the app login) and placeholder S3
settings.

### Against a real k3s cluster

Tilt refuses any context other than `k3d-*` unless it is named explicitly, and the throwaway dev
Postgres (public credentials) is only deployed to k3d. Bring your own values for a real cluster:

```bash
KAIJU_DEV_CONTEXT=<kube-context> KAIJU_DEV_REGISTRY=<registry the cluster can pull from> \
  KAIJU_DEV_VALUES=<values.yaml> tilt up
```

The dev release lives in namespace `kaiju-dev` (or `kaiju-dev-<suffix>` via `KAIJU_DEV_NAMESPACE`, with `KAIJU_DEV_WEB_PORT` for the port-forward; see [parallel-work.md](parallel-work.md)), never `kaiju`.

The cluster must already meet the prerequisites in [install.md](install.md#isolation).

### Linux Docker hosts

k3s nodes use many inotify instances. If `scripts/dev-cluster.sh` warns about
`fs.inotify.max_user_instances`, raise it on the Docker host:
`sudo sysctl -w fs.inotify.max_user_instances=512`.

### Building images by hand

Build every image from the repository root (`scripts/check-images.sh` builds them all and checks
each runs as non-root). The web image and the Node services take the build they report as build
args (KOBE-837): the guide shows it beside its title, and without them it reads "Development build".

```bash
docker build -f apps/web/Dockerfile \
  --build-arg KAIJU_BUILD_SHA="$(git rev-parse HEAD)" \
  --build-arg KAIJU_BUILD_DATE="$(git log -1 --format=%cI)" \
  -t kaiju-web:local .
docker build -f services/Dockerfile --build-arg SERVICE=server \
  --build-arg KAIJU_BUILD_SHA="$(git rev-parse HEAD)" \
  --build-arg KAIJU_BUILD_DATE="$(git log -1 --format=%cI)" \
  -t kaiju-server:local .
```

`KAIJU_BUILD_SHA` is the commit (hex, shown as its first 12 characters), `KAIJU_BUILD_DATE` an
ISO 8601 time with an offset (shown in UTC), and the optional `KAIJU_BUILD_VERSION` a release
version such as `1.4.0`. They become runtime environment variables in the image, read by the
server per request, so they never change the build's cached layers above them. The publish
workflow passes the commit and its commit time.

## Tests

```bash
pnpm test                                   # unit + chart render tests (needs helm on PATH)
KAIJU_TEST_DATABASE_URL=postgres://... pnpm test:db   # migrations, RLS catalog, cross-team probe,
                                            # backup/restore round trip (needs pg_dump/psql 17.6+ on
                                            # PATH, e.g. brew install libpq; turbo strips
                                            # other env vars, so use PATH, not KAIJU_PG_BIN_DIR)
images/sandbox/test-image.sh <image>        # sandbox image acceptance checks
KAIJU_IMAGE_TAG=<tag> e2e/run.sh             # k3d end-to-end suite (cluster from dev-cluster.sh)
```

CI splits the k3d suite into shards that run in parallel, each on its own cluster:
`KAIJU_E2E_SHARD=suite` (every section but the KOBE-25 cold-start trials), `cold-start` (the
sections up to KOBE-25, with its trials), `gate1-prep` followed by `e2e/gate1.sh` (the install
plus the KOBE-40 model setup Gate 1 needs) and `gate1-prep` followed by `e2e/gate2.sh` (the same
install, for the Gate 2 safety checks; see [gates/gate-2.md](gates/gate-2.md)). Unset, `e2e/run.sh` runs every section, as before. A
new section needs no shard change: it runs in `suite`. `e2e/run.sh` is the entry point (settings, shard
dispatch); the helpers are in `e2e/lib/run-common.sh` and the sections in `e2e/run/NN-*.sh`, sourced in
numeric order (a new section is a new file plus a `source` line in `run.sh`). The required `k3d` check passes only when
every image build and every shard passed.

**The embeddings model in CI (KOBE-839).** The chart's embeddings init container downloads its
GGUF from a public URL, which on a fresh cluster per shard was slow enough to exhaust `helm --wait`.
The `model` job of `e2e.yml` keeps the file in the GitHub Actions cache, keyed by the sha256 pinned
in `charts/kaiju/values.yaml` (`embeddings.local.model.sha256`), downloading it with retries and a
sha256 check only on a miss. Each shard restores it and serves it from the runner
(`scripts/ci-embeddings-model.sh serve`, port 18089 (18080 is the gate scripts' ingress port-forward), exported as `KAIJU_E2E_MODEL_PORT`); the
installs in `e2e/run/10-deploy.sh` and `e2e/gate4-restore.sh` then set
`embeddings.local.model.url` to the k3d network's gateway and allow that address in
`embeddings.local.networkPolicy.extraEgress` (`e2e/lib/embeddings-model.sh`). The init container
still checks the sha256, and later upgrades keep the URL (`--reuse-values` or the saved values).
Locally, without `KAIJU_E2E_MODEL_PORT`, the cluster downloads from the public URL as before. A new
model pin needs nothing here: its sha256 is a new cache key.

## Migrations

Schema changes go through drizzle (`pnpm --filter @kaiju/db db:generate`; never edit snapshots by
hand); the rules for parallel branches, `db:rebase` and `-- kobe:hand-written` files are in
[parallel-work.md](parallel-work.md#migrations). The runner (`packages/db/src/migration-runner.ts`,
KOBE-734) commits each migration in its own transaction together with its
`drizzle.__drizzle_migrations` row (drizzle's hash and the journal's `when`, so drizzle-kit and
existing installs agree), all under the migration advisory lock, then re-derives the app role's
grants once.

**Building or dropping an index on a large table: a no-transaction migration.** Plain
`CREATE INDEX` blocks writes to the table while it scans, and the previous release is serving
during the upgrade. Write such a migration with the marker in its leading comment lines and only
concurrent, idempotent index statements, one per `--> statement-breakpoint`:

```sql
-- kobe:hand-written
-- kobe:no-transaction
-- Why the index is needed (the query it serves).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "files_run_idx" ON "files" USING btree ("team_id", "run_id");--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "thread_app_results_thread_idx";
```

- The runner refuses anything else in such a file (no `ALTER TABLE`, no data changes, no
  statement without `IF [NOT] EXISTS`, no two statements in one chunk): a failure part-way leaves
  earlier statements applied, so a rerun must be harmless. Put other changes in their own
  (transactional) migration.
- Before each `CREATE INDEX CONCURRENTLY IF NOT EXISTS <name>` the runner drops `<name>` if an
  interrupted earlier build left it INVALID, so the rerun builds it again.
- Each statement waits up to 2 min (`lock_timeout`) for transactions older than it, instead of
  the runner's usual 10 s; they block no traffic meanwhile. All of an upgrade's migrations must
  fit the Job's deadline (`postgres.migrateJob.activeDeadlineSeconds`, default 30 min); on
  SIGTERM the runner cancels its statement in Postgres and exits non-zero.
- When the index is declared in the drizzle schema (it should be, so `db:check` stays clean),
  generate the migration as usual, then rewrite its SQL into this form and make the first line
  `-- kobe:hand-written` so `db:rebase` keeps the SQL and its snapshot. An SQL-only index (kept out of
  the drizzle schema on purpose) can be a `--custom` migration instead.

## CI

| Workflow         | When                                | What                                                                                                                                                          |
| ---------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci`             | every push, merge queue             | format, build, typecheck, lint, unit + chart tests, license check, DB/RLS suite, image non-root check                                                         |
| `sandbox-image`  | sandbox inputs change, nightly      | build, acceptance checks, license audit, Trivy (fails on fixable CRITICAL)                                                                                    |
| `e2e`            | PRs to `main`, merge queue, nightly | images built once, then parallel k3d + gVisor shards: `e2e/run.sh`, cold-start trials, `e2e/gate1.sh`, `e2e/gate2.sh`                                         |
| `publish`        | push to `main`                      | images (Trivy-scanned before push, fails on fixable CRITICAL, and HIGH for the Node services and web; `sha-<short>`; `main` moved last) and the chart to ghcr |
| `security-audit` | weekly, manual                      | `pnpm audit --prod` and the images' pinned Python/npm packages against OSV (`scripts/osv-audit.mjs`); fails on HIGH or CRITICAL                               |

`ci` runs `static` (hygiene, format, build, typecheck, lint, license check) and `unit` (unit and
chart tests, sandbox privilege separation) side by side; the required `checks` job passes when
both did, as `db` does for `db-core` and the `db-server` shards. Jobs set up the toolchain with
the composite actions in `.github/actions/` (`setup-kaiju`: pnpm, Node from `.nvmrc`, install and
Turbo's cache; `pg17-client`). `static` saves Turbo's local cache (`.turbo/cache`, build output
only) on every push to `main`, and every `ci` job restores it, so packages unchanged since `main`
replay their build instead of rebuilding; pull requests and merge-queue runs only read it.

Image vulnerability gate: `sandbox-image`, `orbit-eval-image`, `skill-scan-image` and every image
in `publish` run Trivy (`aquasecurity/trivy-action`, pinned by digest) twice: a report of HIGH and
CRITICAL findings that have a fix, then a gate that fails the job on any fixable CRITICAL; for the
Node service images (server, mcp-proxy, egress-proxy, model-gateway) and web in `publish` the gate
also fails on a fixable HIGH (Chris, 2026-11-20). Sandbox, orbit-eval and skill-scan stay
CRITICAL-only, with HIGH in the report. Unfixed
CVEs are ignored. `publish` builds each image into the runner's daemon and scans it before pushing,
so a failing image never reaches ghcr. Charts publish as `<version>-main.<run>.<attempt>`. There
are no waivers; if one is ever needed, add a root `.trivyignore` with one comment per CVE (id,
image, reason, expiry) and pass it as `trivyignores`.

CI runs on GitHub-hosted runners (free for public repositories). Deploy `sha-*` image tags or
published chart versions, never `:main` (pods with `IfNotPresent` would keep a stale `:main`).

### Merging

`main` uses GitHub's merge queue: approve-and-queue a green PR with `gh pr merge <n> --merge` (or
the "Merge when ready" button). The queue tests the PR on top of everything queued ahead of it
(`merge_group` runs of `ci` and `e2e`) and merges in order, so a merge no longer forces every other
open PR to re-run. Required checks: `checks`, `db`, `images`, `k3d`.

### Self-hosted runners (fallback)

Self-hosted runners on a k3s cluster (Actions Runner Controller) are documented in
[`ci/runners/README.md`](../ci/runners/README.md). They are idle by default; set the repository
variable `KAIJU_RUNNER=kobe-k3s` to route jobs to them.
