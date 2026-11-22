#!/usr/bin/env python3
"""kobe-kernel-bridge: one thread's IPython kernel for kobe-sandbox-agent (KOBE-464).

docs/specs/notebooks.md NB10. The agent starts this program (root-owned, read-only, in the image)
under the kernel's own uid and talks to it over stdio only, one JSON object per line:

  agent -> bridge   {"op": "execute", "id": "<id>", "code": "<source>"}
                    {"op": "inspect", "id": "<id>", "limits": {<caps, below>}}   (KOBE-803)
                    {"op": "complete", "id": "<id>", "code": "<source>", "cursor": <int>,
                     "timeout_ms": <int>}                                              (KOBE-808)
                    {"op": "doc", "id": "<id>", "name": "<dotted.name>", "timeout_ms": <int>}
                    {"op": "interrupt"}
                    {"op": "shutdown"}          (also: stdin closed)
  bridge -> agent   {"ev": "ready"}
                    {"ev": "output", "id": "<id>", "output": {<nbformat 4 output>}}
                    {"ev": "done", "id": "<id>", "status": "ok"|"error"|"interrupted",
                     "execution_count": <int|null>}
                    {"ev": "inspected", "id": "<id>", "snapshot": {variables, other, truncated,
                     execution_count}} | {"ev": "inspected", "id": "<id>", "error": "<name>"}
                    {"ev": "completed", "id": "<id>", "result": {<the wire's completion answer>}}
                     | {"ev": "completed", "id": "<id>", "error": "<name>"}
                    {"ev": "died"}               (the kernel process is gone)
                    {"ev": "fatal", "message": "<text>"}

The kernel is ipykernel, started by jupyter_client with the ZeroMQ "ipc" transport: unix sockets
in a fresh 0700 directory, signed with a random key. No TCP port is opened: ipykernel's IOPub
"pipe" (a 127.0.0.1 listener that forwards the output of forked child processes) is switched off by
the launcher below, so a forked child's Python-level prints are not shown. The kernel's own
stdin/stdout/stderr are /dev/null, so nothing it writes can reach this protocol. IPython and Jupyter
read their configuration and startup files from that directory only (never the shared $HOME).
Outputs are passed on as the kernel sends them; the agent applies Kobe's caps and MIME allow-list.

Internet (NB17): like the shell tool, through egress-proxy. The agent passes the token *file*
(KOBE_EGRESS_TOKEN_FILE), the proxy URL and the thread id, never the token; before each cell the
bridge runs a silent snippet in the kernel that reads the current token and sets HTTPS_PROXY and
friends (as the shell tool's BASH_ENV script does per command), so a rotated token is picked up.
One execution runs at a time; `interrupt` sends SIGINT to the kernel.

Variables (KOBE-803): `inspect` snapshots the user namespace without running a cell: an empty,
silent execute request (no execution count, no history, no outputs, nothing in `Out` or `_`) whose
user expression defines INSPECT_SOURCE in a fresh namespace (nothing is added to the user's) and
returns the snapshot as JSON text. Only names, type names, short reprs and summaries leave the
kernel. Each variable's description runs under a SIGALRM timer (`per_var_ms`) with every
exception caught, so a `__repr__` that raises or loops costs that variable its repr, not the
snapshot; the whole snapshot has a budget (`budget_ms`) and count and byte caps (`truncated`).

Completion (KOBE-808): `complete` is Jupyter's `complete_request` on the shell channel (no
execution count, no history). The kernel starts with IPython's completer set to jedi off and
`evaluation = "limited"` (KERNEL_ARGS): jedi's interpreter mode runs property getters on live
objects, the limited policy evaluates no calls, no property getters, no imports and only
allow-listed item and attribute access. `doc` never sends the member's code at all: the agent
sends a dotted name the server checked, and DOC_SOURCE (a silent request's user expression, like
`inspect`) resolves it with `inspect.getattr_static` (no descriptors, no `__getattr__`) and reads
the signature and docstring, never a repr, under a SIGALRM timer. Both answer within `timeout_ms`
or `error: "timeout"`; a late reply is skipped by its message id.
"""

import ast
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

