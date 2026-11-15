# KOBE-394: SMB6 — extractor prompt v1 and recorded-response CI fixtures

- **Status:** in review (commit on `kobe-394-sm`; coordinator opens the PR)
- **Branch / worktree:** `kobe-394-sm` in `../Kobe-wt394`
- **Depends on:** KOBE-390 (contract, merged #572)

## Plan

Server-only, no migrations, no protocol change. `services/server/src/memory/learn/`:

- `prompt/input.ts`: `ExtractorPromptInput` (zod + type) that KOBE-392 fills: `project`
  (`{name}` or null), `existing` items (id, scope, kind, policy, statement), `transcript` entries
  (`entry_id`, `speaker: person|assistant|tool|summary`, `text`).
- `prompt/v1/prompt.ts`: `PROMPT_VERSION = "memory-extractor-v1"`, static `SYSTEM` and
  `INSTRUCTIONS`. `prompt/v1/fixtures/`: recorded replies + `prompt.sha256` pinning the bytes.
- `prompt/build.ts`: `buildExtractorMessages(version, input, nonce)` → four messages or
  `too_large` / `nonce_in_content`. `prompt/index.ts`: `extractorMessages(input, nonce)` with the
  current version.
- `screen.ts`: `screenExtractorOutput(output, input)`, the pure validator CI replays and
  KOBE-393 runs on every parsed reply before its DB checks.

## Decisions

- **Message order** follows the brief (system, existing items incl. Policy, transcript,
  instructions). For caching, all guidance and the reply format live in the system message
  (byte-stable prefix); the closing instructions message is also static and short (a sandwich
  against injection). The per-pass nonce, project, items and transcript sit only in messages 2–3.
- **Fences:** `<<<memories N>>>…<<<end N>>>`; every transcript entry starts
  `<<<entry N id=<id> speaker=<speaker>>>>`. Nonce ≥16 alphanumerics (throws otherwise); data
  containing the nonce → `nonce_in_content`. Items are one JSON object per line; project name
  JSON-quoted.
- **Caps:** ≤100 existing items listed, Policy first. Size check counts the four messages, the
  `memory_learn` response format and 4 KiB headroom against 384 KiB, and 300,000 chars per
  message. Over → `too_large`; KOBE-392 trims the transcript (no truncation here).
- **Model-neutral:** reply format spelled out in the prompt (structured output is optional per
  provider); test asserts no provider/model names.
- **Screen rules** (first applies): `evidence_not_found` (entry missing or quote not a verbatim
  span via `quoteFoundIn`, exact case), `person_evidence_missing` (no quote from the person: an
  assistant claim, tool output or summary alone never makes a memory),
  `shared_evidence_not_person` (Workspace candidate also quoting tool/summary),
  `unknown_target`, `policy_target`, `secret` (statement, rationale, quotes; via
  `memory/checks/secrets`), `instruction` (statement lint), `personal_data` (Workspace only),
  `project_without_project`. Skill hints carrying a credential are left out.
- **Destinations:** `user`, `portable`, `team`, `project_notes` (Workspace + `project_specific`
  in a project thread). A project-specific personal candidate stays `user`. Never `site`.
- **Organization-wide knowledge:** the extractor schema has no `site` scope (KOBE-390), so the
  prompt says to keep it `team` and note "organization-wide" in the rationale; a Team admin
  moves it.
- **Fixtures are authored recordings**, not captured from gate1 (no model access in this ticket):
  realistic replies, the adversarial ones written as a fooled model would answer. A future
  version should replace them with captured replies (see open questions).
- **Version bump rule:** editing `SYSTEM`/`INSTRUCTIONS` fails the sha256 test; copy to `v2/`,
  record new fixtures, point `prompt/index.ts` at it.

## Review fixes (coordinator, Opus review)

- Personal data is checked at every scope (a colleague's details never become a personal
  memory); fixture `adversarial-third-party-personal-user`.
- `entry_id` must be a uuid and ids (entries, items) unique; otherwise `invalid_input`.
- A target must be one of the items the prompt listed (`listedExistingItems`, ≤100).
- The instruction lint also runs on rationale (drop) and skill hints (left out).

## Open questions (for Chris or the coordinator)

- Capture real glm-5.3-flash replies for these inputs on gate1 once KOBE-393 can run a pass,
  and replace the authored ones (expected outcomes should stay the same).
- Where `prompt_version` is stored (pass row column) is KOBE-389/393's call; the builder
  returns it with the messages.
- KOBE-393 decides whether dropped reasons surface to the author (count only today:
  `memory.pass.completed.dropped`).

## Evidence (acceptance criteria → test or command output)

- **ac-1** `prompt/v1/prompt.ts` next to `prompt/v1/fixtures/*.json`; `fixtures.test.ts` pins the
  bytes (`prompt.sha256`); `build.test.ts` checks version, order, byte-stable static messages,
  nonce placement, caps, valid `serverCallRequestSchema` body.
- **ac-2** `fixtures.test.ts` replays 11 fixtures through `parseMemoryExtractorOutput` +
  `screenExtractorOutput` with no model or keys (plain `vitest`, part of `pnpm test`).
- **ac-3** Adversarial fixtures (injected tool output, agent hallucination, secret in chat,
  third-party personal data at Workspace and personal scope, branch summary, site scope) keep no `team`/`project_notes`
  candidate; `normal-project-fact` comes back `project_notes` with `project_specific: true`.
- `services/server` `vitest run src/memory/learn`: 49 passed. `pnpm verify` green (format, lint, typecheck, all tests, license, hygiene; no DB tests: no migrations).
