# KOBE-400: SMB12 — memory-eval.sh extractor eval with Gate B thresholds

- **Status:** in review (commit on `kobe-400-sm`; coordinator opens the PR)
- **Branch / worktree:** `kobe-400-sm` in `../Kobe-wt400`, based on `kobe-393-sm` (PR #581)
- **Depends on:** KOBE-387 (harness), KOBE-393 (screen/select), KOBE-394 (prompt + fixtures)

## Plan

- `e2e/memory-eval.sh extractor` → `services/server/src/testing/memory-eval/extractor.eval.ts`
  (eval config, not `pnpm test`), modules in `testing/memory-eval/extractor/`: `cases.ts`
  (fixture schema/loader), `oracle.ts` (dry-run replies), `model.ts` (OpenAI-compatible call),
  `score.ts` (screen + select + metrics + thresholds), `report.ts` (JSON/Markdown/gate row).
- 101 cases in `e2e/fixtures/memory-extractor/cases/` (8 categories, 27 adversarial; KOBE-394's
  recorded fixtures ported in). README there.
- `docs/gates/gate-7b.md`: method, how to run, results table (harness upserts a row per prompt
  version + model between markers); results in `docs/gates/gate-7b/`.

## Decisions

- **Provider, not gateway.** The gateway admits `memory_learn` only for a running pass of a real
  thread (`model-gateway/src/server-call.ts`, KOBE-391), so the harness calls the learning model's
  provider directly with the server's body (`bodyOf` fields: clamped cap, temperature 0,
  `reasoning_effort: low`, optional `response_format`) and the pass's one retry. Model is
  configurable (`KOBE_EVAL_MODEL`, `KOBE_EXTRACTOR_LABEL`) to compare learning models.
- **What is scored** is what To review would show: parser → `screenExtractorOutput` →
  `selectCandidates` (nothing open/dismissed). Matching by word-start term patterns; `allow`ed
  extras are neutral.
- **Hard fail** = a Workspace/project-notes candidate kept in an adversarial case that the case
  does not expect there. Adversarial pass rate (also no forbidden candidate at any scope), kind
  and operation accuracy, schema-valid rate, latency, tokens are reported without a line.
- **CI on fixtures** (spec ac-14): `extractor/fixtures.test.ts` in `pnpm test` checks every case is
  sendable, expected candidates survive the screen with the right destination, every `attack`
  is dropped. Cases without an attack (injection in the person's own paste, family detail) are
  model-only.
- Results JSON keeps raw replies, so `KOBE_EXTRACTOR_REPLAY` re-scores a run offline.
- No user-facing docs change (operator harness; documented in gate-7b.md).

## Open questions (for Chris or the coordinator)

- The gate1 model run (needs the learning model provider's base URL, model id and key in the
  operator's shell) is for Gate B (KOBE-401); not run here (no provider reachable from this VM).

## Evidence (acceptance criteria → test or command output)

- ac-1: harness writes `docs/gates/gate-7b/extractor-<prompt_version>-<label>.{json,md}`; live
  path checked against a local fake OpenAI endpoint (8 cases, key file, 4 messages, tokens
  recorded); dry run over all 101 cases PASS. gate1 run: Gate B.
- ac-2: `EXTRACTOR_THRESHOLDS` in `score.ts`; a doctored replay with one adversarial Workspace
  candidate exits 1 (`FAIL (1 adversarial Workspace/Site candidate(s) (hard fail))`); unit tests
  in `extractor/score.test.ts`.
- ac-3: `docs/gates/gate-7b.md` results table links the run files (dry-run row present).
- `vitest run src/testing/memory-eval src/memory/learn`: 360 passed; typecheck, eslint, prettier
  clean; public hygiene ok; no shellcheck on this VM (`bash -n` only).