READY_TIMEOUT_S = 60
# A line the agent would refuse anyway: replaced by a note before it is written.
MAX_LINE_BYTES = 1024 * 1024
OUTPUT_TYPES = ("stream", "display_data", "execute_result", "error")
KERNEL_NAME = "kobe-python"
# Run silently before each cell when egress is wired: the same rules as egress-env.sh (only
# [A-Za-z0-9._:-] in the parts; anything else exports nothing).
EGRESS_REFRESH = """
def __kobe_egress():
    import os, re
    f, p = os.environ.get("KOBE_EGRESS_TOKEN_FILE"), os.environ.get("KOBE_EGRESS_PROXY")
    if not f or not p:
        return
    try:
        with open(f, encoding="ascii") as fh:
            token = fh.readline().strip()
    except (OSError, ValueError):
        return
    user = os.environ.get("KOBE_THREAD_ID", "kobe")
    host = (p[len("http://"):] if p.startswith("http://") else p).rstrip("/")
    if not token or not re.fullmatch(r"[A-Za-z0-9._:-]+", token + user + host):
        return
    url = "http://%s:%s@%s" % (user, token, host)
    for name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        os.environ[name] = url
__kobe_egress()
del __kobe_egress
"""
# ipykernel_launcher, with the IOPub pipe off (no loopback TCP listener in the kernel).
LAUNCHER = """import sys
del sys.path[0]
import ipykernel.iostream as _io
_init = _io.IOPubThread.__init__
def _no_pipe(self, socket, pipe=False, session=False):
    _init(self, socket, pipe=False, session=session)
_io.IOPubThread.__init__ = _no_pipe
from ipykernel import kernelapp
kernelapp.launch_new_instance()
"""

