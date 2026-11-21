# KOBE-756: Composer: picking a file with @ becomes a file chip, not text

- **Status:** in review (group 57)
- **Branch / worktree:** `group-57-signin-composer` in `../Kobe-g57`
- **Depends on:** KOBE-223 (picker), KOBE-374 (chips), KOBE-415 (settle after send)

## Plan

The `@` picker uses assistant-ui's `TriggerPopover.Action` with `removeOnExecute` instead of
`Directive`: the library strips the typed `@query` (and one following space), then the pick goes
through the same `mention()` as a Files-tree drop (`useComposerMentionDrop().pick`), so the same
`MentionStore.addChip`, the same refusals and the same notice under the composer. The caret is put
back where the `@` was a frame later (the library only tracks its own cursor state). The input
stays a textarea; the chip goes in the existing `MentionChips` row.

`MentionStore` lost its "picked" set (only the old picker filled it): every mention is a chip.
`contentFor` (markers appended on their own line) and `forText` (`mentions[]` = the chips) are the
existing chip wire format of KOBE-374, so the server's KOBE-223 validation is untouched. A pick now
sends `text\n\n@file(path)` instead of the marker inline where it was typed.

## Decisions

- **Edit-last** of a sent message with mentions: unchanged. The edit box shows the sent text as
  stored (the server already rewrote markers to `/workspace/...` paths), has no chips and no `@`
  picker, and the edit is sent as written without `mentions[]`, exactly as before.
- **Draft restored from storage** (the new-build banner's Reload, KOBE-487, the only draft store):
  the stash keeps the chips' paths with the text (`{ text, mentions }`; old plain-text entries
  still read) and restores them with `MentionStore.restore`, which re-checks each path as a pick
  (storage is untrusted): refused names dropped, no duplicates, at most 20. A chips-only draft is
  kept too. The fork prefill (`takeComposerDraft`) carries text only, as before.
- **Hand-typed or pasted `@path` / `@file(...)` text**: stays text and is sent as written, without
  `mentions[]`, exactly as today. A typed `@file(x)` for a path that is also chipped is not
  appended twice (unchanged `contentFor` rule).
- **Picking a file already chipped**: no second chip; the typed `@query` is still removed.
- **20-mention limit**: the 21st pick is refused with the drop's message (`MENTION_LIMIT_REFUSED`)
  under the composer and the text stays exactly as typed (review follow-up: the picker decides
  the edit itself from the input's text, without `removeOnExecute`). Same for a refused name.
- **Focus**: a click on an option keeps the focus in the input; removing a chip returns it there.
  The caret is set by the picker a frame after the edit (assistant-ui only tracks its own cursor
  state; the caret test fails without it).
- **Folders / unmentionable names**: the picker never offers them (unchanged); `mention()` refuses
  them anyway with the drop's messages, leaving the typed text.
- **Escape** closes the list and leaves the typed text. **Enter/Tab** pick; Shift+Tab does not.
- **IME composition**: assistant-ui ignores composition keys before the picker's keyboard handler,
  so an Enter that commits a composition never picks; Backspace-removes-chip also skips composing
  keydowns (`isComposing`, keyCode 229).
- **Backspace in an empty input** (caret at 0, no modifier) removes the last file chip (only
  mention chips, not attachments or app chips).

## Open questions (for Chris or the coordinator)

- None.

## Evidence (acceptance criteria → test or command output)

- ac-1: `components/chat/mention-picker.test.tsx` (Enter pick: text, caret, chip text and title),
  `mention-pick-chip.test.tsx` (Tab, mid-text caret).
- ac-2: same tests assert the POST `content` (`…\n\n@file(path)`) and `mentions[]`; server untouched.
- ac-3: `mention-pick-chip.test.tsx` (duplicate, 21st refused with `MENTION_LIMIT_REFUSED`);
  folder/name refusals share `mentionRefusal` (`lib/chat/mention-insert.test.ts`).
- ac-4: `mention-pick-chip.test.tsx` (edit-last, restored draft, hand-typed `@path`),
  `lib/chat/mentions.test.ts` (`restore`), `lib/build/reload-draft.test.ts` (stash shape).
- ac-5: component tests above (pick, remove, duplicate, Escape, Enter, Tab, Backspace, IME);
  browser spec `e2e/browser/tests/file-mentions.spec.ts` updated to expect the chip (runs on the
  test install).
- ac-6: `docs/guide/chat/composer.md` "Mention a file" rewritten.
