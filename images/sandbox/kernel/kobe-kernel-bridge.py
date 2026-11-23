#!/usr/bin/env python3
"""kobe-kernel-bridge: one thread's IPython kernel for kobe-sandbox-agent (KOBE-464).

docs/specs/notebooks.md NB10. The agent starts this program (root-owned, read-only, in the image)
under the kernel's own uid and talks to it over stdio only, one JSON object per line:

  agent -> bridge   {"op": "execute", "id": "<id>", "code": "<source>"}
                    {"op": "inspect", "id": "<id>", "limits": {<caps, below>},
                     "show": "<name>"?}                          (KOBE-803; show: KOBE-816)
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

Variables (KOBE-803, transport KOBE-816): `inspect` asks the kernel for a snapshot of the user
namespace through an `inspect_request` (code: VARIABLES_MARKER and the caps as JSON), which the
launcher answers from STATIC_SOURCE's `variables`: no execute, so no hooks, input transformers,
formatters, history or execution count. Values are read only for exact built-in scalars, strings,
bytes and containers (subclasses of built-in containers through the built-in's C methods),
ranges and exact numpy/pandas objects; anything else shows its type only, and no member
`__repr__`, `__str__`, `__len__` or `__iter__` runs. Count, byte and character caps and a time
budget bound it (`truncated`).

Completion (KOBE-808): IPython's completer and inspector are never used (their matchers evaluate
member code). The launcher replaces the kernel's `do_complete` / `do_inspect` with calls into
STATIC_SOURCE, and the bridge sends `complete_request` / `inspect_request`: those handlers run
none of the execution machinery (no input transformers, events, formatters, history or execution
count). STATIC_SOURCE reads only namespace, module, class and instance dicts (through C-level
descriptors taken from built-in types), never calls, never invokes a descriptor, a property, a
metaclass or a member's hook, and is bounded by caps and a 200 ms budget checked between steps.
`doc` gets a dotted name the server checked. Neither runs while a member's timer is pending. Both
answer within `timeout_ms` or `error: "timeout"`; a late reply is skipped by its message id.
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
# KOBE-808: completion and docs are answered by the kernel's complete_request / inspect_request
# handlers, replaced here to call only the bridge's static resolver (STATIC_SOURCE) on the user
# namespace. Those handlers fire none of IPython's execution machinery: no input transformers, no
# pre/post_execute or run_cell events, no display formatters, no history, no `_`, no execution
# count. IPython's own completer and inspector are never called. `async def`, so ipykernel warns
# about nothing (a member's warnings hook would run).
import json as _kobe_json
_KOBE_VARIABLES = "@VARIABLES_MARKER@"
_kobe_static = {"__name__": "kobe_static"}
exec(@STATIC_SOURCE@, _kobe_static)
from ipykernel import ipkernel as _ipk
async def _kobe_complete(self, code, cursor_pos):
    pos = len(code) if cursor_pos is None else cursor_pos
    shell = self.shell
    found = _kobe_static["complete"](code, pos, shell.user_ns, shell.user_ns_hidden)
    return {"status": "ok", "matches": [], "cursor_start": pos, "cursor_end": pos, "metadata": {"kobe": found}}
async def _kobe_inspect(self, code, cursor_pos, detail_level=0, omit_sections=()):
    shell = self.shell
    if code.startswith(_KOBE_VARIABLES):
        # KOBE-816: the variables snapshot, on this channel too (never a silent execute).
        try:
            asked = _kobe_json.loads(code[len(_KOBE_VARIABLES):])
        except ValueError:
            asked = {}
        asked = asked if type(asked) is dict else {}
        found = _kobe_static["variables"](
            asked.get("limits"), shell.user_ns, shell.user_ns_hidden, shell.execution_count - 1, asked.get("show")
        )
    else:
        found = _kobe_static["doc"](code, shell.user_ns)
    return {"status": "ok", "found": False, "data": {}, "metadata": {"kobe": found}}
_ipk.IPythonKernel.do_complete = _kobe_complete
_ipk.IPythonKernel.do_inspect = _kobe_inspect
from ipykernel import kernelapp
kernelapp.launch_new_instance()
"""


INSPECT_LIMIT_KEYS = ("max_vars", "max_bytes", "repr_chars", "columns_max", "per_var_ms", "budget_ms")

COMPLETE_MATCHES_MAX = 100
COMPLETE_MATCH_MAX_CHARS = 200
COMPLETE_TYPE_MAX_CHARS = 32
COMPLETE_TIMEOUT_MAX_S = 2.0
DOC_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,15}")

