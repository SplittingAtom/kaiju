# KOBE-840: Composer enhancements (no "Team default", memory dot after 30%, waiting glow, composer focus)

- **Status:** in review (branch committed, not pushed)
- **Branch / worktree:** `group-142-composer-enhancements` in `../Kobe-g142`
- **Depends on:** none

## Plan

Chris's four requests of 2026-11-25 (BRIEF.md), each with unit/component tests, one browser spec,
and the guide updated in the same change.

## Decisions

1. **Model picker** (`lib/chat/model-choices.ts` `pickerOptions` / `pickerValue` / `pickedModel`,
   `components/chat/model-picker.tsx`): the select lists the enabled models by name only; while
   the conversation follows the team default the default model's own entry is selected. Picking
   the default model's entry saves `model: null` (follow the default), as the old "Team default"
   entry did, so a later change of the team default still reaches the conversation. A default
   that isn't enabled keeps a plain "Default model" entry (something has to name `null`). `/model`
   (slash menu and palette) uses the same options. Session info shows the model by name.
   "Regenerate with…" keeps "Team default (…)": it is a menu of runs to ask again with, not the
   picker; the skill-manifest and agent-builder model fields are not the composer picker either.
   The accessible name stays "Model for this conversation" (the selected option names the model).
2. **Memory dot** (`MEMORY_DOT_MIN_CONTEXT_PERCENT = 30` and `memoryDotAllowed` in
   `lib/chat/learn-api.ts`): the + button's red dot (new messages to learn from) shows only when
   the context gauge's figure is above 30%. The figure comes from the gauge's own reading,
   factored out of `ThreadContextGauge` as `useThreadContextReading` / `useThreadContextPercent`
   (`components/shell/context-gauge.tsx`). Unknown context (no call yet, compacted, no window in
   the catalog) means no dot. The nudge pulse (KOBE-410) needs the dot, so it is held back too.
   The spinner and the count of suggestions to review are not held back (the count is the
   accent-coloured badge, not the red dot). Memory › Learn from this chat stays in the menu. The
   bell and other notices are unchanged.
3. **Edge glow** (`lib/chat/edge-glow.ts`, `components/chat/edge-glow.tsx`, thread root
   `data-kaiju-edge-glow`, rules in `app/chat-global.css`): the run state has three
   blocked-on-member states, all gold: a pending approval (`runPhase` → `approval`: the server's
   `waiting_approval` or an unresolved `approval.requested` on the stream; Git approvals are
   approvals), an interrupted run (Retry / Continue), a paused queue with queued messages (Resume
   or a new message). Kaiju has no ask-the-member question tool; a file-edit proposal answers
   `awaiting_user` without holding the run, so it does not glow. Red: the last run failed
   (`run.failed`) and its notice is still shown, until the next send (`sending` / a new run) or
   until the notice is closed (`closed-notices.ts` now tells subscribers which id closed, so the
   glow follows within the page even when storage is blocked). No glow for a shared reader or in
   Trash. Tokens `--kaiju-glow-waiting(-border)` and `--kaiju-glow-error(-border)` (kaiju prefix,
   as every token) in light and both dark blocks, fixed like the gold glow. Drawn as an inset ring
   on a `::after` layer inside the thread root (`pointer-events: none`, panel radius), so the
   floating column's border, hover halo and rounded corners (KOBE-554) and the grid stay as they
   are. Gold breathes; red is still; reduced motion stops the gold; forced colours get a
   `Highlight` outline. Text cues unchanged ("Waiting for your approval", "Interrupted",
   "Queue paused.", "The run failed: …").
4. **Composer focus** (`lib/chat/composer-focus.ts`, `components/chat/use-composer-focus.ts`,
   used by the chat shell's composer only, not the agent builder's test pane): the composer
   takes the focus when its thread key (assistant-ui's thread list item id) comes on screen: page
   load, New conversation, a thread from the Threads panel (also the palette, a search hit). Two
   frames later, as `focusComposerSoon` does. Rules: never from another field (input, textarea,
   select, contenteditable, textbox/combobox roles); while a dialog, menu or listbox is open it
   waits (up to 1.5 s) for it to close, which is how the Threads panel closing onto the chosen
   thread is handled; never once the member moved the focus or pressed a key since the request;
   at page load only from the page itself; no request at page load on a coarse pointer. The
   member's own announcements stay: only focus moves, the polite live region and document title
   are untouched. A focus the composer took on its own is marked (`data-kaiju-autofocus`) until
   the member types, presses or leaves, so a file editor that opens with the page
   (`code-editor.tsx` `typingElsewhere`) may still take it (KOBE-802's "opens with the cursor").
   New conversation and thread switches on a phone do focus (the brief limits the touch exception
   to page load).

## Docs evaluation

Member-visible changes, so the guide changes in this branch: `models.md` (no "Team default"
entry; default shown as selected; picking it again follows the default), `chat/composer.md`
(where the cursor starts and its exceptions; new section "When the conversation waits for you" on
the gold/red glow; the red dot's 30% rule), `memory.md` (the + table's red dot row and the
threshold), `internet-and-approvals/approvals.md` (the glow while an approval waits),
`whats-new.md` (short "The composer" section). No "For agents" page changes: nothing an
in-sandbox agent sees or can do changed.

## Open questions (for Chris or the coordinator)

- Chris described the dot as "memory suggestions ready to review"; the only red dot on + is
  "new messages to learn from" (suggestions show as a count). Only the red dot is gated.
- Paused queue counts as waiting (gold); drop it if that feels too eager after a Stop.

## Evidence (acceptance criteria → test or command output)

- ac-1: `lib/chat/model-choices.test.ts` (3 new), `components/chat/model-picker.test.tsx`
  (options, selected default, "Default model"), `slash-menu.test.tsx` (`/model` choices);
  `regenerate-with` and `composer-selectors` tests kept in step (the picker's value for the
  default is now its alias).
- ac-2: `lib/chat/learn-api.test.ts` (29/30/31/null), `components/chat/plus-learn.test.tsx`
  (29% no dot or pulse and Learn still in Memory; 31% dot; the count at 5%).
- ac-3: `lib/chat/edge-glow.test.ts` (7, the state mapping), `components/chat/edge-glow.test.tsx`
  (5: approval gold until Allow, interrupted gold, failed red until closed or the next send),
  `app/edge-glow.test.ts` (tokens in three blocks, no preset, layer, reduced motion, forced
  colours); chat CSS snapshot updated.
- ac-4: `components/chat/composer-focus.test.tsx` (load, load on a thread, touch load, New
  conversation, Threads panel, another field, the rules).
- ac-5: `e2e/browser/tests/composer-focus.spec.ts` (load, two threads from Threads, New
  conversation, palette; Pixel 7 load), not run here (needs gate1). The gold glow on a pending
  approval needs a model turn to raise the approval, so it is unit-tested instead (above).
  `memory-quality-nudge.spec.ts` now reads the context meter: below 30% it expects no dot or pulse.
- Checks (one at a time, `TMPDIR=~/tmp`): build, typecheck (incl. `e2e/browser` tsc), lint,
  format:check, web unit suite 480 files / 4424 tests passed (theme guard `app/theme-css.test.ts`
  and `app/edge-glow.test.ts` among them), `@kaiju/guide` tests 33 passed, public hygiene, site
  wording and rename guard ok.
