# KOBE-746: RN-2: user-facing text: web UI, emails, guide, prompts, /llms.txt, README, notices; browser specs

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (no PR yet; branch only)
- **Branch / worktree:** `group-119-rename-2-text` in `../Kobe-g119`, stacked on `group-117-rename-1-guard` (KOBE-745)
- **Spec:** `docs/specs/rename-kaiju.md` §3 changes 1, §4 step 2; tooling `scripts/rename/README.md`

## Counts

| Owner (guard `--report`) | Before (base `d90525b74`) | After       |
| ------------------------ | ------------------------- | ----------- |
| RN-2                     | 3,597 in 1,132 files      | 0           |
| all occurrences          | 61,832                    | 58,488      |
| provisional              | 1,617                     | 1,704 (Q13) |
| permanent                | 33,523                    | 33,623      |

- **Scripted** (`rename.mjs --apply --step RN-2`, commit `7f352e842`): 3,326 occurrences in 1,104
  files: `Kobe` → `Kaiju` in prose, plus three narrowed docs patterns (guide anchor
  `#what-kaiju-checks-before-a-memory-is-saved`, `skill-package.md#created-by-kaiju-on-request-…`,
  the `https://<kaiju>` host placeholder in `docs/install.md`).
- **Regenerated:** `THIRD_PARTY_LICENSES.md` and `NOTICE` by `pnpm licenses:update` (37); the
  lockfile's `pnpmfileChecksum` follows the comment change in `.pnpmfile.cjs`.
- **By hand:** 11 test regex literals (`/Kobe …/`, owned by RN-3's file-name entry, see Notes for
  RN-3), 5 test strings the identifier entry owned (`KobePersonal` is text, not a name), one test
  host; the site-wording check's optional `kobe ` word now reads `kaiju `; prettier re-flowed 31
  files the longer word widened.

## Sorted before the apply (commit `60b64683a`)

The 217-line docs `Triage:` tail and the prose pattern were narrowed; nothing went to `permanent`
without a reason:

- **New Q13 (provisional): the gallery agent's name.** Its definition
  (`services/server/src/gallery/agents/kobe.ts`: `name: Kobe`, "You are Kobe, …") is pinned by
  `generation: 4`; renaming it means raising the generation, which re-publishes the agent on every
  existing install (a stored-row change). Held together: the definition, the gallery tests and
  `app-launch-agent.db.test.ts` (seeded name), `e2e/browser/tests/site-gallery-edit.spec.ts`
  (default agent name), and text naming the agent ("the Kobe agent isn't available…", "The site
  default (Kobe)", "the gallery agent Kobe" in the guide, install notes and e2e labels): 59 occ.
- **Q12 extended:** `memory/learn/prompt/build.ts` writes part of the versioned extractor
  prompt ("the person teaching Kobe") into the same messages as `v1`/`v2`: held with them.
- **Permanent:** the frozen memory relevance set (`e2e/fixtures/memory-relevance/items.json`,
  KOBE-387: never changed after the first recorded run); migration notices quoted in
  `docs/install.md` (`kobe: … team agent versions frozen`, printed by applied migrations); the
  Hadron project key in `CLAUDE.md`; `kobe-mac-mini/…` in the guide (a Bifrost provider name,
  already permanent in code); the guide's own rename heading.
- **Moved to their groups:** the built-in connector's name `kobe` in the guide (**kobe**,
  `#the-kobe-connector`, `mcp__kobe_builtin__`, `mcp__kobe_git__`) → Q3; `compatibility.kobe` → Q2;
  `?kobe/*` → Q4; scope `kobe` → Q8; the `kobe` Pi provider → Q4; worktree and branch names and
  the test-lane rule (`Kobe` → `kobe`, with `lane.ts`) → RN-8; span attributes, syslog APP-NAME
  `kobe-audit`, SD-ID `kobe@<PEN>`, perf-query aliases → RN-5; release, namespace, Secret,
  database, bucket and chart names in commands → RN-6 Triage; the rest (the `kobe` CLI, backup
  role, connection application names, test database names, CSS names, message prefixes such as
  `kobe: SSH is not available`) → a new RN-3 docs Triage group: they name code that RN-3 renames.

## Decisions

- **Default branding name.** `DEFAULT_APP_NAME` (`packages/protocol/src/branding.ts`) is now
  "Kaiju". It is a runtime default, never stored: no migration writes `app_name`, the chart's
  `branding.appName` defaults to `""` (no seed), and a reset deletes the row. So installs that
  never set a name show Kaiju after the upgrade; installs that set one (or seeded one from chart
  values) keep theirs. No data change, no owner question.
