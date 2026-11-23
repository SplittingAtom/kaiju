---
title: Editing files
summary: How to open, edit and save files in the editor, use Save As and the Rendered/Raw switch, and review the agent's proposed edits.
section: Files and editing
order: 2
audience: member
---

Files open in the editor in the artifact column. You and the agent can both work on the same
file: you edit and save it yourself, and the agent either writes it directly or proposes a change
for you to review. This page covers the editor, saving, and reviewing proposals.

## Open a file

- Click a file in the Files panel, or use **Open** in its **⋯** menu.
- Ask the agent to open it: it shows the file in a tab for you ("Opened _file_", with **Open
  again** on the card later).
- **Edit as file** on a text artifact (Markdown, code, CSV) copies it into My files as
  `artifacts/<name>`, where you can edit it like any file.

Text files up to 1 MB open in the editor; larger ones open read-only. Other types open in their
viewers.

## What opens how

| File                                                | Opens in                                                    |
| --------------------------------------------------- | ----------------------------------------------------------- |
| Text, Markdown, CSV, JSON, code (up to 1 MB)        | The editor (larger files: the first 1 MB, read-only)        |
| Notebooks (`.ipynb`)                                | The notebook view. See [Notebooks and Python](notebooks.md) |
| PDF (up to 25 MB)                                   | The PDF viewer (below)                                      |
| Images (PNG, JPEG, GIF, WebP) and SVG (up to 10 MB) | The image viewer                                            |
| HTML (up to 1 MB)                                   | A locked-down frame with no network access                  |
| Anything else, or a file over its limit             | A note saying why, with **Download**                        |

This holds wherever the file lives: My files, a project, or a file you attached to a message
(`uploads/`).

## The PDF viewer

PDFs open in a viewer inside Kobe; nothing is sent anywhere else and the file's own scripts never
run. The toolbar above the pages has:

- **Previous page** and **Next page**, a **Page number** box (type a number and press Enter) and
  the page count.
- **Zoom out**, the zoom level and **Zoom in**.
- **Fit to width** (the default) and **Fit page**. Both follow the column when you resize it.
- **Find in document** opens a search row: type a word to see "_n_ of _m_" matches highlighted on
  the pages; **Next match** (Enter), **Previous match** (Shift+Enter) and **Close find**
  (Escape).

You can select and copy the text of a page. Web and email links in the PDF open in a new browser
tab, the same way links in the chat do; links to another place in the document jump to its page;
any other kind of link does nothing. Long documents load page by page as you scroll. The viewer
shows at most the first 2,000 pages of a document; a longer one says so, with **Download** for
the whole file. Very large pictures inside a PDF (over 16 megapixels) are left blank.

With the pages focused (click them, or Tab to them) the keys are: **Mod+F** find, **Mod+=** and
**Mod+-** zoom, **Mod+0** fit to width, and Page Up, Page Down, the arrow keys, Home and End to
scroll.

A PDF that is password-protected, damaged, or larger than 25 MB is not shown: the tab says why and
offers **Download**. Use **Download** in the tab's header any time for the file itself.

## The image viewer

PNG, JPEG, GIF, WebP and SVG files open in the image viewer, over a checkerboard so you can see
transparent areas. SVG files are shown as pictures: anything scripted inside them never runs. The
toolbar has **Zoom out**, the zoom level, **Zoom in**, **Fit to width** (the default; a small image
stays at its actual size) and **Actual size**, followed by the image's size in pixels and the
file's size. When the image is larger than the column, drag it to pan, or click it and use the
arrow keys. The keys **Mod+=**, **Mod+-** and **Mod+0** (fit to width) work too.

## Files over the preview limits

Each kind of file has a limit: text 1 MB (a larger text file opens with its first 1 MB, read-only),
images and SVG 10 MB, HTML 1 MB, PDF 25 MB. Over its limit the tab names the file's size and the
limit, for example "This file is too large to preview (12 MB). Images over 10 MB are not
previewed.", with a **Download** button.

## The editor toolbar