# The documentation of a dotted name, read without running the member's code: the name resolves
# through the user namespace (then builtins) and the type, class and instance dicts only (a
# descriptor is returned, never invoked; a class with a metaclass other than `type` is not looked
# into); only signatures and docstrings are read, never a repr.
STATIC_SOURCE = r'''
import builtins as _builtins
import inspect as _inspect
import json as _json
import signal as _signal
import types as _types

SIGNATURE_MAX = 1000
DOC_MAX = 8000
DEFAULT_MAX = 40
# Only C-level descriptors, taken from the built-in types themselves: none of them can reach the
# member's code (no isinstance, whose __class__ fallback can; no getattr on member objects).
_qualname = type.__dict__["__qualname__"].__get__
_mro = type.__dict__["__mro__"].__get__
_dict_of = type.__dict__["__dict__"].__get__
_type_text_signature = type.__dict__["__text_signature__"].__get__
_module_dict = _types.ModuleType.__dict__["__dict__"].__get__
_func_doc = _types.FunctionType.__dict__["__doc__"].__get__
_func_code = _types.FunctionType.__dict__["__code__"].__get__
_func_defaults = _types.FunctionType.__dict__["__defaults__"].__get__
_func_kwdefaults = _types.FunctionType.__dict__["__kwdefaults__"].__get__
_method_func = _types.MethodType.__dict__["__func__"].__get__
_static_func = staticmethod.__dict__["__func__"].__get__
_class_func = classmethod.__dict__["__func__"].__get__
_prop_fget = property.__dict__["fget"].__get__
_C_ROUTINES = (
    _types.BuiltinFunctionType,
    _types.MethodDescriptorType,
    _types.WrapperDescriptorType,
    _types.MethodWrapperType,
    _types.ClassMethodDescriptorType,
)
_C_DESCRIPTORS = (_types.GetSetDescriptorType, _types.MemberDescriptorType)
# Defaults shown by value only for these exact built-in types (their repr is C code).
_PLAIN = (int, float, complex, bool, str, bytes, type(None))


def _clip(text, limit):
    if type(text) is not str:
        return None
    text = text.replace("\x00", "�").strip()
    if not text:
        return None
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _find(d, name, missing):
    # d[name] comparing only exact str keys: a member's key object is never hashed or compared.
    for k, v in _it.islice(d.items(), EXAMINE_MAX):
        if type(k) is str and k == name:
            return v
    return missing


def _defines(t, name):
    return any(klass is not object and _find(_dict_of(klass), name, _find) is not _find for klass in _mro(t))


def _lookup(t, name, missing):
    for klass in _mro(t):
        found = _find(_dict_of(klass), name, missing)
        if found is not missing:
            return found
    return missing


def _attr(parent, name, missing):
    # The raw attribute (a descriptor is returned, never invoked), read from dicts only.
    t = type(parent)
    if issubclass(t, _types.ModuleType):
        return _find(_module_dict(parent), name, missing), False
    if issubclass(t, type):
        # A class: only of the plain metaclass (a metaclass's hooks would run on any lookup).
        if t is not type:
            return missing, False
        return _lookup(parent, name, missing), False
    found = _lookup(t, name, missing)
    vt = type(found)
    data = found is not missing and (_defines(vt, "__set__") or _defines(vt, "__delete__"))
    if not data:
        d = _lookup(t, "__dict__", missing)
        if type(d) in _C_DESCRIPTORS:
            own = d.__get__(parent, t)
            if type(own) is dict:
                for k, v in _it.islice(own.items(), EXAMINE_MAX):
                    if type(k) is str and k == name:
                        return v, False
    # A plain function found through an instance is a method: its first parameter is bound.
    return found, type(found) is _types.FunctionType


def _resolve(name, ns):
    missing = object()
    parts = name.split(".")
    obj = _find(ns, parts[0], missing) if type(ns) is dict else missing
    if obj is missing:
        obj = _find(_builtins.__dict__, parts[0], missing)
    bound = False
    for part in parts[1:]:
        if obj is missing:
            break
        obj, bound = _attr(obj, part, missing)
    return None if obj is missing else (obj, bound)


def _class_doc(cls):
    # The first docstring in the class's MRO dicts (no attribute lookup on it), not object's.
    for klass in _mro(cls):
        if klass is object:
            break
        doc = _find(_dict_of(klass), "__doc__", None)
        if type(doc) is str:
            return doc
    return None


def _c_attr(obj, name):
    # A C attribute of a built-in callable (its type is one of _C_ROUTINES).
    for klass in _mro(type(obj)):
        desc = _find(_dict_of(klass), name, None)
        if desc is None:
            continue
        if type(desc) in _C_DESCRIPTORS:
            return desc.__get__(obj, type(obj))
        return desc if type(desc) is str else None
    return None


def _default(value):
    if type(value) not in _PLAIN:
        return "…"
    text = repr(value)
    return text if len(text) <= DEFAULT_MAX else text[: DEFAULT_MAX - 1] + "…"


def _drop_first(params):
    if params and params[0] not in ("/", "*") and not params[0].startswith("*"):
        params = params[1:]
        if params and params[0] == "/":
            params = params[1:]
    return params


def _function_signature(f, bound):
    # Read from the code object, never inspect.signature: that reads __signature__ and
    # __wrapped__ through getattr and formats defaults and annotations with their repr.
    code = _func_code(f)
    names = code.co_varnames
    count, posonly, kwonly = code.co_argcount, code.co_posonlyargcount, code.co_kwonlyargcount
    defaults = _func_defaults(f)
    defaults = defaults if type(defaults) is tuple else ()
    kwdefaults = _func_kwdefaults(f)
    kwdefaults = kwdefaults if type(kwdefaults) is dict else {}
    params = []
    first_default = count - len(defaults)
    for i in range(count):
        param = names[i]
        if i >= first_default:
            param += "=" + _default(defaults[i - first_default])
        params.append(param)
        if posonly and i == posonly - 1:
            params.append("/")
    varargs = bool(code.co_flags & 0x04)
    if varargs:
        params.append("*" + names[count + kwonly])
    elif kwonly:
        params.append("*")
    for name in names[count : count + kwonly]:
        given = [v for k, v in kwdefaults.items() if type(k) is str and k == name]
        params.append(name + ("=" + _default(given[0]) if given else ""))
    if code.co_flags & 0x08:
        params.append("**" + names[count + kwonly + (1 if varargs else 0)])
    return "(" + ", ".join(_drop_first(params) if bound else params) + ")"


def _text_signature(text):
    # A C signature ("($self, /, x)"): the bound "$" parameter and a "/" left alone dropped.
    if type(text) is not str or not text.startswith("(") or not text.endswith(")"):
        return None
    params = [p.strip() for p in text[1:-1].split(",") if p.strip()]
    if params and params[0].startswith("$"):
        params = params[1:]
        if params and params[0] == "/":
            params = params[1:]
    return "(" + ", ".join(params) + ")"


def _class_signature(cls):
    # Only for classes of the plain metaclass; from a plain __init__ or __new__, else C's own.
    if type(cls) is not type:
        return None
    for klass in _mro(cls):
        if klass is object:
            break
        d = _dict_of(klass)
        init, new = _find(d, "__init__", None), _find(d, "__new__", None)
        if type(init) is _types.FunctionType:
            return _function_signature(init, True)
        if type(new) is staticmethod and type(_static_func(new)) is _types.FunctionType:
            return _function_signature(_static_func(new), True)
        if init is not None or new is not None:
            break
    return _text_signature(_type_text_signature(cls))


def _describe(name, obj, bound=False):
    out = {"found": True, "type": _clip(_qualname(type(obj)), 256) or "?"}
    t = type(obj)
    if t is staticmethod:
        obj, t = _static_func(obj), None
    elif t is classmethod:
        obj, t, bound = _class_func(obj), None, True
    elif t is _types.MethodType:
        obj, t, bound = _method_func(obj), None, True
    t = type(obj)
    doc = signature = None
    if t is property:
        getter = _prop_fget(obj)
        doc = _func_doc(getter) if type(getter) is _types.FunctionType else None
    elif t is _types.FunctionType:
        doc, signature = _func_doc(obj), _function_signature(obj, bound)
    elif t in _C_ROUTINES:
        doc, signature = _c_attr(obj, "__doc__"), _text_signature(_c_attr(obj, "__text_signature__"))
    elif issubclass(t, type):
        doc, signature = _class_doc(obj), _class_signature(obj)
    elif issubclass(t, _types.ModuleType):
        doc = _find(_module_dict(obj), "__doc__", None)
    else:
        # Any other object: its type's docstring; nothing of the object itself is read.
        doc = _class_doc(t)
    if signature is not None:
        out["signature"] = _clip(name.rsplit(".", 1)[-1] + signature, SIGNATURE_MAX)
    out["doc"] = _clip(_inspect.cleandoc(doc) if type(doc) is str else None, DOC_MAX)
    return {k: v for k, v in out.items() if v is not None}


def doc(name, ns=None):
    # JSON text of the name's documentation. Inside the kernel, the IPython user namespace. Runs
    # nothing of the member's, so nothing is interrupted; not while a member's timer is pending
    # (its handler would run in the middle).
    if hasattr(_signal, "getitimer") and _signal.getitimer(_signal.ITIMER_REAL)[0] > 0:
        return _json.dumps({"error": "timer"})
    if ns is None:
        from IPython import get_ipython

        ns = get_ipython().user_ns
    try:
        found = _resolve(name, ns)
        result = {"found": False} if found is None else _describe(name, found[0], found[1])
    except KeyboardInterrupt:
        raise
    except BaseException:
        result = {"error": "raised"}
    return _json.dumps(result, ensure_ascii=True)

# ---- Completion (KOBE-808). Bounded everywhere: at most EXAMINE_MAX dict entries examined in
# all, RETURN_MAX matches, CHAIN_MAX steps, TAIL_MAX characters before the cursor, and a wall-clock
# budget checked between steps (what was found so far is returned when it runs out).
import itertools as _it
import re as _re
import time as _time

EXAMINE_MAX = 10_000
RETURN_MAX = 200
CHAIN_MAX = 10
TAIL_MAX = 300
PAREN_SCAN_MAX = 2_000
BUDGET_S = 0.2
_IPYTHON_NAMES = frozenset(("In", "Out", "exit", "quit", "get_ipython"))
_STR_KEY = r"'[^'\\\[\]\n]*'|" + r'"[^"\\\[\]\n]*"'
_CHAIN = r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[(?:" + _STR_KEY + r"|-?\d+)\])*"
_STEP = _re.compile(r"([A-Za-z_]\w*)|\.([A-Za-z_]\w*)|\[(?:'([^'\\\[\]\n]*)'|" + r'"([^"\\\[\]\n]*)"' + r"|(-?\d+))\]")
_KEY_AT_END = _re.compile("(" + _CHAIN + r")\[(['" + '"' + r"]?)([^'" + '"' + r"\\\[\]\n]*)$")
_ATTR_AT_END = _re.compile("(" + _CHAIN + r")\.(\w*)$")
_NAME_AT_END = _re.compile(r"([A-Za-z_]\w*)$")
_CALLEE_AT_END = _re.compile("(" + _CHAIN + r")\s*$")
_ARG_AT_END = _re.compile(r"[(,]\s*([A-Za-z_]\w*|)$")


class _Stop(Exception):
    pass


class _Budget:
    def __init__(self):
        self.deadline = _time.monotonic() + BUDGET_S
        self.examined = 0

    def ok(self):
        return self.examined < EXAMINE_MAX and _time.monotonic() < self.deadline

    def take(self, iterable):
        # At most what is left of the cap, and stops when the time is up.
        for item in _it.islice(iterable, max(0, EXAMINE_MAX - self.examined)):
            self.examined += 1
            if self.examined % 256 == 0 and _time.monotonic() >= self.deadline:
                return
            yield item


def _is_plain(value):
    t = type(value)
    if t is tuple:
        return len(value) <= 8 and all(_is_plain(v) for v in value)
    return t in _PLAIN


def _own_dict(obj, t):
    d = _lookup(t, "__dict__", None)
    if type(d) in _C_DESCRIPTORS:
        own = d.__get__(obj, t)
        if type(own) is dict:
            return own
    return None


def _str_get(d, name, budget):
    # A str-keyed lookup comparing only exact str keys (never a member key's __eq__).
    for k, v in budget.take(d.items()):
        if type(k) is str and k == name:
            return v
    raise _Stop(name)


def _class_value(value):
    vt = type(value)
    if vt is _types.FunctionType or vt in _C_ROUTINES:
        return value
    if vt is staticmethod:
        return _static_func(value)
    if vt is classmethod:
        return _class_func(value)
    if _defines(vt, "__get__"):
        # A property, cached_property or any other descriptor: its getter would run.
        raise _Stop("descriptor")
    return value


def _static_attr(obj, name, budget):
    # (value, bound): only plain values, functions, static/class methods and C-level descriptors.
    t = type(obj)
    if issubclass(t, _types.ModuleType):
        return _str_get(_module_dict(obj), name, budget), False
    if issubclass(t, type):
        if t is not type:
            raise _Stop("metaclass")
        found = _lookup(obj, name, _Stop)
        if found is _Stop:
            raise _Stop(name)
        return _class_value(found), False
    if _defines(t, "__getattribute__"):
        raise _Stop("__getattribute__")
    found = _lookup(t, name, _Stop)
    if found is not _Stop and type(found) in _C_DESCRIPTORS:
        return found.__get__(obj, t), False
    vt = type(found)
    if found is not _Stop and (_defines(vt, "__set__") or _defines(vt, "__delete__")):
        raise _Stop("data descriptor")
    own = _own_dict(obj, t)
    if own is not None:
        for k, v in budget.take(own.items()):
            if type(k) is str and k == name:
                return v, False
    if found is _Stop:
        raise _Stop(name)
    return _class_value(found), type(found) is _types.FunctionType


def _static_item(obj, key, budget):
    t = type(obj)
    if t is dict:
        kt = type(key)
        for k, v in budget.take(obj.items()):
            # Same exact type, and plain (a tuple's members are compared too): no member __eq__.
            if type(k) is kt and _is_plain(k) and k == key:
                return v
        raise _Stop("key")
    if (t is list or t is tuple) and type(key) is int and -len(obj) <= key < len(obj):
        return obj[key]
    raise _Stop("container")


def _resolve_chain(text, ns, budget):
    # (value, bound) of a chain like `a.b['k'][0].c`, or _Stop.
    steps = list(_it.islice(_STEP.finditer(text), CHAIN_MAX + 2))
    if not steps or len(steps) > CHAIN_MAX + 1 or steps[0].group(1) is None:
        raise _Stop("chain")
    first = steps[0].group(1)
    obj = _find(ns, first, _Stop) if type(ns) is dict else _Stop
    if obj is _Stop:
        obj = _find(_builtins.__dict__, first, _Stop)
    if obj is _Stop:
        raise _Stop(first)
    bound = False
    for step in steps[1:]:
        if not budget.ok():
            raise _Stop("budget")
        attr, s1, s2, num = step.group(2), step.group(3), step.group(4), step.group(5)
        if attr is not None:
            obj, bound = _static_attr(obj, attr, budget)
        else:
            key = s1 if s1 is not None else s2 if s2 is not None else int(num)
            obj, bound = _static_item(obj, key, budget), False
    return obj, bound


def _kind(value, name_kind):
    t = type(value)
    if t is _types.FunctionType or t in _C_ROUTINES or t in (staticmethod, classmethod):
        return "function"
    if issubclass(t, type):
        return "class"
    if issubclass(t, _types.ModuleType):
        return "module"
    if t is property or _defines(t, "__get__"):
        return "property"
    return name_kind


def _wanted(name, prefix):
    return (
        type(name) is str
        and name.startswith(prefix)
        and (prefix.startswith("_") or not name.startswith("_"))
        and len(name) <= 200
    )


def _names(dicts, prefix, kind, budget, skip=frozenset()):
    found = {}
    for d in dicts:
        for k, v in budget.take(d.items()):
            # The type first: a member's key object is never hashed or compared.
            if type(k) is str and _wanted(k, prefix) and k not in found and k not in skip:
                found[k] = _kind(v, kind)
                if len(found) >= RETURN_MAX:
                    return found
        if not budget.ok():
            break
    return found


def _pandas_frame():
    m = _find(_sys_modules(), "pandas", None)
    if type(m) is not _types.ModuleType:
        return None
    t = _find(_module_dict(m), "DataFrame", None)
    return t if type(t) is type else None


def _sys_modules():
    import sys

    return sys.modules


def _c_attr_of(obj, name):
    # A C-level getset/member attribute of obj (found in its type's dicts), else _Stop.
    t = type(obj)
    found = _lookup(t, name, None)
    if type(found) in _C_DESCRIPTORS:
        return found.__get__(obj, t)
    raise _Stop(name)


def _frame_columns(frame, budget):
    # A DataFrame's column labels without running pandas: _mgr (instance dict) -> axes (C
    # getset) -> the columns Index's _data, when it is a numpy object array (or a StringArray over
    # one). Labels stored any other way (pyarrow strings) are not offered.
    np = _find(_sys_modules(), "numpy", None)
    if type(np) is not _types.ModuleType:
        return []
    ndarray = _find(_module_dict(np), "ndarray", None)
    own = _own_dict(frame, type(frame))
    mgr = _find(own, "_mgr", None) if own is not None else None
    axes = _c_attr_of(mgr, "axes") if mgr is not None else None
    if type(axes) is not list or not axes:
        return []
    index_dict = _own_dict(axes[0], type(axes[0]))
    data = _find(index_dict, "_data", None) if index_dict is not None else None
    if type(data) is not ndarray and data is not None:
        # pandas 3's Python-backed str labels: a StringArray's `_ndarray` is a C-level getset of
        # pandas' NDArrayBacked (pyarrow-backed labels have no such field: not offered).
        try:
            data = _c_attr_of(data, "_ndarray")
        except _Stop:
            data = None
    if type(data) is not ndarray or _c_attr_of(data, "ndim") != 1:
        return []
    return [c for c in budget.take(iter(data)) if type(c) is str]


def _attributes(obj, prefix, budget):
    t = type(obj)
    if issubclass(t, _types.ModuleType):
        return _names([_module_dict(obj)], prefix, "attribute", budget)
    if issubclass(t, type):
        if t is not type:
            return {}
        return _names([_dict_of(k) for k in _mro(obj)], prefix, "attribute", budget)
    dicts = []
    own = _own_dict(obj, t)
    if own is not None:
        dicts.append(own)
    dicts.extend(_dict_of(k) for k in _mro(t))
    found = _names(dicts, prefix, "attribute", budget)
    if t is _pandas_frame() and len(found) < RETURN_MAX:
        for column in _frame_columns(obj, budget):
            if column.isidentifier() and _wanted(column, prefix):
                found.setdefault(column, "attribute")
    return found


def _keys(obj, prefix, quoted, budget):
    t = type(obj)
    if t is dict:
        keys = [k for k in budget.take(iter(obj)) if type(k) in (str, int, float, bool)]
    elif t is _pandas_frame():
        keys = _frame_columns(obj, budget)
    else:
        return {}
    found = {}
    for k in keys:
        if quoted:
            text = k if type(k) is str else None
        else:
            text = repr(k)
        if text is not None and text.startswith(prefix) and len(text) <= 200:
            found.setdefault(text, "dict key")
            if len(found) >= RETURN_MAX:
                break
    return found


def _parameters(value, bound):
    # Keyword-capable parameter names, statically: a function's code object, a plain class's
    # __init__/__new__, or a built-in's text signature. Nothing else is asked.
    t = type(value)
    if t is _types.FunctionType:
        code = _func_code(value)
        names = list(code.co_varnames[: code.co_argcount + code.co_kwonlyargcount])
        posonly = code.co_posonlyargcount
        skip = posonly + (1 if bound and code.co_argcount > posonly and posonly == 0 else 0)
        return names[skip:]
    if t is type:
        for klass in _mro(value):
            if klass is object:
                break
            d = _dict_of(klass)
            init, new = _find(d, "__init__", None), _find(d, "__new__", None)
            if type(init) is _types.FunctionType:
                return _parameters(init, True)
            if type(new) is staticmethod and type(_static_func(new)) is _types.FunctionType:
                return _parameters(_static_func(new), True)
            if init is not None or new is not None:
                break
        return _text_parameters(_type_text_signature(value))
    if t in _C_ROUTINES:
        return _text_parameters(_c_attr(value, "__text_signature__"))
    return []


def _text_parameters(text):
    if type(text) is not str or not text.startswith("(") or not text.endswith(")"):
        return []
    params = [p.strip() for p in text[1:-1].split(",") if p.strip()]
    if "/" in params:
        params = params[params.index("/") + 1 :]
    names = []
    for p in params:
        name = p.split("=", 1)[0].strip()
        if name and not name.startswith(("$", "*")) and name.isidentifier():
            names.append(name)
    return names


def _open_call(tail):
    # Index of the innermost unclosed "(" in tail (strings not parsed), or -1.
    depth = 0
    for i in range(len(tail) - 1, max(-1, len(tail) - 1 - PAREN_SCAN_MAX), -1):
        ch = tail[i]
        if ch in ")]}":
            depth += 1
        elif ch in "([{":
            if depth == 0:
                return i if ch == "(" else -1
            depth -= 1
    return -1


def _chain_before(text, end):
    # The chain ending at `end`, if it starts where a chain may start (not after . ) ] or a name).
    window_start = max(0, end - TAIL_MAX)
    m = _CALLEE_AT_END.search(text, window_start, end)
    if m is None:
        return None
    start = m.start(1)
    if start > 0 and (text[start - 1] in ".)]'\"" or text[start - 1].isalnum() or text[start - 1] == "_"):
        return None
    return m.group(1)


def _complete(head, ns, hidden):
    budget = _Budget()
    matches = {}
    start = len(head)
    key = _KEY_AT_END.search(head, max(0, len(head) - TAIL_MAX))
    attr = _ATTR_AT_END.search(head, max(0, len(head) - TAIL_MAX))
    if key is not None and _chain_before(head, key.start(2) - 1) == key.group(1):
        try:
            obj, _ = _resolve_chain(key.group(1), ns, budget)
            matches = _keys(obj, key.group(3), key.group(2) != "", budget)
        except _Stop:
            matches = {}
        start = len(head) - len(key.group(3))
    elif attr is not None and _chain_before(head, attr.start(2) - 1) == attr.group(1):
        try:
            obj, _ = _resolve_chain(attr.group(1), ns, budget)
            matches = _attributes(obj, attr.group(2), budget)
        except _Stop:
            matches = {}
        start = len(head) - len(attr.group(2))
    else:
        arg = _ARG_AT_END.search(head, max(0, len(head) - TAIL_MAX))
        name = _NAME_AT_END.search(head, max(0, len(head) - TAIL_MAX))
        prefix = name.group(1) if name is not None else ""
        if name is not None and name.start(1) > 0:
            before = head[name.start(1) - 1]
            if before.isalnum() or before in "._":
                prefix = None
        start = len(head) - len(prefix or "")
        tail = head[max(0, len(head) - PAREN_SCAN_MAX) :]
        call = _open_call(tail)
        if arg is not None and call >= 0 and prefix is not None:
            callee = _chain_before(tail, call)
            if callee is not None:
                try:
                    value, bound = _resolve_chain(callee, ns, budget)
                    for p in _parameters(value, bound):
                        if p.startswith(prefix):
                            matches.setdefault(p + "=", "param")
                except _Stop:
                    pass
        if prefix:
            skip = _IPYTHON_NAMES | frozenset(k for k in budget.take(hidden) if type(k) is str)
            for k, v in _names([ns], prefix, "variable", budget, skip).items():
                matches.setdefault(k, v)
    ordered = sorted(matches.items(), key=lambda kv: (kv[1] != "param", kv[0].lower()))
    return {
        "matches": [{"text": k, "type": v} for k, v in ordered[:RETURN_MAX]],
        "cursor_start": start,
    }


def complete(code, cursor, ns=None, hidden=None):
    # JSON text of the completions at `cursor` (code points into `code`). Inside the kernel, the
    # IPython user namespace. Runs nothing of the member's; not while a member's timer is pending.
    if hasattr(_signal, "getitimer") and _signal.getitimer(_signal.ITIMER_REAL)[0] > 0:
        return _json.dumps({"error": "timer"})
    if ns is None:
        from IPython import get_ipython

        shell = get_ipython()
        ns, hidden = shell.user_ns, shell.user_ns_hidden
    if type(code) is not str or type(cursor) is not int or not 0 <= cursor <= len(code):
        return _json.dumps({"error": "invalid"})
    try:
        result = _complete(code[:cursor], ns, hidden if type(hidden) is dict else {})
    except KeyboardInterrupt:
        raise
    except BaseException:
        result = {"error": "raised"}
    return _json.dumps(result, ensure_ascii=True)

# ---- Variables snapshot (KOBE-803, transport KOBE-816). No member code runs: values are shown
# only for exact built-in scalars, strings, bytes and containers (elements by the same rule, a
# bounded depth and count; a subclass of a built-in container is read through the built-in's own
# C methods), ranges, and exact numpy arrays and pandas frames and series (library code on library
# objects: numeric array values, shapes, lengths, dtypes and plain column labels). Anything else
# shows its type name only (`repr_error: "not_read"`): its repr, str, len or iteration is never
# called. Bounded by count, bytes, characters and a time budget checked between variables.
_VAR_FUNCTION_TYPES = (
    _types.FunctionType,
    _types.BuiltinFunctionType,
    _types.MethodType,
    _types.BuiltinMethodType,
    _types.MethodWrapperType,
    _types.WrapperDescriptorType,
)
_VAR_SCALARS = (int, float, complex, bool, type(None))
_VAR_TEXT = (str, bytes, bytearray)
_VAR_CONTAINERS = (list, tuple, dict, set, frozenset)
_VAR_SIZED = _VAR_TEXT + _VAR_CONTAINERS + (range,)
_VAR_ITEMS = 8
_VAR_DEPTH = 2
_VAR_INT_DIGITS = 200
_TYPE_MODULE = type.__dict__["__module__"].__get__


def _type_names(t):
    try:
        name = _qualname(t)
    except Exception:
        name = "?"
    try:
        module = _TYPE_MODULE(t)
    except Exception:
        module = None
    module = module.split(".")[0] if type(module) is str else None
    name = _clip(name, 256) or "?"
    return name, (None if module in (None, "builtins") else _clip(module, 128))


def _var_kind(t):
    if issubclass(t, _types.ModuleType):
        return "module"
    if issubclass(t, type):
        return "class"
    if issubclass(t, _VAR_FUNCTION_TYPES):
        return "function"
    return None


def _library(module, name):
    # A library class, compared by identity only (`type(v) is _library(...)`); its metaclass
    # may be `type` or `abc.ABCMeta` (fractions.Fraction).
    m = _find(_sys_modules(), module, None)
    if type(m) is not _types.ModuleType:
        return None
    t = _find(_module_dict(m), name, None)
    abcs = _find(_sys_modules(), "abc", None)
    abc_meta = _find(_module_dict(abcs), "ABCMeta", None) if type(abcs) is _types.ModuleType else None
    return t if type(t) is type or (abc_meta is not None and type(t) is abc_meta) else None


def _int_text(value):
    # int.__repr__ is C; a huge int is summarised (its repr is quadratic and refused past 4300).
    bits = int.bit_length(value)
    if bits > _VAR_INT_DIGITS * 3.33:
        return "<int of about %d digits>" % int(bits / 3.3219)
    return int.__repr__(value)


def _scalar_text(value, t):
    if t is int or t is bool:
        return _int_text(value) if t is int else bool.__repr__(value)
    if t is type(None):
        return "None"
    return float.__repr__(value) if t is float else complex.__repr__(value)


def _slot(t, name, value):
    # A __slots__ field read through the class's own member descriptor (C), else _Stop.
    desc = _lookup(t, name, None)
    if type(desc) is not _types.MemberDescriptorType:
        raise _Stop(name)
    return desc.__get__(value, t)


def _plain_tz(tz):
    # A tzinfo whose methods and repr are library code over plain fields: None, an exact
    # datetime.timezone whose name is an exact str, or an exact ZoneInfo whose key is an exact
    # str or None (both read through C, never the object's own methods).
    if tz is None:
        return True
    timezone = _library("datetime", "timezone")
    if type(tz) is timezone:
        return type(timezone.tzname(tz, None)) is str
    zoneinfo = _library("zoneinfo", "ZoneInfo")
    if zoneinfo is not None and type(tz) is zoneinfo:
        desc = _lookup(zoneinfo, "key", None)
        if type(desc) not in _C_DESCRIPTORS:
            return False
        key = desc.__get__(tz, zoneinfo)
        return key is None or type(key) is str
    return False


def _stdlib_text(value, t):
    # EXACT standard-library types whose text runs no member code (never a subclass); None when
    # `value` is not one of them, or one holding something that would (a member's tzinfo).
    if t is type(Ellipsis):
        return "Ellipsis"
    if t is type(NotImplemented):
        return "NotImplemented"
    if t is type:
        return _clip(_qualname(value), 128)
    if t is _types.BuiltinFunctionType:
        name = _types.BuiltinFunctionType.__dict__["__name__"].__get__(value)
        return "<built-in function %s>" % _clip(name, 128)
    if t is _types.ModuleType:
        name = _find(_module_dict(value), "__name__", None)
        return "<module %s>" % (str.__repr__(name) if type(name) is str else "?")
    dt = _find(_sys_modules(), "datetime", None)
    if type(dt) is _types.ModuleType:
        # Compared by identity (a member's class with a hooked metaclass is never hashed).
        kind = next(
            (n for n in ("datetime", "date", "time", "timedelta", "timezone") if t is _library("datetime", n)),
            None,
        )
        if kind in ("date", "timedelta"):
            return t.__repr__(value)
        if kind == "timezone":
            return t.__repr__(value) if _plain_tz(value) else None
        if kind in ("datetime", "time"):
            # A member's tzinfo subclass would run its utcoffset/tzname/repr: type only then.
            tz = _lookup(t, "tzinfo", None).__get__(value, t)
            return t.__repr__(value) if _plain_tz(tz) else None
    if t is _library("decimal", "Decimal"):
        return t.__repr__(value)
    if t is _library("fractions", "Fraction"):
        try:
            n, d = _slot(t, "_numerator", value), _slot(t, "_denominator", value)
        except _Stop:
            return None
        if type(n) is not int or type(d) is not int:
            return None
        return "Fraction(%s, %s)" % (_int_text(n), _int_text(d))
    if t is _library("uuid", "UUID"):
        try:
            n = _slot(t, "int", value)
        except _Stop:
            return None
        if type(n) is not int or not 0 <= n < 1 << 128:
            return None
        h = "%032x" % n
        return "UUID('%s-%s-%s-%s-%s')" % (h[:8], h[8:12], h[12:16], h[16:20], h[20:])
    for name in ("PurePosixPath", "PosixPath", "PureWindowsPath", "WindowsPath"):
        if t is _library("pathlib", name):
            return _path_text(value, t)
    return None


_PATH_SLOTS = (
    "_raw_paths",
    "_drv",
    "_root",
    "_tail_cached",
    "_str",
    "_str_normcase_cached",
    "_parts_normcase_cached",
    "_lines_cached",
    "_hash",
)


def _path_text(value, t):
    # pathlib's own repr (library code) only when every field it may read is an exact str (or a
    # list of them, or the cached int hash): a str subclass there would have its methods called.
    for name in _PATH_SLOTS:
        desc = _lookup(t, name, None)
        if desc is None:
            continue
        if type(desc) is not _types.MemberDescriptorType:
            return None
        try:
            field = desc.__get__(value, t)
        except AttributeError:
            continue
        ft = type(field)
        if ft is str or ft is int or field is None:
            continue
        if ft is list and all(type(p) is str for p in _it.islice(field, 1000)) and len(field) <= 1000:
            continue
        return None
    return t.__repr__(value)


# Credential-like names (KOBE-816; the web's isSensitive implements the same rule, and both are
# tested against images/sandbox/kernel/secret-name-cases.json). The name is split into lowercase
# tokens (camelCase boundaries and any non-alphanumeric character separate), and it is
# credential-like when a token is one of _SECRET_TOKENS (unless the next token is one of
# _NOT_SECRET_NEXT: `token_count`), "key" alone or after a qualifier (`api_key`, `x-api-key`), or
# conn/connection followed by str/string. "author", "authors" and "authored" are other tokens.
# A top-level variable named so is sent without its value; inside a shown dict (or a 2-tuple pair)
# the value under such a key is "<hidden>"; until the member asks for that one variable (Show).
_SECRET_TOKENS = frozenset((
    "password", "passwd", "pwd", "passphrase", "secret", "secrets", "token", "auth",
    "authorization", "authorisation", "bearer", "credential", "credentials", "creds", "cookie",
    "cookies", "session", "sessionid", "dsn", "jwt", "apikey", "accesskey", "privatekey",
    "secretkey", "signingkey", "connstr", "connectionstring",
))
_KEY_QUALIFIERS = frozenset(("api", "access", "private", "secret", "signing", "encryption", "master", "client"))
_NOT_SECRET_NEXT = frozenset(("count", "counts", "len", "length", "size", "limit", "type"))
_CAMEL = _re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")
_TOKEN_SPLIT = _re.compile(r"[^a-z0-9]+")
# userinfo in a URL-looking string (a user name, a colon, a password and "@" after the scheme)
_URL_USERINFO = _re.compile(r"([A-Za-z][A-Za-z0-9+.\-]*://)[^/@\s:]+:[^/@\s]*@")


def _name_tokens(name):
    return [t for t in _TOKEN_SPLIT.split(_CAMEL.sub(" ", name).lower()) if t]


def _secret(name):
    if type(name) is bytes:
        try:
            name = bytes.decode(name, "utf-8")
        except UnicodeDecodeError:
            return False
    if type(name) is not str:
        return False
    tokens = _name_tokens(str.__getitem__(name, slice(0, 256)))
    if tokens == ["key"]:
        return True
    for i, tok in enumerate(tokens):
        nxt = tokens[i + 1] if i + 1 < len(tokens) else None
        if tok in _SECRET_TOKENS and nxt not in _NOT_SECRET_NEXT:
            return True
        if tok == "key" and i > 0 and tokens[i - 1] in _KEY_QUALIFIERS:
            return True
        if tok in ("conn", "connection") and nxt in ("str", "string"):
            return True
    return False


class _Render:
    # A bounded text of a value by the rule above; `left` characters at most. With `mask`, values
    # under credential-like keys of dicts are "<hidden>" (`masked` then says so).
    def __init__(self, limit, mask=False):
        self.left = limit
        self.mask = mask
        self.masked = False

    def text_part(self, value):
        # The shown part of an exact str; with `mask`, the userinfo of URL-looking text hidden
        # (looked for a little past the cut, so a cut never shows half a password).
        left = max(1, self.left)
        if not self.mask:
            return str.__getitem__(value, slice(0, left))
        chunk = str.__getitem__(value, slice(0, left + 512))
        hidden = _URL_USERINFO.sub(r"\1<hidden>@", chunk)
        if hidden != chunk:
            self.masked = True
        return str.__getitem__(hidden, slice(0, left))

    def put(self, parts, text):
        parts.append(text)
        self.left -= len(text)

    def value(self, value, depth):
        t = type(value)
        if t in _VAR_SCALARS:
            return _scalar_text(value, t)
        if t is str:
            return str.__repr__(self.text_part(value))
        if t is bytes or t is bytearray:
            return repr(bytes(t.__getitem__(value, slice(0, max(1, self.left)))))
        if t is range:
            return range.__repr__(value)
        base = next((b for b in _VAR_CONTAINERS if t is b), None)
        if base is None:
            known = _stdlib_text(value, t)
            return known if known is not None else "<%s>" % _type_names(t)[0]
        return self.container(value, base, depth)

    def container(self, value, base, depth):
        n = base.__len__(value)
        open_, close = {list: "[]", tuple: "()", dict: "{}", set: "{}", frozenset: "{}"}[base]
        if base is frozenset:
            open_, close = "frozenset({", "})"
        if n == 0:
            return {list: "[]", tuple: "()", dict: "{}", set: "set()", frozenset: "frozenset()"}[base]
        if depth >= _VAR_DEPTH:
            return open_ + "..." + close
        if base is tuple and n == 2 and self.mask:
            first, second = tuple.__getitem__(value, 0), tuple.__getitem__(value, 1)
            if _secret(first):
                # A (name, value) pair whose name is credential-like: the value is withheld.
                self.masked = True
                return "(" + self.value(first, depth + 1) + ", <hidden>)"
        parts = []
        shown = 0
        items = dict.items(value) if base is dict else base.__iter__(value)
        for item in _it.islice(items, _VAR_ITEMS):
            if self.left <= 0:
                break
            if shown:
                self.put(parts, ", ")
            if base is dict:
                k, v = item
                if self.mask and _secret(k):
                    self.masked = True
                    shown_value = "<hidden>"
                else:
                    shown_value = self.value(v, depth + 1)
                self.put(parts, self.value(k, depth + 1) + ": " + shown_value)
            else:
                self.put(parts, self.value(item, depth + 1))
            shown += 1
        if shown < n:
            parts.append(", ..." if parts else "...")
        trailing = "," if base is tuple and n == 1 else ""
        return open_ + "".join(parts) + trailing + close


def _field(obj, name):
    # An attribute read from the instance dict, else through a C-level descriptor of its type;
    # _Stop otherwise (never the object's own __getattr__, property or method).
    t = type(obj)
    own = _own_dict(obj, t)
    if own is not None:
        found = _find(own, name, _Stop)
        if found is not _Stop:
            return found
    desc = _lookup(t, name, None)
    if type(desc) in _C_DESCRIPTORS:
        return desc.__get__(obj, t)
    raise _Stop(name)


_PANDAS_INDEXES = (
    "Index",
    "DatetimeIndex",
    "TimedeltaIndex",
    "PeriodIndex",
    "CategoricalIndex",
    "IntervalIndex",
)
_PANDAS_DTYPES = (
    "ArrowDtype", "BooleanDtype", "CategoricalDtype", "DatetimeTZDtype", "Float32Dtype",
    "Float64Dtype", "Int16Dtype", "Int32Dtype", "Int64Dtype", "Int8Dtype", "IntervalDtype",
    "PeriodDtype", "SparseDtype", "StringDtype", "UInt16Dtype", "UInt32Dtype", "UInt64Dtype",
    "UInt8Dtype",
)
_ARRAY_ITEMS = 6


def _module_classes(module, names):
    m = _find(_sys_modules(), module, None)
    if type(m) is not _types.ModuleType:
        return ()
    d = _module_dict(m)
    return tuple(c for c in (_find(d, n, None) for n in names) if c is not None)


class _Snapshot:
    def __init__(self, limits, show=None):
        get = lambda k, d: int(limits.get(k, d)) if type(limits.get(k, d)) is int else d
        self.max_vars = get("max_vars", 200)
        self.max_bytes = get("max_bytes", 65536)
        self.repr_chars = get("repr_chars", 200)
        self.columns_max = get("columns_max", 50)
        self.deadline = _time.monotonic() + get("budget_ms", 2000) / 1000
        self.show = show
        self.mask = show is None
        # Library classes, compared by identity only (a `__module__` can be spoofed).
        self.ndarray = _library("numpy", "ndarray")
        self.frame = _library("pandas", "DataFrame")
        self.series = _library("pandas", "Series")
        np_dtype = _module_classes("numpy", ("dtype",))
        self.np_dtype_meta = type(np_dtype[0]) if np_dtype else None
        self.pd_dtypes = _module_classes("pandas", _PANDAS_DTYPES)
        self.pd_arrays = _module_classes("pandas.arrays", (
            "ArrowExtensionArray", "ArrowStringArray", "BooleanArray", "Categorical",
            "DatetimeArray", "FloatingArray", "IntegerArray", "IntervalArray",
            "NumpyExtensionArray", "PeriodArray", "SparseArray", "StringArray", "TimedeltaArray",
        ))
        self.pd_indexes = _module_classes("pandas", _PANDAS_INDEXES)
        range_index = _module_classes("pandas", ("RangeIndex",))
        multi_index = _module_classes("pandas", ("MultiIndex",))
        self.range_index = range_index[0] if range_index else None
        self.multi_index = multi_index[0] if multi_index else None

    def text(self, value, render=None):
        render = render or _Render(self.repr_chars, self.mask)
        return _clip_keep(render.value(value, 0), self.repr_chars)

    def library_text(self, value):
        # A label or dtype of a library object: plain values by the rule; numpy's and pandas' own
        # dtype objects (identified by class identity) by their library text; else the type name.
        t = type(value)
        if t in _VAR_SCALARS or t is str:
            return _clip_keep(_Render(128).value(value, 1) if t is not str else value, 128)
        if (self.np_dtype_meta is not None and type(t) is self.np_dtype_meta) or any(
            t is c for c in self.pd_dtypes
        ):
            return _clip_keep(str(value), 128)
        return "<%s>" % _type_names(t)[0]

    def allowed_array(self, a):
        t = type(a)
        return (self.ndarray is not None and t is self.ndarray) or any(t is c for c in self.pd_arrays)

    def allowed_index(self, index, depth=0):
        t = type(index)
        if self.range_index is not None and t is self.range_index:
            return True
        if self.multi_index is not None and t is self.multi_index:
            # A MultiIndex: each level must be an allowed index (its labels are built from them).
            try:
                levels = _field(index, "_levels")
            except _Stop:
                return False
            if not issubclass(type(levels), list) or depth > 0:
                return False
            return all(self.allowed_index(level, 1) for level in _it.islice(list.__iter__(levels), 64))
        if not any(t is c for c in self.pd_indexes):
            return False
        try:
            return self.allowed_array(_field(index, "_data"))
        except _Stop:
            return False

    def pandas_backed(self, obj):
        # Every block's values and every axis are numpy arrays or pandas' own arrays and indexes
        # (checked through dicts and C attributes only): no member ExtensionArray gets asked.
        try:
            mgr = _field(obj, "_mgr")
            blocks, axes = _field(mgr, "blocks"), _field(mgr, "axes")
        except _Stop:
            return False
        if type(blocks) not in (list, tuple) or type(axes) is not list or len(blocks) > 10_000:
            return False
        try:
            if not all(self.allowed_array(_field(b, "values")) for b in blocks):
                return False
        except _Stop:
            return False
        return all(self.allowed_index(ax) for ax in axes[:4])

    def array_text(self, a, depth):
        # A preview of an exact numeric ndarray built here from `tolist()` of small slices (plain
        # Python numbers rendered by the scalar rule): numpy's print options never apply.
        nd = self.ndarray
        shape = nd.__dict__["shape"].__get__(a)
        if len(shape) == 0:
            x = nd.tolist(a)
            return _scalar_text(x, type(x)) if type(x) in _VAR_SCALARS else "?"
        n = shape[0]
        if len(shape) == 1:
            head = nd.tolist(nd.__getitem__(a, slice(0, _ARRAY_ITEMS)))
            parts = [_scalar_text(x, type(x)) if type(x) in _VAR_SCALARS else "?" for x in head]
        elif depth >= 2:
            return "[...]"
        else:
            parts = [self.array_text(nd.__getitem__(a, i), depth + 1) for i in range(min(n, 3))]
        if n > len(parts):
            parts.append("...")
        return "[" + ", ".join(parts) + "]"

    def describe(self, value, t):
        out = {}
        render = _Render(self.repr_chars, self.mask)
        if t in _VAR_SCALARS or t in _VAR_TEXT or t in _VAR_CONTAINERS or t is range:
            if t in _VAR_SIZED:
                out["len"] = t.__len__(value)
            out["repr"] = self.text(value, render)
            out["masked"] = render.masked
            return out
        known = _stdlib_text(value, t)
        if known is not None:
            out["repr"] = _clip_keep(known, self.repr_chars)
            return out
        if (self.frame is not None and t is self.frame) or (self.series is not None and t is self.series):
            if not self.pandas_backed(value):
                # Backed by an array type not pandas' or numpy's own (a member's ExtensionArray).
                out["repr"], out["repr_error"] = "", "not_read"
                return out
        if self.frame is not None and t is self.frame:
            columns = value.columns
            rows, cols = len(value.index), len(columns)
            labels = list(_it.islice(iter(columns), self.columns_max))
            plain = all(type(c) in _VAR_SCALARS or type(c) is str for c in labels)
            dtypes = list(_it.islice(value.dtypes.items(), self.columns_max)) if plain else []
            out["shape"] = [rows, cols]
            out["columns_total"] = cols
            out["columns"] = [
                {"name": self.library_text(c), "dtype": self.library_text(d)} for c, d in dtypes
            ] if plain else [{"name": self.library_text(c), "dtype": "?"} for c in labels]
            out["repr"] = "DataFrame: %d rows × %d columns" % (rows, cols)
            return out
        if self.series is not None and t is self.series:
            n = len(value)
            out["len"], out["shape"] = n, [n]
            out["dtype"] = self.library_text(value.dtype)
            out["repr"] = "Series: %d values (%s)" % (n, out["dtype"])
            return out
        if self.ndarray is not None and t is self.ndarray:
            out["shape"] = [int(d) for d in self.ndarray.__dict__["shape"].__get__(value)][:64]
            dtype = self.ndarray.__dict__["dtype"].__get__(value)
            out["dtype"] = self.library_text(dtype)
            kind = _field(dtype, "kind") if self.np_dtype_meta is not None and type(type(dtype)) is self.np_dtype_meta else None
            if type(kind) is str and kind in "biufc" and len(kind) == 1:
                out["repr"] = _clip_keep(self.array_text(value, 0), self.repr_chars)
            else:
                out["repr"] = ""
                out["repr_error"] = "not_read"
            return out
        base = next((b for b in _VAR_SIZED if issubclass(t, b)), None)
        if base is not None:
            # A subclass of a built-in container or string: the built-in's own length and items
            # (its C methods), never the subclass's repr, len or iteration.
            out["len"] = base.__len__(value)
            if base is str:
                part = str(str.__getitem__(value, slice(0, self.repr_chars + 512)))
                out["repr"] = _clip_keep(render.value(part, 0), self.repr_chars)
                out["masked"] = render.masked
            elif base in _VAR_TEXT:
                out["repr"] = _clip_keep(repr(base(base.__getitem__(value, slice(0, self.repr_chars)))), self.repr_chars)
            elif base is range:
                out["repr"] = ""
                out["repr_error"] = "not_read"
            else:
                out["repr"] = _clip_keep(render.container(value, base, 0), self.repr_chars)
                out["masked"] = render.masked
            return out
        out["repr"] = ""
        out["repr_error"] = "not_read"
        return out

    def variable(self, name, value, t):
        type_name, module = _type_names(t)
        item = {"name": _clip_keep(name, 256), "type": type_name}
        if module is not None:
            item["module"] = module
        if self.mask and _secret(name):
            # A credential-like name: no value leaves the kernel until the member asks (Show).
            return {**item, "repr": "", "hidden": "name"}
        try:
            described = self.describe(value, t)
        except KeyboardInterrupt:
            raise
        except Exception:
            # Library code failed (a broken frame): no value, never a member's code.
            return {**item, "repr": "", "repr_error": "raised"}
        for key in ("len", "shape", "dtype", "columns", "columns_total", "repr_error"):
            if key in described:
                item[key] = described[key]
        item["repr"] = _clip_keep(described.get("repr", ""), self.repr_chars)
        if described.get("masked"):
            item["hidden"] = "keys"
        return item

    def take(self, ns, hidden):
        entries = []
        for name, value in _it.islice(ns.items(), 50_000):
            if type(name) is not str or name.startswith("_") or name in _IPYTHON_NAMES:
                continue
            if type(hidden) is dict and _find(hidden, name, _Stop) is value:
                continue
            if self.show is not None and name != self.show:
                continue
            entries.append((name, value))
        entries.sort(key=lambda e: e[0])
        variables, other, used, truncated = [], [], 0, False
        for name, value in entries:
            if _time.monotonic() > self.deadline:
                truncated = True
                break
            t = type(value)
            kind = _var_kind(t)
            if kind is not None:
                if len(other) >= self.max_vars:
                    truncated = True
                    continue
                entry = {"name": _clip_keep(name, 256), "kind": kind}
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


def _clip_keep(text, limit):
    # Like _clip but keeps surrounding spaces and empty text (a repr is shown as it is).
    if type(text) is not str:
        return ""
    text = text.replace("\x00", "�").encode("utf-8", "replace").decode("utf-8")
    return text if len(text) <= limit else text[: limit - 1] + "…"


def variables(limits, ns, hidden=None, execution_count=None, show=None):
    # JSON text of the snapshot of `ns` (the kernel's user namespace). With `show` (one variable's
    # name, the member's Show), only that variable, its value unmasked.
    limits = limits if type(limits) is dict else {}
    if show is not None and (type(show) is not str or not show.isidentifier() or len(show) > 256):
        # Not a variable name: nothing by that name (never the whole snapshot).
        return _json.dumps({"variables": [], "other": [], "truncated": False, "execution_count": execution_count if type(execution_count) is int else None})
    try:
        snap = _Snapshot(limits, show).take(ns, hidden or {})
    except KeyboardInterrupt:
        return _json.dumps({"error": "interrupted"})
    snap["execution_count"] = execution_count if type(execution_count) is int else None
    return _json.dumps(snap, ensure_ascii=True)
'''