INSPECT_SOURCE = r'''
import json as _json
import reprlib as _reprlib
import signal as _signal
import sys as _sys
import time as _time
import types as _types

IPYTHON_NAMES = frozenset(("In", "Out", "exit", "quit", "get_ipython"))
FUNCTION_TYPES = (
    _types.FunctionType,
    _types.BuiltinFunctionType,
    _types.MethodType,
    _types.BuiltinMethodType,
    _types.MethodWrapperType,
    _types.WrapperDescriptorType,
)
SIZED_BASES = (str, bytes, bytearray, list, tuple, dict, set, frozenset, range)
_qualname = type.__dict__["__qualname__"].__get__
_module = type.__dict__["__module__"].__get__


class _Timeout(BaseException):
    pass


def clean(text, limit):
    text = str(text) if type(text) is str else ""
    text = text.replace("\x00", "�").encode("utf-8", "replace").decode("utf-8")
    return text if len(text) <= limit else text[: limit - 1] + "…"


def kind_of(t):
    if issubclass(t, _types.ModuleType):
        return "module"
    if issubclass(t, type):
        return "class"
    if issubclass(t, FUNCTION_TYPES):
        return "function"
    return None


def type_names(t):
    try:
        name = _qualname(t)
    except Exception:
        name = "?"
    try:
        module = _module(t)
    except Exception:
        module = None
    module = module.split(".")[0] if type(module) is str else None
    return clean(name, 256) or "?", (None if module in (None, "builtins") else clean(module, 128))


def library_type(module_name, attr):
    mod = _sys.modules.get(module_name)
    found = getattr(mod, attr, None) if mod is not None else None
    return found if isinstance(found, type) else None


class Snapshot:
    def __init__(self, limits):
        self.max_vars = int(limits.get("max_vars", 200))
        self.max_bytes = int(limits.get("max_bytes", 65536))
        self.repr_chars = int(limits.get("repr_chars", 200))
        self.columns_max = int(limits.get("columns_max", 50))
        self.per_s = float(limits.get("per_var_ms", 200)) / 1000
        self.deadline = _time.monotonic() + float(limits.get("budget_ms", 2000)) / 1000
        self.armed = False
        self.alarm = False
        self.ndarray = library_type("numpy", "ndarray")
        self.frame = library_type("pandas", "DataFrame")
        self.series = library_type("pandas", "Series")
        self.short = _reprlib.Repr()
        self.short.maxlevel = 2
        self.short.maxstring = self.repr_chars
        self.short.maxother = self.repr_chars
        for name in ("maxlist", "maxtuple", "maxdict", "maxset", "maxfrozenset", "maxdeque", "maxarray"):
            setattr(self.short, name, 8)

    def _on_alarm(self, signum, frame):
        if self.armed:
            raise _Timeout()

    def bounded(self, fn):
        """("ok", value) | ("timeout", None) | ("raised", None); KeyboardInterrupt passes."""
        try:
            if self.alarm:
                self.armed = True
                _signal.setitimer(_signal.ITIMER_REAL, self.per_s)
            try:
                value = fn()
            finally:
                self.armed = False
                if self.alarm:
                    _signal.setitimer(_signal.ITIMER_REAL, 0)
            return "ok", value
        except _Timeout:
            return "timeout", None
        except KeyboardInterrupt:
            raise
        except BaseException:
            return "raised", None

    def describe(self, value, t):
        """Summary fields and the repr; touches only built-in, numpy and pandas internals."""
        out = {}
        if self.frame is not None and issubclass(t, self.frame):
            rows, cols = len(value.index), len(value.columns)
            out["shape"] = [rows, cols]
            out["columns_total"] = cols
            out["columns"] = [
                {"name": clean(str(c), 128), "dtype": clean(str(d), 128)}
                for c, d in list(value.dtypes.items())[: self.columns_max]
            ]
            out["repr"] = "DataFrame: %d rows × %d columns" % (rows, cols)
            return out
        if self.series is not None and issubclass(t, self.series):
            n = len(value)
            out["len"] = n
            out["shape"] = [n]
            out["dtype"] = clean(str(value.dtype), 128)
            out["repr"] = "Series: %d values (%s)" % (n, out["dtype"])
            return out
        if self.ndarray is not None and issubclass(t, self.ndarray):
            out["shape"] = [int(d) for d in value.shape][:64]
            out["dtype"] = clean(str(value.dtype), 128)
            np = _sys.modules["numpy"]
            out["repr"] = np.array2string(
                value, threshold=8, edgeitems=2, max_line_width=self.repr_chars
            ).replace("\n", " ")
            return out
        base = next((b for b in SIZED_BASES if issubclass(t, b)), None)
        if base is None:
            out["repr"] = repr(value)
            return out
        # Built-in containers, strings and bytes, subclasses included: the base type's own length
        # and a bounded repr (reprlib's handlers, or a slice), never the object's full repr().
        out["len"] = base.__len__(value)
        out["repr"] = self.bounded_repr(value, base)
        return out

    def bounded_repr(self, value, base):
        if base in (str, bytes, bytearray):
            return repr(base.__getitem__(value, slice(0, self.repr_chars)))
        handler = {
            list: self.short.repr_list,
            tuple: self.short.repr_tuple,
            dict: self.short.repr_dict,
            set: self.short.repr_set,
            frozenset: self.short.repr_frozenset,
        }.get(base)
        return handler(value, self.short.maxlevel) if handler is not None else repr(value)

    def variable(self, name, value, t):
        type_name, module = type_names(t)
        item = {"name": clean(name, 256), "type": type_name}
        if module is not None:
            item["module"] = module
        verdict, described = self.bounded(lambda: self.describe(value, t))
        if verdict != "ok":
            item["repr"] = ""
            item["repr_error"] = verdict
            return item
        for key in ("len", "shape", "dtype", "columns", "columns_total"):
            if key in described:
                item[key] = described[key]
        item["repr"] = clean(described.get("repr", ""), self.repr_chars)
        return item

    def take(self, ns, hidden):
        names = []
        for name in list(ns.keys()):
            if type(name) is not str or name.startswith("_") or name in IPYTHON_NAMES:
                continue
            if name in hidden and hidden.get(name) is ns.get(name):
                continue
            names.append(name)
        names.sort()
        variables, other, used, truncated = [], [], 0, False
        for name in names:
            if _time.monotonic() > self.deadline:
                truncated = True
                break
            value = ns.get(name)
            t = type(value)
            kind = kind_of(t)
            if kind is not None:
                if len(other) >= self.max_vars:
                    truncated = True
                    continue
                entry = {"name": clean(name, 256), "kind": kind}
                size = len(_json.dumps(entry)) + 1
                if used + size > self.max_bytes:
                    truncated = True
                    break
                other.append(entry)
                used += size
                continue
            if len(variables) >= self.max_vars:
                truncated = True
                continue
            item = self.variable(name, value, t)
            size = len(_json.dumps(item, ensure_ascii=False).encode("utf-8")) + 1
            if used + size > self.max_bytes:
                truncated = True
                break
            variables.append(item)
            used += size
        return {"variables": variables, "other": other, "truncated": truncated}

    def run(self, ns, hidden):
        previous = None
        try:
            # Per-variable alarms only when the kernel's main thread runs this and no timer of
            # the user's is pending; otherwise the whole-snapshot budget still bounds it.
            if hasattr(_signal, "setitimer") and _signal.getitimer(_signal.ITIMER_REAL)[0] == 0:
                previous = _signal.signal(_signal.SIGALRM, self._on_alarm)
                self.alarm = True
        except (ValueError, OSError):
            self.alarm = False
        try:
            return self.take(ns, hidden)
        finally:
            if self.alarm:
                self.armed = False
                _signal.setitimer(_signal.ITIMER_REAL, 0)
                _signal.signal(_signal.SIGALRM, previous if previous is not None else _signal.SIG_DFL)


def snapshot(limits, ns=None, hidden=None):
    """JSON text of the snapshot. Inside the kernel, the IPython user namespace."""
    if ns is None:
        from IPython import get_ipython

        shell = get_ipython()
        ns = shell.user_ns
        hidden = shell.user_ns_hidden
    return _json.dumps(Snapshot(limits).run(ns, hidden or {}), ensure_ascii=True)
'''