The editor fills the artifact column, and one toolbar at the top holds its controls:

- **Save** saves your changes. Each save names the version it started from, so it never overwrites
  someone else's change by accident.
- **Save As** saves the editor's text, unsaved changes included, to a new path you type (by default
  `<name>-copy` beside the file). If a file is already there, Kobe asks "already exists. Replace
  it?" first. The tab then moves to the copy. Read-only files (a project file you cannot commit, a
  thread upload) offer Save As but not Save; the copy goes into My files.
- The **Rendered/Raw** switch shows Markdown and similar files rendered, or as raw text to edit.
  Most files open Rendered; a `.py` file opens Raw, in the code editor with the cursor ready, and
  Rendered is one click away. Your choice for a file stays while this page is open. A read-only
  Python file (a project file you cannot commit, one over 1 MB) also opens Raw, read-only, with the
  reason shown above it.
- For a `.py` file: **Run**, **Run selection**, **Stop** (while code runs), **Start** or
  **Restart**, the run's clock and the kernel's state. See [Notebooks and Python](notebooks.md).

Under the text, a small bar shows the cursor's line and column ("Ln 3, Col 5") and a **Wrap**
button for long lines. Wrap is on by default; turning it off makes long lines scroll sideways, and
Kobe remembers your choice on every device. In the raw text, **Mod+S** saves, and **Find**
(Mod+F), **Find next**, **Replace** and **Go to line** work with the keyboard; see [Keyboard
shortcuts](../reference/keyboard-shortcuts.md).

The file's header also has **Copy path**: it copies the path the agent sees in its sandbox
(for example `/workspace/notes/plan.md`), the same one an `@` mention uses, and says "Path copied".

On a narrow column Save As (and for a `.py` file Run selection and Show run pane) moves into the
**More file actions** menu. A disabled button says why
in its tooltip.

## Review the agent's proposed edit

When you have a file open, the composer shows "Viewing _file_" and the agent is told to propose
changes to it instead of writing it. A proposal writes nothing until you commit it.

1. The conversation shows a "Proposed edit to _file_" card with **Review**. Turn on **Open edits
   automatically** on the card to open every new proposal for review as it arrives.
2. The editor shows a gold **Proposed edit** bubble with the agent's summary. The row under it
   steps through the changes (Previous, Next, "Change N of M") with **Accept** and **Reject** for
   the current change, then **Commit all** and **Discard all**.
3. In the text each change also has its own buttons: a green check (Accept change) and a red cross
   (Reject change).
4. You can keep typing while you review. **Commit all** saves exactly what you see.

In a project conversation an editor's agent can propose edits to the project's files; there
**Accept** commits the change to the project, with the agent's summary as the commit message (you
can edit it first). A reader's agent cannot propose project edits.

If the file changed after the proposal, the review offers only **Discard**; ask the agent to
propose again. Proposals stay available for 7 days after their run.

## When the file changes under you

- If the agent of this conversation writes the open file and you have no unsaved changes, the tab
  updates by itself.
- Any other change (another tab, another device, another conversation) shows a note at the top:
  "_who_ changed this file _when_" with **Reload**.
- If you have unsaved changes and save over a newer version, nothing is saved and the editor offers
  **Compare** (review the difference change by change), **Keep mine** and **Take theirs**.
- If the agent wrote the file before your save reached it, your version wins and the agent's
  version is kept beside it as `<name>.conflict-<time>`. The agent is told.

## Good habits

- **Save before you ask for a change.** The agent sees only saved text, never your draft.
- **Keep the file open when you want to review every change.** The agent then proposes instead of
  writing; it is not allowed to write the viewed file directly with its file tools. This guard does
  not cover shell commands or Python.
- **Let the agent write directly** for new files, generated output and bulk changes.
- Unsaved drafts live in this browser tab: a full page reload loses them (Kobe warns first).

## Read-only places

`projects/` (unless you have the project checked out) and `uploads/` are read-only: Save is
refused and the editor says so. See [Workspaces, My files and projects](workspaces-and-projects.md).