# The kernel answers completion and docs from STATIC_SOURCE (the launcher above runs it).
# An inspect_request whose code starts with this asks for the variables snapshot (KOBE-816); a
# dotted name never does (the server checks names).
VARIABLES_MARKER = "\x01kobe-variables "
LAUNCHER = LAUNCHER.replace("@STATIC_SOURCE@", repr(STATIC_SOURCE)).replace(
    '"@VARIABLES_MARKER@"', repr(VARIABLES_MARKER)
)
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


def short_text(value, limit):
    if type(value) is not str:
        return None
    value = ANSI.sub("", value).replace("\x00", "")
    return value[:limit] if value else None


def completion_from(data, cursor):
    """The wire's `complete` answer from STATIC_SOURCE's: capped, plain text, deduplicated."""
    start = data.get("cursor_start")
    if type(start) is not int or not 0 <= start <= cursor:
        return None
    raw = data.get("matches")
    seen = set()
    matches = []
    for item in raw if isinstance(raw, list) else []:
        text = item.get("text") if isinstance(item, dict) else None
        if type(text) is not str or not text or "\x00" in text or len(text) > COMPLETE_MATCH_MAX_CHARS:
            continue
        if text in seen:
            continue
        seen.add(text)
        match = {"text": text}
        kind = item.get("type")
        if type(kind) is str and 0 < len(kind) <= COMPLETE_TYPE_MAX_CHARS:
            match["type"] = kind
        matches.append(match)
        if len(matches) >= COMPLETE_MATCHES_MAX:
            break
    return {"status": "ok", "op": "complete", "matches": matches, "cursor_start": start, "cursor_end": cursor}


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
        "argv": [sys.executable, launcher, "-f", "{connection_file}"],
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

    def inspect(self, inspect_id, limits, show=None):
        """KOBE-803/816: the variables snapshot, as an inspect_request the kernel answers from
        STATIC_SOURCE (no execute: no hooks, transformers, formatters, history or count). `show`:
        one variable's name, its value unmasked (the member's Show)."""
        safe = {k: int(v) for k, v in limits.items() if k in INSPECT_LIMIT_KEYS and type(v) is int and 0 < v < 10**7}
        asked = {"limits": safe}
        if show is not None:
            # Passed on as given (cut short): the kernel answers an invalid name with nothing.
            asked["show"] = show[:300] if type(show) is str else ""
        code = VARIABLES_MARKER + json.dumps(asked)
        msg_id = self.kc.inspect(code, len(code), detail_level=0)
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
        meta = content.get("metadata")
        text = meta.get("kobe") if isinstance(meta, dict) else None
        try:
            if content.get("status") != "ok" or type(text) is not str:
                raise ValueError("failed")
            snap = json.loads(text)
            if not isinstance(snap, dict):
                raise ValueError("not an object")
        except Exception:  # noqa: BLE001 - reported as unreadable
            emit({"ev": "inspected", "id": inspect_id, "error": "unreadable"})
            return True
        if "error" in snap:
            emit({"ev": "inspected", "id": inspect_id, "error": str(snap["error"])[:200]})
            return True
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

    def static_reply(self, msg_id, command):
        """The resolver's answer in a complete/inspect reply: (data, None) | (None, error) | False."""
        reply = self.shell_reply(msg_id, timeout_of(command))
        if reply is False:
            return False
        if reply is None:
            return None, "timeout"
        content = reply.get("content", {})
        meta = content.get("metadata")
        text = meta.get("kobe") if isinstance(meta, dict) else None
        try:
            if content.get("status") != "ok" or type(text) is not str:
                raise ValueError("failed")
            data = json.loads(text)
            if not isinstance(data, dict):
                raise ValueError("failed")
        except Exception:  # noqa: BLE001 - reported as failed
            return None, "failed"
        if "error" in data:
            return None, str(data["error"])[:50]
        return data, None

    def complete(self, command):
        """KOBE-808: completions at the cursor (complete_request; the kernel runs STATIC_SOURCE)."""
        cid = str(command.get("id", ""))
        code, cursor = command.get("code"), command.get("cursor")
        if type(code) is not str or type(cursor) is not int or not 0 <= cursor <= len(code):
            emit({"ev": "completed", "id": cid, "error": "invalid"})
            return True
        got = self.static_reply(self.kc.complete(code, cursor), command)
        if got is False:
            emit({"ev": "died"})
            return False
        data, error = got
        result = None if data is None else completion_from(data, cursor)
        if result is None:
            emit({"ev": "completed", "id": cid, "error": error or "failed"})
        else:
            emit({"ev": "completed", "id": cid, "result": result})
        return True

    def doc(self, command):
        """KOBE-808: a dotted name's signature and docstring (inspect_request; STATIC_SOURCE)."""
        cid = str(command.get("id", ""))
        name = command.get("name")
        if type(name) is not str or len(name) > 256 or not DOC_NAME.fullmatch(name):
            emit({"ev": "completed", "id": cid, "error": "invalid"})
            return True
        got = self.static_reply(self.kc.inspect(name, len(name), detail_level=0), command)
        if got is False:
            emit({"ev": "died"})
            return False
        data, error = got
        if data is None:
            emit({"ev": "completed", "id": cid, "error": error})
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
                limits = limits if isinstance(limits, dict) else {}
                if not self.inspect(str(command.get("id", "")), limits, command.get("show")):
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