# Evaluated as the silent request's user expression: INSPECT_SOURCE in a namespace of its own.
INSPECT_EXPRESSION = "(lambda g: (exec(%s, g), g['snapshot'])[1])({'__name__': 'kobe_inspect'})(%s)"
INSPECT_LIMIT_KEYS = ("max_vars", "max_bytes", "repr_chars", "columns_max", "per_var_ms", "budget_ms")

# KOBE-808: IPython's completer without jedi (whose interpreter mode runs property getters) and
# with its default limited evaluation stated, so a profile can't loosen it.
KERNEL_ARGS = ["--IPCompleter.use_jedi=False", "--IPCompleter.evaluation=limited"]
COMPLETE_MATCHES_MAX = 100
COMPLETE_MATCH_MAX_CHARS = 200
COMPLETE_TYPE_MAX_CHARS = 32
COMPLETE_TIMEOUT_MAX_S = 2.0
DOC_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,15}")

# The documentation of a dotted name, read without running the member's code: the name resolves
# through the user namespace (then builtins) with inspect.getattr_static, so no property getter,
# descriptor or __getattr__ runs; only signatures and docstrings are read, never a repr.
DOC_SOURCE = r'''
import builtins as _builtins
import inspect as _inspect
import json as _json
import signal as _signal
import types as _types

SIGNATURE_MAX = 1000
DOC_MAX = 8000
_qualname = type.__dict__["__qualname__"].__get__


class _Timeout(BaseException):
    pass


def _clip(text, limit):
    if type(text) is not str:
        return None
    text = text.replace("\x00", "\ufffd").strip()
    if not text:
        return None
    return text if len(text) <= limit else text[: limit - 1] + "\u2026"


def _resolve(name, ns):
    missing = object()
    parts = name.split(".")
    obj = ns.get(parts[0], missing) if type(ns) is dict else missing
    if obj is missing:
        obj = _builtins.__dict__.get(parts[0], missing)
    bound = False
    for part in parts[1:]:
        if obj is missing:
            break
        parent = obj
        obj = _inspect.getattr_static(parent, part, missing)
        # A plain function found through an instance is a method: its first parameter is bound.
        bound = isinstance(obj, _types.FunctionType) and not isinstance(parent, (type, _types.ModuleType))
    return None if obj is missing else (obj, bound)


def _class_doc(cls):
    """The first docstring in the class's MRO dicts (no metaclass attribute lookup), not object's."""
    for klass in type.__dict__["__mro__"].__get__(cls):
        if klass is object:
            break
        d = type.__dict__["__dict__"].__get__(klass)
        if type(d.get("__doc__")) is str:
            return d["__doc__"]
    return None


def _describe(name, obj, bound=False):
    out = {"found": True}
    try:
        out["type"] = _clip(_qualname(type(obj)), 256) or "?"
    except Exception:
        out["type"] = "?"
    if isinstance(obj, (staticmethod, classmethod)):
        obj = obj.__func__
    if isinstance(obj, property):
        # The getter's docstring; the getter itself never runs.
        doc = obj.fget.__doc__ if _inspect.isroutine(obj.fget) else None
    elif isinstance(obj, type):
        doc = _class_doc(obj)
    elif _inspect.isroutine(obj):
        doc = obj.__doc__
    elif _inspect.ismodule(obj):
        doc = object.__getattribute__(obj, "__dict__").get("__doc__")
    else:
        # Any other object: its type's docstring (the object's own attributes are never read).
        doc = _class_doc(type(obj))
    # Signatures of functions and classes only: for other callables inspect would read the
    # instance's attributes (`__wrapped__`, `__signature__`), which can run its `__getattr__`.
    if isinstance(obj, type) or _inspect.isroutine(obj):
        try:
            sig = _inspect.signature(obj)
            if bound and sig.parameters:
                sig = sig.replace(parameters=list(sig.parameters.values())[1:])
            out["signature"] = _clip(name.rsplit(".", 1)[-1] + str(sig), SIGNATURE_MAX)
        except (TypeError, ValueError):
            pass
    out["doc"] = _clip(_inspect.cleandoc(doc) if type(doc) is str else None, DOC_MAX)
    return {k: v for k, v in out.items() if v is not None}


def doc(name, per_ms=300, ns=None):
    """JSON text of the name's documentation. Inside the kernel, the IPython user namespace."""
    if ns is None:
        from IPython import get_ipython

        ns = get_ipython().user_ns
    alarm = False
    previous = None
    armed = [False]

    def on_alarm(signum, frame):
        if armed[0]:
            raise _Timeout()

    try:
        if hasattr(_signal, "setitimer") and _signal.getitimer(_signal.ITIMER_REAL)[0] == 0:
            previous = _signal.signal(_signal.SIGALRM, on_alarm)
            alarm = True
    except (ValueError, OSError):
        alarm = False
    try:
        if alarm:
            armed[0] = True
            _signal.setitimer(_signal.ITIMER_REAL, per_ms / 1000)
        found = _resolve(name, ns)
        result = {"found": False} if found is None else _describe(name, found[0], found[1])
    except _Timeout:
        result = {"error": "timeout"}
    except KeyboardInterrupt:
        raise
    except BaseException:
        result = {"error": "raised"}
    finally:
        armed[0] = False
        if alarm:
            _signal.setitimer(_signal.ITIMER_REAL, 0)
            _signal.signal(_signal.SIGALRM, previous if previous is not None else _signal.SIG_DFL)
    return _json.dumps(result, ensure_ascii=True)
'''