- **Auth labels:** TOTP issuer, passkey `rpName`, Better Auth `appName` and the OAuth client name
  for connector registrations say Kaiju: new enrolments and registrations only; existing
  authenticator entries keep their label, nothing is verified against it.
- **Git and mirror identity:** committer suffix " via Kaiju" and fallback "Kaiju member" (minted,
  never parsed back); the skill mirror's default author name "Kaiju Registry" (spec §5: changes
  for new commits); commit trailers stay (permanent).
- **Prompts.** Unversioned prompt text (run context, admin MCP tool descriptions, sandbox notes)
  changes like any release's wording; tool `sha256` pins are computed live. Versioned prompts
  (memory learn v1/v2 and its builder), built-in skills (Q12) and the gallery agent (Q13) are held.
- **Release notes:** `docs/releases/README.md` carries the one rename line; the guide's What's new
  gets a short "Kobe is now Kaiju" section (allowlisted heading).

## Owner questions

- **Q13 Gallery agent name** (KOBE-745's question 13, now a provisional group): rename it by
  raising its generation to 5 (every install re-publishes it as "Kaiju"; customised copies are
  skipped and keep "Kobe"), or keep "Kobe" as the agent's name? Until answered, the agent and the
  text that names it say "Kobe" while the product says Kaiju. [rename with a generation bump]
- **Q12 restated:** built-in skills (`kobe-guide` and the others) and the memory extractor prompt
  (now with its builder) still say Kobe to the model; renaming needs new skill versions and a
  prompt v3 with new recordings. [rename with the next prompt and skill versions]

## Notes for RN-3

- RN-3's file-name entry (`/(?:\.{1,2}\/|\/)…kobe…/i`) also owns regex literals like `/Kobe found/`
  and RN-3's identifier entry owns concatenated text like `"KobePersonal"`; RN-2 fixed the ones
  that were text. Watch for the same when RN-3 applies.
- The new RN-3 docs Triage group lists the docs mentions of code RN-3 renames (the `kobe` CLI …).

## User-visible places changed (spot-check)

- Web UI: 164 non-test files in `apps/web` (sign-in and setup, shell, chat notices such as "Kaiju
  is learning from this chat", "Kaiju was updated. Reload…", admin consoles: catalog, connectors,
  backup, isolation, memory, SSO, settings' Kaiju connector switch), page titles via the default
  app name.
- E-mail and notices: `services/server/src/mail/messages.ts`, retention and git notices, connector
  drift/refresh messages, approval cards.
- Guide: 33 pages in `docs/guide` (→ `/docs`, `/llms.txt`, `/llms-full.txt`, `/docs/<slug>.md`);
  guide test fixtures follow.
- Agents: admin MCP tool descriptions (`services/server/src/kobe-mcp/**`), run context and sandbox
  notes (`services/sandbox-agent`: notebook notes "[Kaiju: …]", kernel "Python 3 (Kaiju)"),
  egress-proxy refusals ("Kaiju egress: …").
- Operator: README, `docs/*.md`, chart NOTES, descriptions and error messages, licence files.

## Doc evaluation

This step is the documentation change: 33 guide pages, What's new and the operator docs. Command
names and identifiers in docs keep `kobe` until their steps (RN-3..RN-6), on purpose.

## Evidence

- Guard ok (58,488 allowed, 155 entries); self-test 21/21; build, typecheck, lint, format:check ok.
- Unit suites: server 4,565 passed / 8 skipped (one test fixed, rerun green); web 4,288; protocol
  1,373; db 1,106; sandbox-agent 1,288 passed, 2 failed (the known `runtime-dir.test.ts` pair on
  this machine), 196 skipped; charts 395; cli 98; model-gateway 260; egress-proxy 180; mcp-proxy
  170; license-check 86; guide 33; address-policy 16; skill-scanner 180 (untouched; timed out only
  under turbo's parallel load).
- DB suites: `@kobe/server test:db` 3,739 passed; `@kobe/db test:db` 2,180 passed.
- `check-site-wording.mjs`, `check-public-hygiene.sh` ok; gate2's generic secret patterns and JWT
  shape match none of the lines added under `services/sandbox-agent`, `images`, `packages/protocol`.
- Not run here: the browser suite and e2e gate scripts (changed: listed in the coordinator report).
