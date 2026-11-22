# KOBE-772: split Composer, the agent Builder and useEditorState

Pure refactors in `apps/web`; no props, DOM, aria, keys or effect dependencies changed.

- **Composer** (`components/chat/composer.tsx`, 606 -> 259 lines, function 196): key handlers, queue
  send and drag handlers moved to `composer-handlers.ts` (plain functions built per render, as
  before); JSX parts to `composer-parts.tsx`; `useAppInserts` and `settlesInsert` to
  `composer-app-inserts.ts`, re-exported from `composer.tsx` so imports are unchanged.
- **Builder** (`agent-builder-page.tsx`, 539 -> 323 lines): `builder-model.ts` (scope table,
  baseline, restore notes, errors hook), `builder-sections.tsx` (notices, form, tools),
  `builder-lifecycle.tsx` (eval, publish, quality, history). The Builder function is ~218 lines.
- **useEditorState** (`use-draft-editor.ts`, 368 -> 170 lines): `use-draft-writer.ts` (queue,
  autosave, leave flush), `use-draft-file-ops.ts` (edit/open/add/remove/share/manifest),
  `draft-editor-model.ts` (constants, re-exported). Effects keep their relative order; the refs the
  writer owns are created after the scan hook (no behavioural effect).
- **Tests:** 174 passing before and after (composer, agent-builder, skills), unchanged.
- **Docs:** no `docs/guide` change: nothing a member, admin or agent sees or can do changed.
