# KOBE-725: Split test files over 800 lines along their describe blocks (review CODE-32)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** done on the branch (not pushed)
- **Branch / worktree:** `group-114-split-tests` in `../Kobe-g114` (stacked on
  `group-113-test-folders`; merge only, never rebase or squash)
- **Depends on:** KOBE-726 (the area folders the paths below use)

## Plan

Re-list every `*.test.ts(x)` over 800 lines, split each along its top-level `describe` blocks
into sibling files named for what they cover (`.db.test.ts` kept), shared setup in one
`<name>.test-helpers.ts` beside them. Test bodies move unchanged; one original file per commit;
same test names and counts per file (vitest json, before and after).

## Before and after

| Original (lines)                                           | New files (lines)                                                                                                                |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| server `policy/evaluate.test.ts` (1157)                    | `evaluate.order` 56, `.invariants` 168, `.dangerous` 82, `.tools-deny` 20; helpers 58 + `evaluate.cases-early` 445 + `-late` 383 |
| server `retention/retention.db.test.ts` (1141)             | `retention.settings` 272, `.pass` 369, `.export` 292; helpers 282                                                                |
| server `sso/sso-sign-in.db.test.ts` (1258)                 | `sso-sign-in.jit` 277, `.checks` 358, `.mfa` 271, `.sessions` 263; helpers 183                                                   |
| server `mcp/mcp.db.test.ts` (1011)                         | `mcp.calls` 486, `.approvals` 457; helpers 127                                                                                   |
| server `threads/threads.db.test.ts` (999)                  | `threads.crud` 370, `.list` 504; helpers 175                                                                                     |
| server `sso/scim.db.test.ts` (970)                         | `scim.tokens` 267, `.users` 598; helpers 159                                                                                     |
| server `workspace-files/workspace-files.db.test.ts` (964)  | `workspace-files.browse` 388, `.upload` 490; helpers 142                                                                         |
| server `sandbox-wire/sandbox-wire.db.test.ts` (953)        | `sandbox-wire.connect` 373, `.runs` 470; helpers 168                                                                             |
| server `agents/orbit-eval.db.test.ts` (932)                | `orbit-eval.publish` 391, `.states` 409; helpers 223                                                                             |
| server `approvals/approvals.db.test.ts` (912)              | `approvals.decisions` 388, `.lifecycle` 346; helpers 226                                                                         |
| server `memory/memory-agent.db.test.ts` (840)              | `memory-agent.personal` 314, `.project` 307; helpers 318                                                                         |
| server `feedback/answer-feedback.db.test.ts` (832)         | `answer-feedback.rating` 270, `.totals` 376; helpers 231                                                                         |
| server `memory/semantic-memory-retention.db.test.ts` (817) | `semantic-memory-retention.sweeps` 279, `.departures` 312; helpers 291                                                           |
| server `memory/memory-learn-pass.db.test.ts` (1023)\*      | `memory-learn-pass.outcomes` 352, `.starts` 467; helpers 283                                                                     |
| server `git-tools/git-tools.db.test.ts` (923)\*            | `git-tools.calls` 422, `.guards` 390; helpers 165                                                                                |
| server `kobe-mcp/kobe-mcp.db.test.ts` (837)\*              | `kobe-mcp.tools` 306, `.guards` 322; helpers 250                                                                                 |
| server `approvals/remember-scopes.db.test.ts` (808)\*      | `remember-scopes.scopes` 338, `.waiting` 296; helpers 222                                                                        |
| sandbox-agent `agent.runs.test.ts` (963)                   | `agent.runs.stream` 442, `.process` 506; helpers 47                                                                              |
| chart `tests/render.test.ts` (997)                         | `render.workloads` 360, `.network` 273, `.auth` 294; helpers 85                                                                  |
| chart `tests/sandbox.test.ts` (976)                        | `sandbox.server` 400, `.cluster` 547; helpers 59                                                                                 |
| web `components/admin/agent-builder-pages.test.tsx` (822)  | `agent-builder-pages.edit` 405, `.orbit` 368; helpers 81                                                                         |

\* not in the review's list of 23 (grew past 800 since), split because the cut was clean.

## Left alone (still over 800)

- `services/mcp-proxy/src/mcp.test.ts` (1195), `services/egress-proxy/src/proxy.test.ts` (915),
  `services/model-gateway/src/server-call.test.ts` (912): gateway and proxy tests split inside
  their source-split tickets (CODE-9, CODE-29), as the brief says. The review's
  `model-gateway gateway.test.ts` and `sandbox/provider.test.ts` are no longer over 800.
