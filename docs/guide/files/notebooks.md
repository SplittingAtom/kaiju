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
and stops at the first error. You can run up to 300 cells a minute (each cell of **Run all**
counts); past that the kernel bar says "Too many cell runs" until the minute is over. Cells can be edited (**Edit cell N**, then **Done**), moved, deleted,
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
  value: a DataFrame says its rows and columns, an array its shape and type, a list its length. Sort
  and filter by name, and open a row for the longer value and a DataFrame's columns. The values come
  straight from your kernel when you look; Kobe does not store them, and the agent does not see
  them. Values of names that look like credentials stay in your sandbox until you choose **Show**,
  which asks for that one variable. A name is split into words (at `_`, `-`, `.`, spaces and capital
  letters, so `apiKey`, `x-api-key` and `API_KEY` are the same) and counts as a credential when a
  word is password, passwd, pwd, passphrase, secret, token, auth, authorization, bearer,
  credential(s), creds, cookie, session, dsn or jwt (but not when the next word is count, len,
  length, size, limit or type, as in `token_count`), when it is `key` alone or key after api,
  access, private, secret, signing, encryption, master or client, or when it says connection string.
  `author`, `keyboard` or `sort_key` do not count. Inside a value that is shown, the value under
  such a key of a dict (or the second item of a pair like `("password", ...)`) reads `<hidden>`, as
  does the user and password part of a URL (`https://user:pass@host` shows as
  `https://<hidden>@host`), until you choose **Show hidden values**. `os.environ` shows only its
  type. The list refreshes after each run and with **Refresh**; while code runs it shows the values
  from before the run.

  Reading the variables runs none of your code. Kobe shows the value of numbers, strings, bytes,
  lists, tuples, dicts and sets (up to 8 items, two levels deep and 200 characters; an object inside
  one shows as its type, such as `<Customer>`), ranges, dates, times, durations, decimals,
  fractions, UUIDs and paths from Python's standard library (a time with a time zone of your own
  class shows only its type), NumPy arrays of numbers (a few values per row, never through NumPy's
  print options), and pandas DataFrames and Series backed by NumPy or pandas' own arrays (sizes,
  column names and types; one backed by an array type of your own shows only its type). A subclass
  of a list, tuple, dict, set, string or bytes shows its items as the built-in type stores them; a
  subclass of anything else, and any other object, including instances of your own classes, shows
  only its type and "(value not shown for this type)": its `__repr__`, `__str__`, `__len__` and
  iteration are never called. The request is not run as code either, so your execution hooks
  (`post_execute` and the like, autoreload), input transformers and display formatters do not run,
  and the execution count and history do not change. One snapshot lists at most 200 variables and 64
  KB, and stops after 2 seconds (the list then says it is incomplete).

## Code completion from the kernel

In a `.py` file's editor, completion also asks the conversation's kernel (see [Code
completion](file-editor.md#code-completion)). It offers:

- names your runs (or the agent's) created, such as variables, functions, classes and imports;
- after a dot, the attributes stored on a module, class or object, read from their dictionaries;
- inside `d['` or `d[`, the keys of a plain dict (strings, numbers);
- inside a call such as `f(`, the keyword arguments of a plain Python function, class or built-in
  (`name=`);
- DataFrame column names after `df.` or `df['`, only when pandas keeps the labels as Python
  objects. String column names in the sandbox's pandas are stored by PyArrow and are not offered.

Kobe does not use IPython's completer. The request goes to the kernel as a completion or
inspection request, not as code to run, so none of your execution hooks (`pre_run_cell`,
`post_execute` and the like, autoreload, matplotlib's), input transformers or display formatters
run, and the execution count, history and `Out` stay as they are. A small resolver reads your
namespace and the dictionaries of modules, classes and objects, and never calls anything. It stops,
and you get only the editor's own suggestions, at a property, a `functools.cached_property` or any
other descriptor, a class with a custom metaclass (Enum members and many ORM or pydantic models), an
object that defines `__getattribute__`, a call, or a module attribute only `__getattr__` would
supply. It does not offer keys of dict subclasses (`OrderedDict`, `defaultdict`, `Counter`), tuple
keys, NumPy field names, or builtins and keywords (the editor's own list has those). Its tests
check that none of your getters, descriptors, `__getattr__`, `__getattribute__`, `__class__`,
`__dir__`, `__signature__`, metaclass hooks, key `__hash__`/`__eq__`, registered completers or
execution hooks run. Very large containers are only partly read: at most 10,000 entries are looked
at and 200 suggestions returned, within a fifth of a second, so a huge dict may show only some of
its keys. Completion does not start while a timer of yours (`signal.setitimer`) is pending, and it
never interrupts running code. Docs come from signatures and docstrings read the same way (no repr,
no getter; a default value that is not a plain number or string shows as `…`). Nothing about it is
saved, and it does not count as using your sandbox: typing in the editor does not keep it awake.

Kernel completion only works while the kernel runs and is idle. A note under the editor, next to
the line and column, says when it is off and why: the kernel is not started (press **Start** or run
the file), your sandbox is asleep (it is never woken just to complete), code is running, the
kernel did not answer in time, too many requests, or it is not available in your sandbox yet. The
editor's own completion keeps working in every case. Only the conversation's owner gets kernel
completion.

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
