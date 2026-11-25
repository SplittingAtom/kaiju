# KOBE-829: RN-16: MCP Apps names io.kaiju/\* and kaiju/notifications/\*, old names accepted

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (no PR yet; branch only)
- **Branch / worktree:** `group-134-rename-16-apps` in `../Kobe-g134`, stacked on
  `group-133-rename-15-local-models` (KOBE-828, PR #730) on KOBE-827 (PR #729)
- **Spec:** `docs/specs/rename-kaiju.md` §11 answer A6 (new names; the old ones still accepted);
  tooling `scripts/rename/README.md`

## Which way each name travels

Read from the code (`apps/web/lib/apps/host-bridge.ts`, `bridge-schema.ts`, `app-items.ts`,
`lakehouse-drop.ts`) and from Catalyst's app sources (`mcp/app/src` of the Catalyst platform
repository, read 2026-11-25; nothing of it is copied here):

| Name                              | Direction                                                           | Catalyst today                                                    |
| --------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `_meta` `io.kobe/item-kind`       | app → Kaiju                                                         | sends it on every picker `resource_link` (`model.ts`)             |
| `kobe/notifications/drag-*`       | app → Kaiju                                                         | sends the four (picker `pickerBridge.ts`, CAT-247)                |
| `hostInfo.name` `kobe`            | Kaiju → app                                                         | never read: the apps use `getHostCapabilities` / `getHostContext` |
| deny reason `not_allowed_in_kobe` | Kaiju → app                                                         | never read                                                        |
| `kobe-reference:` uri             | browser-internal stand-in for re-shown chips; never leaves the page | n/a                                                               |

Kaiju sends no `_meta` key and no drag notification to apps (host → app is only
`tool-input`, `tool-result`, `host-context-changed` and `ui/resource-teardown`). So "send both"
has nothing to apply to for the `_meta` key and the notifications; the question of an app acting
twice on a duplicated host → app notification does not arise.

## Decisions, per name

- **`_meta` item kind.** New `io.kaiju/item-kind` (`ITEM_KIND_META_KEY`); the old
  `LEGACY_ITEM_KIND_META_KEY` is read, never written. `itemKindOfMeta` reads the new key when it
  holds a string, else the old one (own properties only). Both present: the new one wins.
  Kaiju's own producer (`lakehouseItemContentOf`, a native or bridge drop turned into the click's
  content) writes only the new key; it is consumed in the page by the same reader.
- **Drag notifications (receive).** New `kaiju/notifications/drag-{start,move,end,cancel}`
  (`DRAG_METHODS`), old ones in `LEGACY_DRAG_METHODS`. `dragPhaseOf` maps exactly these eight
  strings (one `Map`, no prefix or case folding) to the phase; everything downstream (state
  machine, budget exemption for a live drag's end/cancel, size cap, zod schemas) works on the
  phase, so both names are treated identically and the accepted set is the old four plus their
  four renames, nothing wider (test: other cases, prefixes and spellings are dropped).
  **Double handling:** one live drag per frame whatever name a message uses. An app sending
  each phase under both names gives start, (cancel, start of the same item), moves twice at the
  same point, one end; the second end finds no live drag. One drop (test "drops once"). No
  handshake negotiation is needed, and a handshake flag would not help Catalyst's apps, which
  send no capability for it.
- **Host name.** One value only: `hostInfo.name` is `kaiju` (`HOST_NAME`). Catalyst's apps never
  read it (only the SDK stores it), the e2e fake app and the gate-apps client do not either, and
  the MCP Apps spec makes it informational (behaviour follows `hostCapabilities`). Keeping `kobe`
  would leave the old name in the one value new apps see; switching costs Catalyst nothing.
- **Deny reason.** `data.reason` is `not_allowed_in_kaiju` (one value; no reader found). The
  in-browser chip stand-in is `kaiju-reference:` (never persisted, never sent).
- **Security.** Unchanged: origin `"null"` and `event.source` = the bound frame, checked before
  any parsing; the method table is exact; the old names reach the same handlers with the same
  parsing and limits.

## Tests

- `packages/protocol/src/item-references.test.ts`: both keys, new first, non-string new key,
  unknown names and prototype keys generic.
- `apps/web/lib/apps/host-bridge-drag.test.ts`: every KOBE-553 case runs under both name sets
  (`describe.each`); plus both names at once (one drop), mixed names in one drag, the budget
  exemption across names, and exactly the two prefixes.
- `host-bridge.test.ts`: a Catalyst-shaped `ui/message` with the old key and one with the new,
  `hostInfo.name` `kaiju`, the deny reason. `host-bridge.interop.test.ts` (the ext-apps `App`
  against the bridge): host version `kaiju`.
- `app-items.test.ts`: kind under either key; `frame-drop-equivalence.test.ts`: drag over both
  prefixes leaves the click's chip snapshot.
- e2e: `e2e/lib/fake-mcp.js` sends the table link under the new key and the namespace link under
  the old one, so `app-item-chips.spec.ts` covers both live. `frame-drag.spec.ts` and
  `lakehouse-drop.spec.ts` use the real Catalyst picker (old names). `e2e/gate-apps/client.mjs`
  names none of these. No `*.real*` test touches the bridge (they are all sandbox-agent).

## Rename tooling

Feature commit first (with a permanent group for the kept old names), then
`scripts/rename/steps/RN-16.txt` = the old group's two patterns (`io.kobe/…`,
`kobe/notifications/…`); the `name: "kobe", version` and `kobe-reference:|not_allowed_in_kobe`
entries were removed after the hand edits (they owned nothing). Applied
(`rename.mjs --apply --step RN-16`): 6 occurrences in 5 files (tests, a comment). RN-16 group
removed; the permanent group (spec §11 A6) keeps the protocol constant, the bridge's old method
table, two comments, the tests and e2e fake that send old names and the guide page. Guard and
self-test ok.

## Docs evaluation

App developers see the names, so the guide changes in this PR:

- New page `docs/guide/building-mcp-apps.md` (Connectors and apps, audience admin): what the
  bridge offers and refuses, limits, items and the kinds, the pointer-drag notifications, the
  new and old names, how both are handled, and the removal plan (ac-2).
- `connectors-and-apps.md` links it; `whats-new.md` has one paragraph under "Kobe is now Kaiju".
- Members and in-sandbox agents see nothing different (chips, drags and pickers behave the
  same), so no other page changes.

## Follow-up (coordinator files it)

A ticket to remove the old names (`LEGACY_ITEM_KIND_META_KEY`, `LEGACY_DRAG_METHODS`, their
tests, the fake app's old-key link, the guide's table row and the permanent allowlist group)
once Catalyst sends the new names (Catalyst-side change tracked with Chris). Not part of
KOBE-754: it depends on Catalyst's release, not on the one-release window.

## To check live on gate1 (ac-1)

With the current Catalyst apps (old names): Lakehouse Picker in the rail, click a table, a view,
a namespace and a catalog (each chip shows its kind's icon, not the generic box); pointer-drag a
row onto the composer (ghost, composer cue, one chip, no duplicate) and press Escape mid-drag
(cancel); Workspace picker click (workspace/project/application chips show generic icons, as
today: those kinds are not in Kaiju's vocabulary). New names: run `app-item-chips.spec.ts` with
`FAKE_MCP_APPS=1` (table under the new key, namespace under the old). When Catalyst ships the new
names, repeat the picker checks.