# Evaluated as the silent request's user expression: DOC_SOURCE in a namespace of its own.
DOC_EXPRESSION = "(lambda g: (exec(%s, g), g['doc'])[1])({'__name__': 'kobe_doc'})(%s)"
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


def short_text(value, limit):
    if type(value) is not str:
        return None
    value = ANSI.sub("", value).replace("\x00", "")
    return value[:limit] if value else None


def completion_result(content, code, cursor):
    """The wire's `complete` answer from a `complete_reply`: capped, plain text, deduplicated."""
    if content.get("status") != "ok":
        return None
    start, end = content.get("cursor_start"), content.get("cursor_end")
    if type(start) is not int or type(end) is not int or not 0 <= start <= end <= len(code):
        start = end = cursor
    raw = content.get("matches")
    raw = raw if isinstance(raw, list) else []
    types = {}
    meta = content.get("metadata")
    experimental = meta.get("_jupyter_types_experimental") if isinstance(meta, dict) else None
    for item in experimental if isinstance(experimental, list) else []:
        if isinstance(item, dict) and type(item.get("text")) is str and type(item.get("type")) is str:
            kind = item["type"].strip("<>")
            if kind and kind != "unknown":
                types.setdefault(item["text"], kind[:COMPLETE_TYPE_MAX_CHARS])
    texts = [m for m in raw if type(m) is str and m and "\x00" not in m and len(m) <= COMPLETE_MATCH_MAX_CHARS]
    # IPython's attribute matches carry the dot (".alpha" from the dot on): from after it instead.
    if texts and start < end and code[start] == "." and all(m.startswith(".") for m in texts):
        texts = [m[1:] for m in texts if len(m) > 1]
        types = {k[1:]: v for k, v in types.items() if k.startswith(".")}
        start += 1
    seen = set()
    matches = []
    for text in texts:
        if text in seen:
            continue
        seen.add(text)
        match = {"text": text}
        if text in types:
            match["type"] = types[text]
        matches.append(match)
        if len(matches) >= COMPLETE_MATCHES_MAX:
            break
    return {"status": "ok", "op": "complete", "matches": matches, "cursor_start": start, "cursor_end": end}

