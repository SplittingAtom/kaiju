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

The toolbar shows the kernel's state: "No kernel", "Waking sandbox…", "Starting kernel…", "Kernel
idle" or "Kernel busy".

- **Start** starts a kernel (and wakes a sleeping sandbox). Running code starts one too.
- **Interrupt** stops the code that is running; the kernel and its variables stay.
- **Restart** asks first ("Restart the kernel? Its variables and imports are lost.") and gives you
  a fresh kernel.

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
**Rendered** is one click away. It shows **Run** in the editor toolbar. Run uses the saved file, so save your changes
first. Running splits the editor: code on top, the live output below. Drag the divider (or use Up,
Down, Page Up, Page Down, Home and End; Enter goes back to half and half); this browser remembers
the split. The output stays after the run, can be collapsed to its bar or closed, and opens again
on the next run, including when the agent runs the file.

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

- **"Save your changes first: Run uses the saved file."** Save, then Run.
- **The kernel lost my variables.** It restarted, went idle for 30 minutes, or the sandbox slept.
  Run the setup cells again.
- **A package is missing.** Ask the agent to install it with pip; if the download is blocked, use
  **Request access** on the blocked card.
