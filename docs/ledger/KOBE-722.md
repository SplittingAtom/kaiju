# KOBE-722: Type-aware lint: no-floating-promises and no-misused-promises (review CODE-37)

- **Status:** in review
- **Branch / worktree:** `group-112-typed-lint` in `../Kobe-g112`
- **Depends on:** none (the fire-and-forget and CI tickets landed first)

## Decisions

- `eslint.config.js` turns on only `@typescript-eslint/no-floating-promises` and
  `@typescript-eslint/no-misused-promises`, with `parserOptions.projectService`, for
  `services/*/src/**/*.ts` and `packages/*/src/**/*.ts` (`TYPED_FILES`). Every service and package
  tsconfig includes `src` (tests too), so no file falls back to a default project. `apps/web`,
  tools, scripts and `vitest.config.ts` files stay on the untyped lint.
- Test files keep the rules: they produced one finding, not noise.
- `services/server` lint gets `NODE_OPTIONS=--max-old-space-size=6144`: its typed lint holds the
  whole server program and ran out of heap at 2 GiB and 3 GiB (passes at 4 GiB; 6 GiB leaves
  room to grow). Its `typecheck` already raises the heap the same way. Other packages fit in 2 GiB.

## Findings (before fixes): 0 no-floating-promises, 3 no-misused-promises; 0 real bugs

The codebase already marks fire-and-forget promises (`void` / `.catch`), so the floating rule
found nothing (checked the rule fires on a deliberate probe file).

| Site                                                                                                  | Verdict                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db/src/client.ts:158` `onConnect: appSessionHook(...)`                                      | Not a bug. pg-pool 3.14 awaits the hook's promise (`_promiseTry(...).then(...)`, a rejection fails the acquire); `@types/pg` types it as returning `void`. Inline disable with that reason. |
| `services/server/src/event-stream/read.ts:170` same hook                                              | Same; inline disable.                                                                                                                                                                       |
| `packages/telemetry/src/http.test.ts:158` async handler returned from an `http.createServer` callback | Test only; the handler cannot reject. Made the callback a block with `void`.                                                                                                                |

## Lint timing (GSD VM, 12 cores; `turbo run lint --force --only`, deps prebuilt)

- Before: 31.1 s / 32.2 s (two runs). `services/server` alone: 28.4 s.
- After: 107.3 s / 97.8 s. `services/server` alone: ~100 s (76.7 s if test files were left out
  of the typed rules); `packages/db` 26.8 s; every other package under 14 s.
- The wall time is the server package (turbo runs packages in parallel). In CI this is the
  `static` job's `pnpm lint` step, cached by turbo when inputs are unchanged.

## User-facing docs

None: lint configuration and comments only, no behaviour a member, admin or agent sees changes.

## Evidence

- ac-1: `pnpm lint` (forced) green; `pnpm build`, `pnpm typecheck`, `pnpm format:check`,
  `check-site-wording`, `check-public-hygiene` green.
- ac-2: timing above; no real bug, so no bug-fix test.
- Unit suites: `@kobe/telemetry` 32/32, `@kobe/db` 1105/1105, `@kobe/server` 4559 passed / 8
  skipped. `@kobe/db test:db` 2176/2176. `@kobe/server test:db` not run: its only change is a
  lint comment in `event-stream/read.ts`.
