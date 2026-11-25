---
title: Writing messages
summary: How to send messages, where the cursor starts, attach files, mention files, use slash commands, ask Kaiju to learn from the conversation, stop or steer a run, what the gold and red glow around the conversation mean, and rate an answer.
section: Chat and threads
order: 1
audience: member
---

You talk to the agent through the message box at the bottom of the conversation, called the
composer. This page covers sending, attachments, mentions, slash commands, stopping and steering a
run, and what you can do with an answer once it arrives.

## Send a message

Type and press **Enter** to send; **Shift+Enter** adds a new line. While the agent is still
working, Enter queues your message: it is sent when the current run ends. Two other buttons appear
during a run:

- **Steer now** (Ctrl+Shift+Enter, Cmd+Shift+Enter on a Mac) passes your message into the running
  agent at its next safe point, without waiting for the run to end.
- **Stop** (Ctrl+. or Cmd+.) stops the run.

In an empty box, the Up arrow edits your last message. Ctrl+/ (Cmd+/) puts the cursor in the
message box from anywhere.

The cursor is already in the message box when the page opens, when you start a **New
conversation** and when you open a conversation from the **Threads** panel, so you can type
straight away. It stays where it is while a dialog or menu is open or when you are typing in
another field, and on a phone or tablet the keyboard doesn't open by itself when the page loads.

## When the conversation waits for you

The edge of the conversation glows gold while the agent is stopped waiting for you: an approval
to decide ("Waiting for your approval", see [Approvals](../internet-and-approvals/approvals.md)),
an interrupted answer to **Retry** or **Continue** ("Interrupted"), or a paused queue to resume
("Queue paused."). The glow stays until you respond. After a run fails, the edge glows red until
you send your next message or close the "The run failed" notice. The words always stay on screen
too; with reduced motion turned on in your system settings the glow doesn't pulse.

## The composer toolbar

- **+** opens **Attach files**, your **Connectors** for this conversation, **Memory** (**Learn
  from this chat**, see [Memory](../memory.md#learn-from-this-chat)), **Skills** and **Apps**. A
  dot, spinner or number on **+** shows where Learn is for this conversation; the red dot appears
  only once the conversation uses more than 30% of its context window.
- The agent picker chooses which agent answers. See [Agents](../agents/agents.md).
- **Model for this conversation** and the thinking level. See [Models](../models.md).
- The project control ("Add to a project", or the project's name) on a conversation not started
  yet. See [Workspaces, My files and projects](../files/workspaces-and-projects.md).

## Attach files

Use **+** → **Attach files**, or drag files onto the composer. By default a file may be up to
100 MiB, a message up to 500 MiB and 100 files; your site can set lower limits. The agent finds
attached files under `uploads/` in your sandbox and can read them but not change them; ask it to
save a changed copy elsewhere.

## Mention a file

Type **@** and part of a file's name, then pick the file from the list (arrows, then Enter or Tab,
or a click; Escape closes the list and leaves what you typed). You can also drag a file from the
Files panel onto the composer, or use **Mention in message** in a file's **⋯** menu. Each way
adds the same file chip above the message box and removes the `@…` you typed: the chip shows the
file's workspace path (hover for where the agent finds it) and **×** removes it. With the message
box empty, Backspace removes the last chip. A file is only mentioned once, a message can mention
at most 20 files, and folders can't be mentioned. When you send, the agent is told each
mentioned file's full path. Text you type or paste yourself, such as `@notes/todo.md`, stays
plain text.

When a file is open in the artifact column, the composer shows a removable
"Viewing _file_" chip: the agent is told which file you are looking at and proposes changes to it
for you to review instead of writing it directly. See [Editing files](../files/file-editor.md).

## Slash commands

Type **/** at the start of the message box. A command that cannot run says why and is never sent
as a message.

| Command                                       | What it does                                    |
| --------------------------------------------- | ----------------------------------------------- |
| `/new`                                        | New conversation                                |
| `/files`                                      | Show the files                                  |
| `/model <model>`, `/thinking <level>`         | Change the model or thinking level              |
| `/compact`                                    | Compact this thread (summarise older turns)     |
| `/session`                                    | This conversation's details and usage           |
| `/export`                                     | Download this conversation as Markdown          |
| `/copy`                                       | Copy the branch on screen as Markdown           |
| `/regenerate`, `/regenerate-with <model>`     | Regenerate the last answer                      |
| `/fork`                                       | Fork to a new thread                            |
| `/move <project>`, `/folder <folder>`         | Move to a project, save to a folder             |
| `/archive`, `/unarchive`, `/share <with>`     | Archive, unarchive or share the thread          |
| `/skill`, `/saveskill <skill>`                | Make a skill from this conversation, or save it |
| `/learn`, `/learn all`                        | Learn from this chat (new messages, or rescan)  |
| `/stop`                                       | Stop the run                                    |
| `/search`, `/shortcuts`                       | Open search or the keyboard shortcuts           |
| `/memory`, `/schedules`, `/agents`, `/skills` | Open My memory, My schedules, Agents or Skills  |

## Working with an answer

- **Copy** copies the answer's text. **Edit** changes one of your messages and runs it again;
  **Regenerate** and **Regenerate with…** (another model) ask again. Each of these starts a new
  version at that point; the arrows ("Previous version", "Next version") switch between them.
  See [Sharing, forks and the conversation tree](sharing-and-branches.md).
- **Show details** opens the steps behind an answer: reasoning and tool cards. Ctrl+Shift+D
  (Cmd+Shift+D) shows or hides all details.
- Answers that include an app show only the app; the rest is behind **Show response**. See
  [Connectors and apps](../connectors-and-apps.md).

## Rate an answer

**Good answer** (thumbs up) and **Bad answer** (thumbs down) sit under each answer; click again to
clear your rating. After a thumbs down, **What went wrong?** offers "Wrong or made up", "Didn't
follow instructions", "Unsafe", "Too slow" or "Other", with an optional comment. In your own
conversation you can also **Share as an eval case…**: the agent's owner gets a copy of that answer
to improve the agent, never your name. Your shared cases are listed in **Profile → My shared
cases**, where **Withdraw** deletes the copy.

## When the conversation gets long

The context gauge under the composer shows how much of the model's context window the thread
uses. Click it to see exactly what the model was sent last time, section by section (only you, the
owner, can see this). When it fills up, Kaiju compacts older turns into a summary; you can also do
it yourself with **Compact now** or `/compact`.
