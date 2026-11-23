---
title: Notebooks and Python
summary: How to run Jupyter notebooks and Python files in your sandbox, control the kernel, and read the output.
section: Files and editing
order: 3
audience: member
---

Kobe runs Jupyter notebooks (`.ipynb`) and Python files (`.py`) in your own sandbox. Each
conversation has one live Python kernel that you and the agent share, so variables and imports
carry from one run to the next. Code never runs on the server or in your browser.

## Before you start

Code runs in a conversation's kernel. Open the notebook or `.py` file while a conversation is on
screen; in a new conversation, send a message first ("Send a message first: code runs in this
conversation's kernel, in your sandbox."). Only the conversation's owner can run code.

The sandbox comes with Python 3.12 and a data stack including pandas, NumPy, DuckDB, PyArrow,
Matplotlib, openpyxl, python-docx, ReportLab and pypdf. Installing more packages needs internet
access to the package index, which your team admins decide (see
[Internet access](../internet-and-approvals/internet-access.md)).

## The kernel

The toolbar shows the kernel's state: "Kernel not started", "Waking sandbox…", "Starting kernel…",
"Kernel idle", "Kernel busy" or "Restarting kernel…".

- **Start** starts a kernel (and wakes a sleeping sandbox). Running code starts one too.
- **Interrupt** (in a notebook) or **Stop** (in a `.py` file, shown while code runs) stops the code
  that is running; the kernel and its variables stay.
- **Restart** asks first ("Restart the kernel? Its variables are cleared and its imports are
  lost.") and gives you a fresh kernel.

The kernel stops after 30 idle minutes and when your sandbox goes to sleep. One run happens at a
time: while the agent is answering in the conversation, your run waits its turn.

## Notebooks

A notebook opens as cells. **Run cell N** runs one cell; **Run all** runs the code cells in order
and stops at the first error. Cells can be edited (**Edit cell N**, then **Done**), moved, deleted,
and added (Add code cell, or a Markdown cell below). **Save** writes the notebook; outputs are saved
into it.

Outputs show text, errors with their traceback, pandas tables, images (Matplotlib plots appear
inline) and HTML. HTML and SVG output is shown in a locked-down frame with no network access.

## Python files

A `.py` file opens ready to edit: the code editor (Raw) is the default, with the cursor in it, and
**Rendered** is one click away.

- **Run** runs the file. If you have unsaved changes, Run saves them first and then runs the saved
  file (the note above the editor says so); if the save fails, nothing runs.
- **Run selection** runs only the lines you selected in the code (their common indentation is
  removed, so a block from inside a function runs on its own).
- In the code, **Shift+Enter** runs the selected lines, or the whole file when nothing is selected;
  **Mod+Enter** always runs the whole file; **Mod+S** saves.
- While code runs, **Stop** appears next to Run and a clock counts ("Running 0:07"); afterwards the
  toolbar says how it ended and how long it took ("Done in 1.2 s", "Error after 0.3 s").

Running splits the editor: code on top, the run pane below. Drag the divider (or use Up, Down, Page
Up, Page Down, Home and End; Enter goes back to half and half); this browser remembers the split.
The pane stays after the run, can be collapsed to its bar or closed, and opens again on the next
run, including when the agent runs the file. **Show run pane** opens it without a run.

### The run pane

The pane has three tabs (Left and Right move between them). A dot on a tab means something new
there, such as new output or a failed run. This browser remembers the tab you chose.

- **Run Output** shows what the latest run printed and returned: text, tables, plots and errors
  with their traceback. **Clear** empties it until the next run.
- **Log** lists this file's runs in this conversation, newest first: the time, who ran it (you or
  the agent), how it ended, how long it took and its execution count. Choose a run to see its
  output in Run Output. A run that failed names the error and its line, with **Go to line**.
  The Log shows the last 50 runs and lasts across reloads; runs drop off 7 days after the run
  they were part of ended (an agent's long run keeps its early executions until it ends).
- **Variables** shows what your code defined in the kernel, with each value's type and a short
  value: a DataFrame says its rows and columns, an array its shape and type, a list its length.
  Sort and filter by name, and open a row for the longer value and a DataFrame's columns. The
  values come straight from your kernel when you look; Kobe does not store them, and the agent
  does not see them. Values of names that look like passwords, tokens or keys, and of
  `os.environ`, stay hidden until you choose **Show**. The list refreshes after each run and with
  **Refresh**; while code runs it shows the values from before the run.

## The agent runs code too

The agent runs Python with its `run_python` tool in the same kernel: it can pick up a DataFrame you
loaded, and you can inspect what it computed. `run_python` follows your team's tool rules like the
shell does, so it may ask for approval. When the agent changes a notebook, it proposes the edit for
your review like any other file (see [Editing files](file-editor.md)).

## Troubleshooting

- **"Not run: your changes could not be saved."** The file changed meanwhile or is read-only;
  see the message above the editor, then run again.
- **"Some output was cut."** A run keeps at most 200 outputs and 2 MB. Print less, or write large
  results to a file and open that.
- **"Stopped: it ran past its time limit."** Make the code faster, or run it in parts with Run
  selection.
- **Variables says they are "not available yet".** Your sandbox runs an older Kobe agent; they
  appear once it is updated. "The kernel is not running" means there is nothing to show: run the
  file or Start the kernel.
- **The kernel lost my variables.** It restarted, went idle for 30 minutes, or the sandbox slept.
  Run the setup cells again.
- **A package is missing.** Ask the agent to install it with pip; if the download is blocked, use
  **Request access** on the blocked card.
