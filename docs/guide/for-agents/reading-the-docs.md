---
title: How AI agents should read these docs
summary: How an AI agent reads Kaiju's documentation, through the kaiju connector's docs tools inside a sandbox or as llms.txt, llms-full.txt and one Markdown file per page outside Kaiju.
section: For agents
order: 1
audience: agent
---

This page is for AI agents and the tools that feed them: agents running inside a Kaiju sandbox,
assistants answering questions about Kaiju from outside, and crawlers building a knowledge base.
The same guide people read in Kaiju's docs viewer is served as plain Markdown so you can read it
without parsing HTML.

## Inside a Kaiju sandbox: the kaiju connector's docs tools

Every agent in Kaiju has the built-in **kaiju** connector with four docs tools, whatever connectors
the agent itself lists. They hold no one's data, never ask for approval and work in every run,
scheduled runs included. Pi names them `mcp__kaiju__<tool>` (on some sites the connector is
called `kaiju-builtin`). Before the rename they were `mcp__kobe__<tool>`; if an earlier message
uses that name, call the `mcp__kaiju__` one.

| Tool          | What it returns                                                                       |
| ------------- | ------------------------------------------------------------------------------------- |
| `docs_index`  | The index, exactly as `/llms.txt` below.                                              |
| `docs_page`   | One page as Markdown, by its slug (for example `memory` or `admin/team-admin`).       |
| `docs_search` | Pages whose titles, summaries or headings match a query, ranked, with slugs and URLs. |
| `docs_full`   | One section's pages in one text; the whole guide only while it fits one result.       |

The **kaiju-guide** skill, which Kaiju installs in every team, says how to use them: for any
question about using or administering Kaiju, start with `docs_index`, read the pages that fit with
`docs_page` (or find them with `docs_search`), answer from the guide rather than from memory, and
cite the pages' URLs. Do not fetch the docs over the internet from a sandbox: the docs tools are
the source and need no internet access.

When someone asks you to change something in Kaiju, use the kaiju connector's admin tools only if
they are listed for you. They act as that person, with their permissions, and every change shows
them an approval card first; see
[Working inside a Kaiju sandbox](working-in-a-sandbox.md#the-kaiju-connector). If they are not
listed, answer from the guide and tell the person where in the console to do it.

## Outside Kaiju: llms.txt and Markdown pages

All paths are on the same address as the Kaiju site itself.

| Path              | What it is                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `/llms.txt`       | The index, in the llms.txt format: one line per page with its title, link and one-sentence summary, grouped by section.         |
| `/llms-full.txt`  | Every page's full text in one file, in section order.                                                                           |
| `/docs/<slug>.md` | One page as Markdown. The slug is the page's path, for example `/docs/memory.md` or `/docs/for-agents/working-in-a-sandbox.md`. |
| `/docs/<slug>`    | The same page for people, in the Docs panel over the conversation.                                                              |

## How to use them

1. **Start with the index** (`docs_index`, or `/llms.txt`). Each line's summary says what question
   the page answers. Pick the pages that match the user's question.
2. **Read only what you need**, one page at a time (`docs_page`, or `/docs/<slug>.md`). Prefer this
   over the full text when your context is limited.
3. **Use a section's full text** (`docs_full` with `section`) when you need much of one area at
   once, for example to answer many questions in a row. Without a section it returns the whole
   guide (as `/llms-full.txt`) only while that fits one result, and otherwise `too_large` with
   the section names.
4. **Follow the links.** Links between pages are absolute links to the pages' `.md` files; with
   the docs tools, pass the part after `/docs/` to `docs_page`.

Each page starts with its title as a heading and its one-sentence summary as a quote. Pages for
admins describe settings only team or site admins can change: when you answer a member, say that
an admin has to do it rather than telling them to do it.

## What the docs cover and what they do not

The guide describes what Kaiju does for its users: conversations, files, projects, agents, skills,
connectors, memory, internet access, approvals, models and administration. It does not describe a
particular organization's setup: which models, connectors, websites or skills your site enables,
its budgets or its policy rules. Those differ per site and per team. When a question depends on
them, say so and suggest the user checks with their team admin, or look at what your own tools and
context show you.

If something on screen contradicts the docs, trust the screen and say the docs may be out of date.

## If you are running inside a Kaiju sandbox

Read [Working inside a Kaiju sandbox](working-in-a-sandbox.md) first: it says what your tools can
and cannot do and how to ask the user for access. [Concepts for agents](concepts.md) maps Kaiju's
words to your tools and paths.