_write_lock = threading.Lock()


def timeout_of(command):
    ms = command.get("timeout_ms")
    return min(COMPLETE_TIMEOUT_MAX_S, ms / 1000) if type(ms) is int and ms > 0 else 1.0


def emit(message):
    line = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
    with _write_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def note(text):
    return {"output_type": "stream", "name": "stderr", "text": text}


def output_of(msg_type, content):
    if msg_type == "stream":
        return {"output_type": "stream", "name": content.get("name", "stdout"), "text": content.get("text", "")}
    if msg_type == "error":
        return {
            "output_type": "error",
            "ename": content.get("ename", ""),
            "evalue": content.get("evalue", ""),
            "traceback": list(content.get("traceback", [])),
        }
    out = {"output_type": msg_type, "data": content.get("data", {}), "metadata": content.get("metadata", {})}
    if msg_type == "execute_result":
        out["execution_count"] = content.get("execution_count")
    return out


def emit_output(exec_id, output):
    message = {"ev": "output", "id": exec_id, "output": output}
    size = len(json.dumps(message, ensure_ascii=False).encode("utf-8"))
    if size > MAX_LINE_BYTES:
        message["output"] = note(f"[Kobe: output truncated: one output of {size} bytes was too large]\n")
    emit(message)


def write_kernel_spec(private, data_dir):
    launcher = os.path.join(private, "kobe_kernel_launcher.py")
    with open(launcher, "w", encoding="utf-8") as f:
        f.write(LAUNCHER)
    spec_dir = os.path.join(data_dir, "kernels", KERNEL_NAME)
    os.makedirs(spec_dir, mode=0o700, exist_ok=True)
    spec = {
        "argv": [sys.executable, launcher, *KERNEL_ARGS, "-f", "{connection_file}"],
        "display_name": "Python 3 (Kobe)",
        "language": "python",
    }
    with open(os.path.join(spec_dir, "kernel.json"), "w", encoding="utf-8") as f:
        json.dump(spec, f)


def private_environment(private):
    """The kernel's environment: the agent's (already an allow-list) with private config dirs."""
    env = dict(os.environ)
    for name in ("PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE"):
        env.pop(name, None)
    for name, sub in (
        ("IPYTHONDIR", "ipython"),
        ("JUPYTER_CONFIG_DIR", "config"),
        ("JUPYTER_DATA_DIR", "data"),
        ("JUPYTER_RUNTIME_DIR", "runtime"),
        ("MPLCONFIGDIR", "matplotlib"),
    ):
        path = os.path.join(private, sub)
        os.makedirs(path, mode=0o700, exist_ok=True)
        env[name] = path
    env["JUPYTER_CONFIG_PATH"] = env["JUPYTER_CONFIG_DIR"]
    env["JUPYTER_PATH"] = env["JUPYTER_DATA_DIR"]
    env["JUPYTER_PLATFORM_DIRS"] = "1"
    env["MPLBACKEND"] = "module://matplotlib_inline.backend_inline"
    env["PYDEVD_DISABLE_FILE_VALIDATION"] = "1"
    return env


