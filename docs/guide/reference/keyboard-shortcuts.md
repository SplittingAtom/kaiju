---
title: Keyboard shortcuts and the command palette
summary: Every keyboard shortcut in Kobe and how to use the command palette (Ctrl+K or Cmd+K) to search actions, threads and files.
section: Reference
order: 1
audience: member
---

Almost everything in Kobe can be done from the keyboard. The command palette finds any action,
thread or file by name, and a set of fixed shortcuts covers the most common actions. Shortcuts
cannot be changed.

## The command palette

Press **Ctrl+K** (**Cmd+K** on a Mac), or type `/search` in the message box, to open **Search
actions, threads and files**. Type a few letters of what you want (an action like "Archive", a
thread's title, a file name) and press Enter. Actions that cannot run right now say why.

Press **?** (when you are not typing in a text box) or type `/shortcuts` to see the shortcuts
sheet.

## Shortcuts

"Mod" is **Cmd** on a Mac and **Ctrl** elsewhere.

| Keys                               | Action                                                               |
| ---------------------------------- | -------------------------------------------------------------------- |
| Mod+K                              | Search actions, threads and files                                    |
| ?                                  | Keyboard shortcuts                                                   |
| Mod+Shift+O                        | New conversation (Mod+N also works when Kobe is installed as an app) |
| Mod+B                              | Collapse or expand the rail                                          |
| Mod+Shift+F                        | Show the files                                                       |
| Mod+Shift+A                        | Show or hide the artifact column                                     |
| Mod+Shift+D                        | Show or hide all details in the answers                              |
| Mod+[ and Mod+]                    | Previous and next conversation                                       |
| Mod+/                              | Go to the message box                                                |
| Enter                              | Send (queued while the agent works)                                  |
| Shift+Enter                        | New line                                                             |
| Mod+Shift+Enter                    | Steer now: pass the message to the running agent                     |
| Mod+.                              | Stop                                                                 |
| Mod+Shift+E, or Up in an empty box | Edit your last message                                               |
| Mod+Shift+L                        | Learn from this chat (new messages since the last pass)              |
| @                                  | Mention one of your files in the message                             |
| /                                  | Slash commands, at the start of the message box                      |

## In the code editor

When the cursor is in a file's raw text, these work like in most code editors (they also appear in
the `?` sheet):

| Keys        | Action                                                |
| ----------- | ----------------------------------------------------- |
| Mod+S       | Save the file                                         |
| Shift+Enter | Run a `.py` file, or only the selected lines          |
| Mod+Enter   | Run the whole `.py` file (in a notebook cell: run it) |
| Mod+F       | Find (the panel has next, previous, Replace)          |
| Mod+G       | Find next                                             |
| Shift+Mod+G | Find previous                                         |
| Mod+Alt+F   | Replace: opens the panel in the Replace field         |
| Mod+Alt+G   | Go to line (also `+5`, `-5`, `50%`, `12:4`)           |
| Escape      | Close the find panel                                  |

## In panels and lists

- **Escape** closes menus, dialogs, the Threads panel's file lists and the conversation tree.
- In the conversation tree, the arrow keys move between nodes; Home and End jump to the first and
  last.
- Splitters (the Threads panel's workspace rail, a Python file's output) move with the arrow keys
  and Page Up/Down; Home and End go to the ends and Enter goes back to the default.
- A Python file's run pane (Run Output, Log, Variables) is a set of tabs: Left and Right move
  between them, Home and End go to the first and last.
- Menus and tabs follow the usual arrow-key navigation.
- In the PDF viewer, with the pages focused: Mod+F finds in the document (Enter and Shift+Enter
  step through the matches, Escape closes the search), Mod+= and Mod+- zoom, Mod+0 fits the width.
  See [Editing files](../files/file-editor.md#the-pdf-viewer).
- In the image viewer: Mod+= and Mod+- zoom, Mod+0 fits the width, and the arrow keys pan a zoomed
  image. See [Editing files](../files/file-editor.md#the-image-viewer).

## Slash commands

The full list is in [Writing messages](../chat/composer.md).
