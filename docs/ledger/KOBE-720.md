# KOBE-720: @kobe/protocol: sideEffects false, sandbox-wire behind a subpath export, split frames.ts

- **Status:** in review (group 61, branch `group-61-web-splits-protocol`)
- **Branch / worktree:** `group-61-web-splits-protocol` in `../Kobe-g61`
- **Depends on:** none

## Decisions

- `@kobe/protocol` no longer re-exports `sandbox-wire`; it is `@kobe/protocol/sandbox-wire`
  (new `exports` entry). `"sideEffects": false` added.
- The workspace path rules the browser also needs (`workspacePathSchema`, `workspacePathIssue`,
  `sha256HexSchema`, `WORKSPACE_DROP_FOLDER`, `isMemberDropPath`, `isExcludedPath`, path limits,
  `workspaceOriginSchema`) moved to `src/workspace-paths.ts`, exported from the root;
  `sandbox-wire/workspace-sync.ts` re-exports them, so both entries keep them. Root modules
  (`files.ts`, `projects.ts`, ...) import that file instead of `sandbox-wire/workspace-sync.ts`.
- `gatewayModelSchema` and friends moved to `sandbox-wire/frames/model.ts` (no frame imports), so
  `server-call.ts` no longer pulls in every frame schema.
- `frames.ts` (817 lines) split by domain into `frames/{wire,session,policy,artifacts-files,
compaction,run,model}.ts`; `frames.ts` keeps the two unions and the frame types (180 lines).
  Pure move: same exports, same comments.
- Importers in server, sandbox-agent and protocol's own tests rewritten mechanically (204 files):
  names that only the sandbox wire exports now come from `@kobe/protocol/sandbox-wire`.
- ac-1: eslint `no-restricted-imports` in `apps/web` refuses `@kobe/protocol/sandbox-wire` and
  deep `@kobe/protocol/dist/*` / `src/*` imports (the KOBE-694 path is repeated for web
  production files because a later block replaces the rule).
- User-facing docs: none needed (internal packaging; nothing a member, admin or agent sees).
  `packages/protocol/README.md` documents the new entry point.

## Evidence

- ac-2 (`next build`, `apps/web/.next/static/chunks/*.js`):
  - before: the frame schemas (`hello.ack`, `policy.check`, `session.restore`, `pi.event`) sat in
    a 258,245 B client chunk; total client JS 8,293,789 B; largest chunk 654,136 B (not protocol).
  - after: no client chunk contains a frame type string; the protocol code the browser uses is a
    47,736 B chunk; total client JS 8,233,660 B (-60 KB); largest chunk 654,136 B (unchanged,
    not protocol).
- ac-3: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` green (see group verify run).
  `services/sandbox-agent` `runtime-dir.test.ts` needs a TMPDIR whose parents are not
  group-writable (environment, not this change).
