# KOBE-828: RN-15: local model ids kaiju-local/ with a data migration

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (no PR yet; branch only)
- **Branch / worktree:** `group-133-rename-15-local-models` in `../Kobe-g133`, stacked on
  `group-132-rename-14-folder` (KOBE-827, PR #729) on KOBE-826 (PR #728)
- **Spec:** `docs/specs/rename-kaiju.md` §11 answer A5 (rename, with a migration); tooling
  `scripts/rename/README.md`

## What changed

- **Where the id lives.** `kobe-local` was never stored as a provider: it is the gateway name
  `gatewayProviderName("local", "openai_compatible")` (chart's in-cluster embedding service, or a
  Site console provider with the reserved id `local`). Catalog entries (`provider_id` + `model`),
  team defaults and enablement (`team_models.alias`), agent pins (`frontmatter.model` = alias),
  threads, learning passes, skill eval runs (`run_model.used` = alias) and budgets (no model
  column; per-model limits are catalog `max_output_tokens`) hold aliases or provider ids, so they
  follow by themselves. Checked by scanning every text/jsonb/array column of a populated migrated
  database (test below).
- **Naming.** `@kaiju/protocol` `local-models.ts`: `LOCAL_GATEWAY_PROVIDER` (`kaiju-local`),
  `PRE_RENAME_LOCAL_GATEWAY_PROVIDER`, `currentModelId`, `preRenameModelId`, `modelIdsOf`.
  `@kaiju/db` `models/gateway-names.ts`: `gatewayProviderName` (moved from store.ts; `local` →
  `kaiju-local`, every other OpenAI-compatible provider keeps `kobe-<id>`, permanent per the
  Bifrost-names group), its SQL form `GATEWAY_MODEL_SQL` (was duplicated in usage.ts and
  budgets.ts) and `currentModelSql(column)`.
- **Migration `0261_kaiju_local_models`** (hand-written, one transaction, FORCE lifted on
  `semantic_memory_item_versions` and `orbit_evals` only, no team set, nothing deleted):
  site `memory.settings` `embedding_model`; `embedding_model` of the three memory version tables
  where pgvector added the columns (id only, vectors kept; the immutability trigger allows
  embedding-column updates, legal holds are not touched); Orbit evals `pending`/`running`
  (`model`, `definition.frontmatter.model`). Kept (history): `run_usage`, finished Orbit evals,
  audit rows, run events, thread entries. `team-setters.test.ts` and `run_usage` append-only
  unchanged.
- **Read-time mapping (permanent, ac-2).** Usage reports (`usage-store.ts`: team and site
  `by_model`, a run's `models`, the thread's latest call) group by `currentModelSql("u.model")`;
  the eval estimate's run history matches either id; usage pricing (`recordModelUsage`) maps the
  recorded id before joining the catalog. Budget enforcement sums `model_spend_daily` (per team /
  member, no model), so both ids always count; gateway reservations price via
  `loadGatewayPrices` keyed by the current id and the gateway maps the call's model first.
- **Embeddings, no re-embed.** Pending/coverage/vector search match
  `embedding_model = ANY(storedVectorModels(model))` (current id and its pre-rename form, `#d<n>`
  kept), so vectors under the old id are current. The Site setting reads and writes through
  `currentModelId`, so an old id (old pod or console) is the same model and saving it is no
  change (no build started). The "model changed → re-embed" path is the setting's `changed` list
  and `pendingVersions`; both are covered.
- **Gateway / mixed rollout (one release).** Model gateway (`prepare-body.ts`): a pre-rename id is
  checked (enablement, reasoning, output caps, thinking), priced and recorded as the current one;
  the body goes to Bifrost as sent. Server sync (`pre-rename-local.ts`, used by
  `buildDesiredState`): pushes `kobe-local` as a second Bifrost provider with the same endpoint
  (a keyed one gets key name `<name>-pre-rename`, unique across providers) and every virtual key
  that allows a `kaiju-local` model allows the same model under the old name. Old pods' sync
  would remove `kaiju-local` until a new pod resyncs (minutes of the roll; their embedding calls
  keep working). An old gateway pod refuses a chat model of provider `local` named by its new id
  during the roll (embeddings are exempt: memory_embed skips the enablement check): accepted.
- **Rename tooling.** Narrowed (`chore: KOBE-828 narrow RN-15`): step pattern = the old group; a
  permanent group keeps the constant, the comments that explain the old form
  (`kobe-local/<model>`), the alias, the KOBE-828 tests and the docs' "was `kobe-local`". Applied
  (`rename.mjs --apply --step RN-15`): 70 occurrences in 29 files (tests, chart comments and
  NOTES, server comments, guide, install). RN-15 group removed; guard ok.

## One-release aliases (add to KOBE-754's removal list)

- `services/server/src/models/pre-rename-local.ts` (`withPreRenameLocal`,
  `withPreRenameLocalKey`) and its call in `desired.ts`; its test `pre-rename-local.test.ts` and
  the `[old]` key in `local-embedding.test.ts`; the install note's "for this release only".
- Not one-release (permanent): `currentModelId` in the model gateway (cheap, keeps queued Orbit
  evals and stragglers priced), `currentModelSql` in usage reports and pricing,
  `storedVectorModels` (old-id vectors written during the roll persist), the settings mapping,
  the migration.

## Open

- The in-sandbox Pi session records the model id per branch; a chat model of a Site provider
  `local` resumed across the upgrade records a model switch to the new id (harmless; the in-cluster
  service is embeddings only in standard installs).

## Docs evaluation

Admins see the model id in the embedding setting, Usage and spend and run details, so the guide
changes (ac-3): `whats-new.md` (rename paragraph), `memory.md` (Choosing the model),
`models.md` (how the gateway names models); operator docs `install.md` (in-cluster section
renamed by the step, upgrade note for 0261). Chart NOTES/values comments renamed. In-sandbox
agents never see the embedding model id (no "For agents" change). `/llms.txt` and
`/docs/<slug>.md` are generated from these pages.

## Evidence (TMPDIR=~/tmp)

- `pnpm build`, `typecheck`, `lint`, `format:check`, `db:check` (no schema changes): pass.
- Unit: protocol 1403, db 1113, model-gateway 270, server 4617 (8 skipped), web 4351, cli 101,
  guide 33.
- New tests: db `kaiju-local-models-upgrade.db.test.ts` (9: populated DB at 0260, every rewritten
  table, history kept, agents keep their model, prices and spend over both ids, FORCE back, full
  column scan), server `models/local-rename.db.test.ts` (5: usage reports group both ids, no
  re-embed, settings mapping), cli `kaiju-local-models-backup.db.test.ts` (2: pre-rename backup
  restore then upgrade; refused on new schema), protocol `local-models.test.ts` (3), server
  `pre-rename-local.test.ts` (3), model-gateway `server-call.test.ts` (+3, old ids during the roll).
- Whole DB suites (pgvector dev server, pg_dump 17): db 2202, server 3765, cli 53 passed.
- `check-public-hygiene.sh`, `check-site-wording.mjs`, `rename/guard.mjs`, rename self-test (24): ok.

## Review (2026-11-25, review-g133)

- F1 (fixed by the coordinator): a test value `kobe-lan/m` was not covered by the allowlist and failed the guard; now `kobe-vllm/m`, already covered.
- F2 (accepted): a Site provider `local` with an API key fails its first Bifrost sync after the upgrade (key name collision); it fails closed and recovers on the next sync.
- F3 (accepted): an admin saving memory settings through an old server pod during the rolling update can trigger a re-embed of every vector; the window is the few minutes of the roll. Operators are told in docs/install.md to avoid Site setting changes during an upgrade.