class Bridge:
    def __init__(self, private):
        self.private = private
        self.commands = queue.Queue()
        self.km = None
        self.kc = None

    def start(self):
        env = private_environment(self.private)
        # The bridge reads the same variables (jupyter_client resolves its dirs from them).
        os.environ.update({k: v for k, v in env.items() if k.startswith(("JUPYTER", "IPYTHON"))})
        write_kernel_spec(self.private, env["JUPYTER_DATA_DIR"])
        from jupyter_client import KernelManager

        self.km = KernelManager(
            kernel_name=KERNEL_NAME,
            transport="ipc",
            ip=os.path.join(self.private, "kernel"),
            connection_file=os.path.join(self.private, "runtime", "kernel.json"),
        )
        devnull = subprocess.DEVNULL
        self.km.start_kernel(env=env, cwd=os.getcwd(), stdin=devnull, stdout=devnull, stderr=devnull)
        self.kc = self.km.client()
        self.kc.allow_stdin = False
        self.kc.start_channels()
        self.kc.wait_for_ready(timeout=READY_TIMEOUT_S)

    def read_commands(self):
        for line in sys.stdin:
            try:
                command = json.loads(line)
            except ValueError:
                continue
            if not isinstance(command, dict):
                continue
            if command.get("op") == "interrupt":
                try:
                    self.km.interrupt_kernel()
                except Exception as error:  # noqa: BLE001 - reported, never fatal
                    emit({"ev": "fatal", "message": f"interrupt failed: {error}"[:500]})
                continue
            self.commands.put(command)
            if command.get("op") == "shutdown":
                return
        self.commands.put({"op": "shutdown"})

    def execute(self, exec_id, code):
        if os.environ.get("KOBE_EGRESS_TOKEN_FILE") and os.environ.get("KOBE_EGRESS_PROXY"):
            # Silent and before the cell on the same shell channel, so it runs first; its own
            # messages carry another parent id and are not forwarded.
            self.kc.execute(
                EGRESS_REFRESH, silent=True, store_history=False, allow_stdin=False, stop_on_error=False
            )
        msg_id = self.kc.execute(code, store_history=True, allow_stdin=False, stop_on_error=True)
        interrupted = False
        while True:
            try:
                msg = self.kc.get_iopub_msg(timeout=0.5)
            except queue.Empty:
                if not self.km.is_alive():
                    emit({"ev": "died"})
                    return False
                continue
            if msg.get("parent_header", {}).get("msg_id") != msg_id:
                continue
            msg_type = msg.get("msg_type")
            content = msg.get("content", {})
            if msg_type in OUTPUT_TYPES:
                if msg_type == "error" and content.get("ename") == "KeyboardInterrupt":
                    interrupted = True
                emit_output(exec_id, output_of(msg_type, content))
            elif msg_type == "status" and content.get("execution_state") == "idle":
                break
        status, count = "error", None
        while True:
            try:
                reply = self.kc.get_shell_msg(timeout=5)
            except queue.Empty:
                break
            if reply.get("parent_header", {}).get("msg_id") == msg_id:
                content = reply.get("content", {})
                status = "ok" if content.get("status") == "ok" else "error"
                count = content.get("execution_count")
                break
        if interrupted:
            status = "interrupted"
        emit({"ev": "done", "id": exec_id, "status": status, "execution_count": count})
        return True

    def inspect(self, inspect_id, limits):
        safe = {k: int(v) for k, v in limits.items() if k in INSPECT_LIMIT_KEYS and type(v) is int and 0 < v < 10**7}
        expression = INSPECT_EXPRESSION % (repr(INSPECT_SOURCE), repr(safe))
        msg_id = self.kc.execute(
            "",
            silent=True,
            store_history=False,
            user_expressions={"kobe": expression},
            allow_stdin=False,
            stop_on_error=False,
        )
        while True:
            try:
                reply = self.kc.get_shell_msg(timeout=0.5)
            except queue.Empty:
                if not self.km.is_alive():
                    emit({"ev": "died"})
                    return False
                continue
            if reply.get("parent_header", {}).get("msg_id") == msg_id:
                break
        content = reply.get("content", {})
        result = (content.get("user_expressions") or {}).get("kobe") or {}
        if content.get("status") != "ok" or result.get("status") != "ok":
            name = result.get("ename") or content.get("ename") or "error"
            emit({"ev": "inspected", "id": inspect_id, "error": str(name)[:200]})
            return True
        try:
            snap = json.loads(ast.literal_eval(result["data"]["text/plain"]))
            if not isinstance(snap, dict):
                raise ValueError("not an object")
        except Exception:  # noqa: BLE001 - reported as unreadable
            emit({"ev": "inspected", "id": inspect_id, "error": "unreadable"})
            return True
        count = content.get("execution_count")
        snap["execution_count"] = count if type(count) is int else None
        emit({"ev": "inspected", "id": inspect_id, "snapshot": snap})
        return True

    def shell_reply(self, msg_id, timeout_s):
        """The shell reply to `msg_id`, None past `timeout_s`, False when the kernel died."""
        deadline = time.monotonic() + timeout_s
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                return None
            try:
                reply = self.kc.get_shell_msg(timeout=min(0.2, left))
            except queue.Empty:
                if not self.km.is_alive():
                    return False
                continue
            if reply.get("parent_header", {}).get("msg_id") == msg_id:
                return reply

    def complete(self, command):
        """KOBE-808: completions at the cursor (Jupyter complete_request); never runs code."""
        cid = str(command.get("id", ""))
        code, cursor = command.get("code"), command.get("cursor")
        if type(code) is not str or type(cursor) is not int or not 0 <= cursor <= len(code):
            emit({"ev": "completed", "id": cid, "error": "invalid"})
            return True
        reply = self.shell_reply(self.kc.complete(code, cursor), timeout_of(command))
        if reply is False:
            emit({"ev": "died"})
            return False
        result = None if reply is None else completion_result(reply.get("content", {}), code, cursor)
        if result is None:
            emit({"ev": "completed", "id": cid, "error": "timeout" if reply is None else "failed"})
        else:
            emit({"ev": "completed", "id": cid, "result": result})
        return True

    def doc(self, command):
        """KOBE-808: a dotted name's signature and docstring (DOC_SOURCE), silently."""
        cid = str(command.get("id", ""))
        name = command.get("name")
        if type(name) is not str or len(name) > 256 or not DOC_NAME.fullmatch(name):
            emit({"ev": "completed", "id": cid, "error": "invalid"})
            return True
        expression = DOC_EXPRESSION % (repr(DOC_SOURCE), repr(name))
        msg_id = self.kc.execute(
            "",
            silent=True,
            store_history=False,
            user_expressions={"kobe": expression},
            allow_stdin=False,
            stop_on_error=False,
        )
        reply = self.shell_reply(msg_id, timeout_of(command))
        if reply is False:
            emit({"ev": "died"})
            return False
        if reply is None:
            emit({"ev": "completed", "id": cid, "error": "timeout"})
            return True
        content = reply.get("content", {})
        found = (content.get("user_expressions") or {}).get("kobe") or {}
        try:
            if content.get("status") != "ok" or found.get("status") != "ok":
                raise ValueError("failed")
            data = json.loads(ast.literal_eval(found["data"]["text/plain"]))
            if not isinstance(data, dict) or "error" in data:
                raise ValueError("failed")
        except Exception:  # noqa: BLE001 - reported as failed
            emit({"ev": "completed", "id": cid, "error": "failed"})
            return True
        result = {"status": "ok", "op": "doc", "found": data.get("found") is True}
        for key, limit in (("signature", 1000), ("doc", 8000), ("type", 256)):
            text = short_text(data.get(key), limit)
            if text is not None:
                result[key] = text
        emit({"ev": "completed", "id": cid, "result": result})
        return True

    def serve(self):
        threading.Thread(target=self.read_commands, daemon=True).start()
        emit({"ev": "ready"})
        while True:
            command = self.commands.get()
            if command.get("op") == "shutdown":
                return
            if command.get("op") == "inspect":
                limits = command.get("limits")
                if not self.inspect(str(command.get("id", "")), limits if isinstance(limits, dict) else {}):
                    return
                continue
            if command.get("op") in ("complete", "doc"):
                served = self.complete(command) if command.get("op") == "complete" else self.doc(command)
                if not served:
                    return
                continue
            if command.get("op") != "execute":
                continue
            exec_id = str(command.get("id", ""))
            code = command.get("code")
            if not isinstance(code, str):
                emit({"ev": "done", "id": exec_id, "status": "error", "execution_count": None})
                continue
            if not self.execute(exec_id, code):
                return

    def stop(self):
        try:
            if self.kc is not None:
                self.kc.stop_channels()
            if self.km is not None and self.km.has_kernel:
                self.km.shutdown_kernel(now=True)
        except Exception:  # noqa: BLE001 - best effort on the way out
            pass


def main():
    private = tempfile.mkdtemp(prefix="kobe-kernel-")
    bridge = Bridge(private)
    try:
        try:
            bridge.start()
        except Exception as error:  # noqa: BLE001 - the agent shows a fixed message
            emit({"ev": "fatal", "message": f"the kernel did not start: {type(error).__name__}: {error}"[:500]})
            return 1
        bridge.serve()
        return 0
    finally:
        bridge.stop()
        shutil.rmtree(private, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
