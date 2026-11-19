# KOBE-672: extractor screen accepts entry ids behind the pass's own fence nonce

- **Status:** in review (local commit on `kobe-672-sm` in `../Kobe-wt672`; coordinator reviews and opens the PR)
- **Trigger:** Gate B decision 16 (Chris, 2026-11-19). In the live v1 run the model cited
  `dcf9a3d8cbd951edac2a8af4303460ec:e1` (nonce + `:` + id) in proj-personal-pref-in-project and
  the screen dropped a good candidate `evidence_not_found` (KOBE-660 ledger, "Not done").

## Changes

- **`screen.ts`:** `screenExtractorOutput(output, input, nonce?)`. Before any rule runs, each
  evidence `entry_id` that starts with exactly `<nonce>:` or `<nonce> id=` (the fence's own
  form, `<<<entry <nonce> id=<id> ...>>>`) loses that prefix once; the rest must be a
  non-placeholder transcript entry id as before. The kept candidate carries the bare id (a new
  object), so stored candidates and the personal-data lookup see `e1`, not the prefixed form.
  Everything else stays part of the id and so matches no entry: another pass's nonce, a
  truncated or partial nonce, case variants (the nonce is lowercase hex), a nonce-like string
  planted in the transcript, double prefixes, other separators, leading text. No nonce given =
  no prefix accepted (fail closed). No other screen rule changed.
- **Why it is safe:** the nonce is 32 random hex characters per pass, and `buildExtractorMessages`
  refuses (`nonce_in_content`) any input whose entry ids or texts contain it, so a stripped id
  can only be one the pass actually fenced; the quote check against that entry still applies.
- **Separator choice:** the brief asked for the fence's exact form; the fence writes
  `<nonce> id=<id>`, but the observed model output was `<nonce>:<id>`. Both exact forms are
  accepted (a fixed list, `NONCE_SEPARATORS`); accepting only ` id=` would not fix the ticket's case.
- **`execute.ts`:** `messagesFor` returns the nonce it built the messages with; `extract` hands it
  to `finish`, which passes it to the screen.
- **Eval harness:** the model source records each attempt's `nonce` in the results JSON
  (`Attempt.nonce`, accepted by `recordedRunSchema`) and `scoreCase` screens with it, so live runs
  and future replays score like a pass. Earlier recordings have no nonce, so their replays are unchanged.
- **Prompt:** unchanged (`memory-extractor-v2`); screen-only change.

## Tests (written first, red before the change)

- `screen.test.ts` (KOBE-672 block): own nonce with `:` and ` id=` accepted, bare id stored;
  bare id still accepted; refused: other nonce, 16-char truncation, nonce minus first char,
  upper case, `n:n:id`, `n id=n:id`, no separator, `::`, space only, `/`, leading space,
  `<<<entry n id=…`, `x` + nonce; a nonce-like prefix planted in the transcript text; any prefix
  when no nonce is given; mixed-speaker evidence after stripping keeps both bare ids.
- `score.test.ts`: eval scoring uses the attempt's nonce; other nonce and none are dropped.
- `memory-learn-pass.db.test.ts`: a pass whose fake gateway reads the nonce from the messages
  stores the own-nonce candidate with `entry_id` `u1`; a zero-nonce citation is dropped.

## Verification

- `vitest run src/memory/learn src/testing/memory-eval`: 12 files, 419 tests pass (v1/v2 fixture
  suites included: adversarial fixtures still leave 0 Workspace candidates).
- `memory-learn-pass.db.test.ts`: 19 pass.
- `e2e/memory-eval.sh extractor` with `KOBE_EXTRACTOR_DRY_RUN=1`, before and after: identical,
  precision/recall/scope/kind 1.000, 0 Workspace/Site offers, adversarial 27/27, PASS. Dry-run
  recall does not change (oracle replies cite bare ids).
- Replays (no nonce recorded, so unchanged as expected): v1 glm-5.3-flash precision 0.969, recall
  0.926, 0 offers, PASS; v2 precision 0.985, recall 0.956, 0 offers, PASS. The recall gain
  (proj-personal-pref-in-project) shows only in a new live run; gate-7b.md not touched (no model run).
- `pnpm verify` (under the lock): pass.

## Guide

No change: the guide (`docs/guide/memory.md`) does not describe how evidence ids are matched;
members see the same review flow, only fewer good candidates are lost.
