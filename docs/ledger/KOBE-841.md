# KOBE-841: Context panel: readable formatting, Formatted/Raw, download, legend filter, collapse, memory row

- **Status:** in review (committed on the branch; coordinator pushes and opens the PR)
- **Branch / worktree:** `group-143-context-panel` in `../Kobe-g143`
- **Depends on:** KOBE-470/471 (context viewer), KOBE-382 (memories in context)

## Plan

Web only. The route (`GET /v1/threads/{id}/context`) already returns every section in full
(capped per CV6), so no server or protocol change: formatting, filter, collapse and download all
work on the answer the panel already holds.

## Decisions

- **Own tokenizer, no new dependency.** `apps/web/lib/chat/context-format/`: `markup.ts` is a
  small XML/HTML tokenizer and tree builder that only produces text tokens. It never expands an
  entity (`&xxe;`, `&lt;` stay as written), shows a DOCTYPE with its internal subset as one
  declaration and never reads it, treats `<script>`/`<style>`/`<textarea>`/`<title>` bodies as
  text, and caps depth (64) and node count (20 000). XML must balance; HTML is lenient (void
  elements, unmatched closes ignored). YAML uses `yaml` (already a web dependency, ISC):
  `parseDocument` then `toString` (aliases printed, never expanded; core schema has no
  code-running tags); any error or a lone scalar falls back to plain. JSON via `JSON.parse` +
  `stringify`. Rejected DOMParser: not needed, and an inert document is still more surface than a
  pure tokenizer.
- **Rendering.** Tokens become `<span class=tk…>` with React text children (`context-line.tsx`);
  no `dangerouslySetInnerHTML` anywhere in the panel. Colours are new theme tokens
  `--kaiju-ctx-syntax-{key,string,number,tag,attr,meta}` in light, chosen-dark and OS-dark blocks.
- **Detection.** Whole text: `{…}`/`[…]` JSON, `<…>` markup (HTML when a doctype or a common
  HTML root, XML otherwise), YAML when every line is a key / list item / comment / continuation.
  Inside text: YAML front matter, fenced ```yaml|yml|json|xml|svg|html blocks (fences shown), and
  line-start `<name …>` … line-ending `</name>` blocks (the system prompt's sections; XML first,
  then HTML). A chat line with inline tags (`<b>x</b> Hello`) stays text.
- **Speed.** Formatting is lazy: done per section the first time it is shown expanded in
  Formatted, cached until the sections change (Refresh); sections over 64 KiB stay plain. The row
  virtualisation (fixed 20 px rows) is unchanged; formatted lines wrap at 160 columns like raw.
- **Toggle.** Two `aria-pressed` buttons (group "Text view"); `localStorage`
  `kaiju.contextViewer.view`, read and written in try/catch (falls back to Formatted).
- **Download.** Built client-side from the `ThreadContext` on screen (`contextDownload`), so it
  has exactly the route's owner-only access and CV6 cuts; no extra fetch is needed because the
  panel never loads lazily. Header (thread, model, captured, tokens, source/approximate,
  shortened) then `===== n. Kind · label · tokens =====` + raw text per section. Filename
  `kaiju-context-<thread id>-<YYYY-MM-DD-HHMMSSZ>.txt`. Ignores filter and collapse (always whole).
- **Filter.** A legend row (button, `aria-pressed`) or bar segment toggles a filter on that
  gauge kind; the selected segment is outlined and the others fade; the text shows only that
  kind, marks its first section and scrolls to the top; a chip "Only Memory (2 sections)" with
  **Clear filter**; a polite live region announces "Showing only Memory: 2 sections." /
  "Showing every section.". A Refresh's new answer starts unfiltered. This replaces the old
  legend-click "scroll to first section" (the first section is still marked).
- **Collapse.** Section headings are buttons with `aria-expanded` (chevron drawn in CSS so the
  heading text is unchanged); Expand all / Collapse all; state resets on Refresh.
- **Memory.** Today memory is the `memory` section kind (Saved memory, What Kaiju knows, the
  per-message picks; `services/sandbox-agent/src/context/system-prompt.ts`), and the legend
  dropped kinds with no sections. Memory is now always listed (0 tokens, no bar segment), and
  "unknown" when an approximate answer lists `memory` as missing. Memory tool definitions stay in
  Tool definitions (said in the guide).

## Security review fixes (review-g143, verdict "fix first")

- HIGH deep JSON: `jsonDepth` cap (64) before parse, `stringify` in a try, `formatText` and the
  format cache catch everything and fall back to plain; per-line `LineBoundary` and a panel
  `ContextBoundary` ("Show it raw") as defence in depth.
- MEDIUM fence ReDoS: `parseFence` reads fences by hand; closing tags via `lastIndexOf`.
- MEDIUM quadratic search: closers indexed once per text, binary search per opener. Lexer:
  ASCII lower-case once, close tags need `>` right after the name, quoted values looked for
  within 4 KiB. YAML over 16 KiB stays plain (the parser is ~2 ms/KiB).
- MEDIUM eager formatting: `use-lazy-format.ts` formats only sections near the viewport (anchor
  kept while rows change length); search position no longer resets when rows change.
- LOW download: random per-download boundary in every heading, re-drawn if content holds it;
  header states the section count. Focus: Clear filter focuses the text; headings are keyed by
  section and a focused heading stays rendered; pressed legend row says "Show every section".
- Tests: node cap, billion laughs, deep JSON, hostile fences, unclosed openers, lexer worst
  cases, a seeded fuzz (no throw, < 100 ms), 64 KiB timing, 500 KB open < 200 ms, focus.

## Docs evaluation

Member-visible change, so the guide is updated in this PR: new page
`docs/guide/chat/context-panel.md` (The Context panel: sides, Formatted/Raw and its safety,
filter, collapse, memory tokens, download), linked from `chat/composer.md`,
`getting-started/layout.md` and `memory.md`. Spec note in `docs/specs/context-viewer.md` CV9;
token table row in `docs/theming.md`. No "For agents" change: agents in the sandbox never see the
panel. What's new is left to the release-notes ticket.

## Open questions (for Chris or the coordinator)

- None blocking. Browser spec: the context needs a model call, so the new checks ride on the
  existing `e2e/browser/tests/context-viewer.spec.ts` turn; not run here (needs a deploy to gate1).

## Evidence (acceptance criteria → test or command output)

- ac-1: `lib/chat/context-format/context-format.test.ts` (detection, formatting, script / event
  attribute / `javascript:` / external entity / char refs / depth cap / YAML tags+aliases);
  `components/shell/context-panel.test.tsx` "Formatted and Raw" (no script/img/a element, Raw
  exact, remembered across reopen).
- ac-2: `lib/chat/context-panel.test.ts` contextDownload; component test "Download".
- ac-3: component test "the legend filter" (click, segment, announce, Clear, Enter twice).
- ac-4: component test "collapsing sections".
- ac-5: `lib/chat/context-panel.test.ts` memory rows; component tests "the Memory row".
- ac-6: tests above, browser spec extended, guide page.
- Checks: see the commit / report (build, typecheck, lint, format:check, web suite incl. theme
  guard `app/theme-css.test.ts`, wording, hygiene, rename guard).
