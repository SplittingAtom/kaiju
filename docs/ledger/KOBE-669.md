# KOBE-669: Saving the embedding model without an active Workspace must still start Build vectors

<!-- Keep under ~100 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** committed locally on `kobe-669-sm` (no push/PR, coordinator reviews)
- **Branch / worktree:** `kobe-669-sm` in `../Kobe-wt669`
- **Depends on:** KOBE-409 (Build vectors), Gate B decision 20

## Plan

The build was already Site-wide (`VectorBackfill`: site, portable, then every team from
`scanTeams`, one job across replicas via advisory lock `kobe.memory-vector-build`); only its
payer needed the admin's active Workspace, so both the settings save and `POST
/v1/memory/vectors/build` refused or skipped without one. Make the payer per target instead.

## Decisions

- **Payers** (`memory/embeddings/build-payers.ts`, `buildTargets`): with an active Workspace,
  unchanged (the admin pays for everything there, KOBE-409 billing). Without one, each Workspace
  pays for its own items: the admin when a member, else the earliest Team admin, else the
  earliest member (the gateway needs a member's virtual key in that team, so a non-member admin
  cannot be the payer); a Workspace without members is skipped (logged). Site and portable items
  are paid by the admin in the Workspace they joined first, else by the first Workspace's payer.
  Members read per team inside `withTeam` (no raw team setting); `scanTeams` only lists ids.
- **Budget refusals skip, not stop:** a `budget` refusal marks that payer's Workspace exhausted;
  its remaining targets are skipped and the others still build; the job ends `stopped`/`budget`.
  Other refusals and a model change still stop the job. With an active Workspace this behaves as
  before (one payer: everything after the refusal is skipped).
- **Idempotent / no double run:** unchanged mechanisms: per-replica `running` check + the session
  advisory lock across replicas (a second start answers `running`; the settings save ignores
  it); pending rows are those without a vector of the current model, so a repeat embeds nothing.
- **Console status across replicas:** `GET /v1/memory/vectors` adds `running_elsewhere` (another
  session holds the build lock; read from `pg_locks`, no lock taken). The web shows "Building
  vectors on another server replica." and disables the button. `job.teamId` is now nullable.
- `no_active_team` is gone from `POST /v1/memory/vectors/build` (no other caller used it).

## Docs

`docs/guide/memory.md` (Who pays, What is sent) and `docs/guide/admin/site-admin.md` (embedding
model) say the build covers every Workspace with or without an active one and who pays; the web
hint and footer in the Site console say the same. No agent-facing change.

## Evidence

- `services/server/src/memory-vectors-site.db.test.ts`: saving the model with no active
  Workspace embeds items in two Workspaces (admin a member of one only) plus Site and portable,
  with the expected payers; concurrent saves + a later save + Build vectors embed each item
  once; Build vectors with no Workspace → 202; a Workspace at 100 % skipped, the rest built;
  `running_elsewhere` while another session holds the lock.
- Existing `memory-vectors.db.test.ts` (active-Workspace billing, lock 409) still green.
- Web: `components/admin/memory-switches.test.tsx` "shows a build another server replica runs".
