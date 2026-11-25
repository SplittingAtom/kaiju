---
title: The Context panel
summary: How to see exactly what the model was sent in a conversation, read it formatted or raw, filter it by kind, collapse sections, check how many tokens memories use, and download it.
section: Chat and threads
order: 4
audience: member
---

The Context panel shows what your conversation's latest model call sent the model: the system
prompt, agent instructions, skills, memory, the file you were viewing, tool definitions, the
messages and tool results, each as its own section with its token count. Open it by clicking the
context gauge under the message box. Only you, the conversation's owner, can open it: people the
conversation is shared with cannot.

The panel reads the context live from your sandbox when it opens (waking it first if it was
asleep) and keeps nothing. **Refresh the context** reads it again after another message.

## The two sides

- **The text**, on the left (below the gauge on a phone): every section under a heading such as
  "System prompt · rules · 1.2k tokens", in the order the model saw them. **Search the context**
  marks matches; Enter and Shift+Enter step through them.
- **The gauge**, on the right: the model's context window as a bar, filled by kind, with a list
  of the kinds below it, each with its tokens and its share of the window, and the free space.

## Formatted or Raw

**Formatted** (the default) lays out YAML, XML, HTML and JSON so they are easier to read: indented
and coloured, whether a section is entirely one of them or holds one inside it (a fenced code
block, YAML front matter, or a tagged block such as the system prompt's `<rules>` sections).
Anything else stays as written. **Raw** shows exactly the text sent to the model, character for
character. Your browser remembers which one you chose. Formatted is a reading aid: it may tidy
spacing, quotes or stray closing tags, so use **Raw** when the exact text matters, for example to
spot instructions slipped into a page or file. Sections are formatted as they come into view.

Formatting is for reading only. Context text comes from tools, files and web pages, so the panel
never runs it: HTML is shown as its tags and text, never as a page; scripts are text; nothing is
loaded from the internet; entities such as `&amp;` stay as written. A block that does not parse is
shown as written. Very long sections (and long YAML) are shown as written too, to keep the panel
fast. If the panel ever cannot show a context formatted, it says so and offers **Show it raw**.

## Filter by kind

Click a kind in the gauge's list (or its part of the bar) to show only that kind in the text: its
part of the bar is outlined, the rest fade, and the text says "Only Memory (2 sections)" with
**Clear filter**. Click the same kind again, or **Clear filter**, to see everything. The list's
rows are buttons, so Tab, Enter and Space work too, and screen readers announce the change.

## Collapse sections

Click a section's heading to collapse it to the heading and its token count; click again to open
it. **Collapse all** and **Expand all** do it for every section, which makes a long context easy to
scan by size.

## How many tokens memories use

**Memory** is always in the gauge's list with its tokens, even when the call had none (it then
shows 0 tokens). It adds up every memory section the model got: your saved memory, What Kaiju
knows and the memories picked for the message. The memory tools' own definitions count under
**Tool definitions**. After your sandbox restarted, the panel may only be able to rebuild the
context from the conversation, and says so; Memory then reads "unknown". **Memories in context**
above the text lists the memories themselves (see [Memory](../memory.md#see-which-memories-a-run-got)).

## Download

**Download the context** saves the whole context as a text file named after the conversation and
the time, such as `kaiju-context-<conversation id>-2026-11-25-090807Z.txt`. It holds the model,
the time of the call, the token total, and every section's heading and exact token count followed
by its raw text: exactly what the panel shows you, shortened sections included, and nothing more.
A filter or collapsed sections do not change what is saved. The file can hold your memories, files
and tool output, so treat it like them.

## Related

- [Writing messages](composer.md)
- [Memory](../memory.md)