- `services/server/src/models/models.db.test.ts` (861, in the list): its describes are one
  story over shared rows (providers made in "site providers" are what "catalog" publishes, and
  "gateway sync" pushes that catalog), with exact audit lists that count earlier steps. A split
  would need the earlier tests re-run as setup; tried, 8 of 18 failed. Not clean.
- `services/server/src/skills/evals/skill-eval-runner.db.test.ts` (819) and
  `services/sandbox-agent/src/workspace/sync.test.ts` (1022): one `describe` of 784 and 820
  lines; splitting means cutting inside a describe (not in the list either).

## Decisions

- **Helpers are `<name>.test-helpers.ts`** (the convention of web's
  `theme-css-source.test-helpers.ts`): excluded from server and sandbox-agent `dist`
  (`tsconfig.build.json`) and given the test lint rules in `eslint.config.js` (first commit).
  Shared hooks are registered by an exported `use…()` call at the top of each file, so every
  file opens its own harness and database (DB files run in parallel).
- **State the tests assign stays in the test file.** ES imports cannot be assigned, so where
  test bodies assign a module variable (`h` in agent.runs, `jobResult`/`gateOpen` in orbit-eval,
  `skewMs` in approvals, `askProject`/`denyRecall`/`seq` in memory-agent) each file declares it
  and passes getters to its `use…()` call; the helper's fakes read through them. Test bodies
  are unchanged.
- **Hidden coupling found and kept working:**
  - `sso-sign-in.sessions`: break-glass needs the IdP discovery cached ("discovery is cached");
    a file-level `beforeAll` fetches it once. The 9b test's `no_access` audit row only existed
    because earlier describes had written one: the attempt log keeps one row per (action,
    method, account) and 5-minute window, so break-glass's `idp_unreachable` swallowed it. The
    9b describe now runs first in its file, where its own row is recorded (a real check now).
  - `scim`: "protects the setup Owner" reads the setup Owner the site-role guard tests create,
    so the security review fixes sit in `scim.users` with them.
  - `policy/evaluate`: the 798-line D29 table moved unchanged into two data modules
    (stages 0-4, 5 on) joined in the original order in `evaluate.order.test.ts`.
- **No source split.** The finding pairs CODE-32 with CODE-5/9/29 (provider, gateway, proxies);
  those tests are out of scope here, so no source file changed (comments only).

## Path-keyed things checked

- Selection is by glob (`src/**/*.test.ts`, `src/**/*.db.test.ts`, chart `tests/`), so the new
  files are picked up as before; CI DB shards split by file count (more files now).
- Updated comments naming split files: `e2e/run/36-approvals.sh`, `policy/channel.ts`,
  `apps/call-deps.ts`, `git/connections.ts`, `routes/agents.ts`, `routes/memory-review.ts`,
  `routes/site-connectors/core.ts`, `approvals/scheduled-auto-deny.db.test.ts`,
  `gallery/gallery-scores.db.test.ts`. Older ledgers, gate documents and reviews keep the paths
  of their time. No guard allowlist names these files.

## User-facing guide

No change: test files are not visible to members, admins or in-sandbox agents, and
`docs/guide/` names no test path.

## Evidence (acceptance criteria → test or command output)

- **ac-1** (vitest json totals, before → after; sorted full test names identical in every suite):
  - server `test`: 336 files / 4571 tests (8 skipped) → 339 / 4571 (8 skipped)
  - server `test:db`: 299 files / 3730 tests → 318 / 3730, all passed
  - sandbox-agent: 169 / 1486 → 170 / 1486 (196 skipped both times; the same 2
    `runtime-dir.test.ts` failures before and after, from the local `TMPDIR` being
    group-writable, not from this change)
  - web: 467 / 4283 → 468 / 4283; chart: 28 / 395 → 31 / 395; `@kobe/db` unit 30 / 1105 passed
  - Per original file: the new files' test names equal the original's (checked one by one).
- **ac-2:** no listed file over 800 except `models.db.test.ts` (861, see Left alone).
- The 35 new DB files ran a second time on their own: all passed.
- build, typecheck, lint, format:check, `check-site-wording`, `check-public-hygiene`: ok.
- Guards updated: `legal-hold/site-memory-deletes.test.ts` and `memory/items/write-paths.test.ts`
  now skip `*.test-helpers.ts` as test code (the helpers seed fixtures with direct SQL).
