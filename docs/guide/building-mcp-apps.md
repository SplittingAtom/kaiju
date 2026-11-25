---
title: Building MCP Apps for Kaiju
summary: For developers of MCP Apps (ui:// templates) that run in Kaiju, what the host offers over the bridge, the names Kaiju uses for its own extensions (the item-kind _meta key, the pointer-drag notifications, the host name) and the old names it still accepts until a later release.
section: Connectors and apps
order: 2
audience: admin
---

Kaiju shows MCP Apps (the `ui://` templates of a connector's tools, protocol 2026-01-26) in a
sandboxed frame with an opaque origin. The app talks to Kaiju only over the frame's
`postMessage` bridge; members see these apps as described in
[Connectors and apps](connectors-and-apps.md). This page is for the people who build such apps.

## What the bridge offers

- **`ui/initialize`** answers with `hostInfo` `{name: "kaiju", version: "1"}`, the host
  capabilities (`serverTools`, `logging`, `message` with text, `updateModelContext` with text and
  structured content) and the host context (theme, display mode, size, locale, and
  `availableDisplayModes` `inline` and `fullscreen`). It carries no member or team identifiers.
  Decide what to do from the capabilities and the context, not from the host name.
- **`tools/call`** and **`tools/list`** go through Kaiju's server, which decides every call like
  any other tool call (approvals included).
- **`ui/message`** puts text, or items (below), into the member's message draft. Kaiju never sends
  it for the member.
- **`ui/update-model-context`** shows a context chip (at most 8 KiB).
- **`ui/request-display-mode`** (`inline` or `fullscreen`), `ui/notifications/size-changed` and
  logging notifications (dropped).
- Everything else, `ui/open-link`, `ui/download-file`, `resources/*`, `sampling/*` and
  `elicitation/*` included, is refused with JSON-RPC error `-32601` and
  `data.reason: "not_allowed_in_kaiju"`.

Limits per frame: 40 messages per second, 64 KiB per message, 10 requests per second, one tool
call at a time (at most 4 waiting), results up to 4 MiB, `ui/message` text up to 4 KiB.

## Items in the draft

A `ui/message` whose content holds MCP `resource_link` blocks puts each link in the draft as a
removable chip instead of the text (at most 20, unique by `uri`). Kaiju reads `uri` (a scheme
first, at most 2048 characters; `javascript:`, `data:` and `vbscript:` are refused), `name` (at
most 200 characters, no backtick or control characters; this is what the model sees) and the
item's kind from `_meta["io.kaiju/item-kind"]`, which picks the chip's icon: `catalog`,
`namespace`, `schema`, `table`, `view`, `column`, `file`, `folder`, `query`, `dashboard` or
`document`. Any other value, or none, shows a generic item.

Send a text block before the links as well: a host that does not show chips still gets the text.

## Dragging an item out of the frame

Browsers do not deliver a native drag from a sandboxed frame to the page around it, so an app
drives the drag with captured pointer events and tells Kaiju over the bridge with four
notifications (no `id`; coordinates are the pointer's position in the frame's viewport, in CSS
pixels, and may be negative or beyond the frame):

| Notification                      | Params              | When                                       |
| --------------------------------- | ------------------- | ------------------------------------------ |
| `kaiju/notifications/drag-start`  | `{item, x, y}`      | The press became a drag (the item ≤ 8 KiB) |
| `kaiju/notifications/drag-move`   | `{x, y}`            | The pointer moved                          |
| `kaiju/notifications/drag-end`    | `{x, y}`            | The pointer was released                   |
| `kaiju/notifications/drag-cancel` | `{}` (or no params) | Escape, a lost capture, the frame hidden   |

Kaiju draws the dragged chip and lights the composer while the pointer is over it; a release over
the composer adds the same chip a click would. A move, end or cancel without a live drag is
ignored, and a new start replaces the live drag. Today the composer takes a dragged item in the
Lakehouse item shape `{kind, catalog, namespace?, name?, identifier, uri}`.

## Names before the rename

Kaiju was called Kobe before, and apps built then use the old names. Kaiju still accepts them,
exactly like the new ones, so those apps keep working with no change:

| New name (use this)               | Old name, still accepted         |
| --------------------------------- | -------------------------------- |
| `_meta` key `io.kaiju/item-kind`  | `io.kobe/item-kind`              |
| `kaiju/notifications/drag-start`  | `kobe/notifications/drag-start`  |
| `kaiju/notifications/drag-move`   | `kobe/notifications/drag-move`   |
| `kaiju/notifications/drag-end`    | `kobe/notifications/drag-end`    |
| `kaiju/notifications/drag-cancel` | `kobe/notifications/drag-cancel` |
| `hostInfo.name` `kaiju`           | was `kobe` (sent, not read)      |

- When a link carries both keys, the new one wins.
- An app may send each drag notification under both names while it moves over: Kaiju keeps one
  drag per frame whichever name a message uses, so the item is dropped once.
- Kaiju sends nothing under the old names; `hostInfo.name` is `kaiju` only.

**Removal plan.** The old names will be removed in a later release, once the apps that use them
(Catalyst's) have switched to the new ones. That removal is tracked on its own and will be
announced in [What's new](whats-new.md) beforehand. Switch to the new names now.

## Related

- [Connectors and apps](connectors-and-apps.md)
- [Site admin overview](admin/site-admin.md)
