"""Runs the kernel bridge's completion helpers (KOBE-808) on plain Python, without IPython.

Usage: python3 completion-harness.py <kobe-kernel-bridge.py> <scenario>. Prints JSON.
`doc-*` scenarios evaluate the bridge's own DOC_EXPRESSION with a stand-in `IPython` module whose
shell holds a namespace of hostile objects, and report what ran (`ran`: property getters,
`__getattr__`, reprs, calls); `complete-*` scenarios feed `completion_result` a `complete_reply`.
"""

import importlib.util
import json
import sys
import time
import types

RAN = []


def load_bridge(path):
    spec = importlib.util.spec_from_file_location("kobe_kernel_bridge", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Hostile:
    """A Hostile object."""

    def __init__(self):
        self.value = 1

    @property
    def prop(self):
        """The prop."""
        RAN.append("property")
        return 1

    def method(self, x, y=2):
        """Doc of method."""
        RAN.append("method")

    @staticmethod
    def static(a):
        """Doc of static."""

    def __getattr__(self, name):
        RAN.append("getattr")
        raise AttributeError(name)

    def __repr__(self):
        RAN.append("repr")
        return "Hostile()"

    def __call__(self, *a):
        RAN.append("call")


class Plain:
    pass


class ClassProperty:
    """A lazy proxy's trick: __class__ is a property (Django's SimpleLazyObject)."""

    @property
    def __class__(self):
        RAN.append("__class__")
        return Plain

    def method(self, a):
        """Doc of a proxy method."""


class GetAttribute:
    """Every attribute read runs code."""

    def __getattribute__(self, name):
        RAN.append("getattribute:" + name)
        return object.__getattribute__(self, name)

    def method(self, a):
        """Doc of a watched method."""


class Meta(type):
    def __getattr__(cls, name):
        RAN.append("meta_getattr:" + name)
        raise AttributeError(name)


class MetaGA(type):
    def __getattribute__(cls, name):
        RAN.append("meta_getattribute:" + name)
        return type.__getattribute__(cls, name)


class WithMetaGA(metaclass=MetaGA):
    """Hooked class."""

    def method(self):
        """Never looked into."""


class WithMeta(metaclass=Meta):
    """A class with a hooked metaclass."""

    def __init__(self, a, b=2):
        pass


class LazyProxy:
    """A wrapt/mock-style proxy: everything forwards through hooks."""

    def __getattr__(self, name):
        RAN.append("proxy_getattr:" + name)
        return self

    def __call__(self, *a, **k):
        RAN.append("proxy_call")
        return self

    def __repr__(self):
        RAN.append("proxy_repr")
        return "LazyProxy()"


class ReprBomb:
    def __repr__(self):
        RAN.append("default_repr")
        return "bomb"


class Descriptor:
    def __get__(self, obj, owner=None):
        RAN.append("descriptor_get")
        return self


def with_defaults(a, b=ReprBomb(), *rest, c=1, d=ReprBomb(), **more):
    """Defaults whose repr runs code."""


def wrapped(a):
    """Wrapped."""


wrapped.__wrapped__ = LazyProxy()
wrapped.__signature__ = LazyProxy()


class WithDescriptors:
    __signature__ = Descriptor()
    __wrapped__ = Descriptor()

    def __init__(self, x):
        pass


def namespace():
    def add(a, b=1):
        """Adds."""
        return a + b

    return {
        "h": Hostile(),
        "add": add,
        "Hostile": Hostile,
        "p": Plain(),
        "n": 3,
        "json": json,
        "lz": ClassProperty(),
        "ga": GetAttribute(),
        "WM": WithMeta,
        "proxy": LazyProxy(),
        "with_defaults": with_defaults,
        "wrapped": wrapped,
        "WD": WithDescriptors,
        "WMG": WithMetaGA,
        "wmg": WithMetaGA(),
    }


def run_doc(bridge, name):
    shell = types.SimpleNamespace(user_ns=namespace())
    ipython = types.ModuleType("IPython")
    ipython.get_ipython = lambda: shell
    sys.modules["IPython"] = ipython
    expression = bridge.DOC_EXPRESSION % (repr(bridge.DOC_SOURCE), repr(name))
    started = time.monotonic()
    text = eval(expression, {"__builtins__": __builtins__}, {})
    out = json.loads(text)
    out["elapsed_ms"] = int((time.monotonic() - started) * 1000)
    out["ran"] = list(RAN)
    return out


REPLIES = {
    # IPython's attribute matches carry the dot: from after it instead.
    "complete-dot": (
        "df.al",
        5,
        {
            "status": "ok",
            "matches": [".align", ".all", ".alpha", ".alpha"],
            "cursor_start": 2,
            "cursor_end": 5,
            "metadata": {
                "_jupyter_types_experimental": [
                    {"text": ".align", "type": "attribute"},
                    {"text": ".alpha", "type": "<unknown>"},
                ]
            },
        },
    ),
    "complete-many": (
        "x",
        1,
        {"status": "ok", "matches": ["x%d" % i for i in range(500)] + ["y" * 300, "bad\x00"], "cursor_start": 0, "cursor_end": 1},
    ),
    "complete-error": ("x", 1, {"status": "error", "ename": "E"}),
    "complete-bad-cursor": ("ab", 2, {"status": "ok", "matches": ["abc"], "cursor_start": 9, "cursor_end": 1}),
}


def main():
    bridge = load_bridge(sys.argv[1])
    name = sys.argv[2]
    if name.startswith("doc:"):
        print(json.dumps(run_doc(bridge, name[4:])))
        return
    code, cursor, reply = REPLIES[name]
    print(json.dumps(bridge.completion_result(reply, code, cursor)))


if __name__ == "__main__":
    main()
