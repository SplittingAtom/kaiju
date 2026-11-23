"""Runs the kernel bridge's completion helpers (KOBE-808) on plain Python, without IPython.

Usage: python3 completion-harness.py <kobe-kernel-bridge.py> <scenario> [code...]. Prints JSON.
`doc:<name>` evaluates the bridge's own DOC_EXPRESSION, `complete` its COMPLETE_EXPRESSION for each
code given (the cursor at its end), with a stand-in `IPython` module whose shell holds a namespace
of hostile objects (every probe of the security review's three rounds), and report what ran
(`ran`: getters, descriptors, hooks, reprs, hashes, calls). `big` completes keys of a
10-million-entry dict. `from:<json>` feeds `completion_from` an answer.
"""

import functools
import importlib.util
import json
import sys
import threading
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


LOCK = threading.Lock()


class Lazy:
    @functools.cached_property
    def cp(self):
        RAN.append("cached_property")
        LOCK.acquire()
        time.sleep(0.3)
        LOCK.release()
        return self

    @property
    def p(self):
        RAN.append("property")
        return self

    def m(self, a, b=1):
        pass


class Desc:
    def __get__(self, obj, owner=None):
        RAN.append("descriptor")
        return 1


class HasDesc:
    d = Desc()


class Key:
    def __hash__(self):
        RAN.append("hash")
        return 1

    def __eq__(self, other):
        RAN.append("eq")
        return False


class Rep:
    def __eq__(self, other):
        RAN.append("rep_eq")
        return False

    def __hash__(self):
        return 1


class Hooks:
    def __dir__(self):
        RAN.append("dir")
        return ["zz"]

    def _ipython_key_completions_(self):
        RAN.append("key_completions")
        return ["zz"]

    def __getattr__(self, name):
        RAN.append("getattr:" + name)
        raise AttributeError(name)


class SigProp:
    @property
    def __signature__(self):
        RAN.append("signature_property")
        return None

    def __call__(self, x):
        RAN.append("call")


def keywords(a, b=1, *rest, c=2, **more):
    pass


class Sized:
    attr = 1

    def __init__(self, size, colour="red"):
        self.own = {"k": [1]}

    def method(self, q):
        pass


def lazy_module():
    m = types.ModuleType("lazy_mod")
    m.real = 1

    def module_getattr(name):
        RAN.append("module_getattr:" + name)
        raise AttributeError(name)

    m.__getattr__ = module_getattr
    return m


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
        "lzy": Lazy(),
        "hd": HasDesc(),
        "HD": HasDesc,
        "dd": {Key(): 1, 1: Sized(1), "alpha": 1, "beta": 2},
        "dd2": {(Rep(), 1): 1, (1, 1): Sized(1)},
        "hooks": Hooks(),
        "sp": SigProp(),
        "keywords": keywords,
        "sized": Sized(1),
        "Sized": Sized,
        "lazy_mod": lazy_module(),
        "my_value": 41,
    }


def install_shell(ns, hidden=None):
    shell = types.SimpleNamespace(user_ns=ns, user_ns_hidden=hidden or {})
    ipython = types.ModuleType("IPython")
    ipython.get_ipython = lambda: shell
    sys.modules["IPython"] = ipython


def run_doc(bridge, name):
    install_shell(namespace())
    RAN.clear()  # building the namespace hashed its dict keys
    expression = bridge.DOC_EXPRESSION % (repr(bridge.STATIC_SOURCE), repr(name))
    started = time.monotonic()
    text = eval(expression, {"__builtins__": __builtins__}, {})
    out = json.loads(text)
    out["elapsed_ms"] = int((time.monotonic() - started) * 1000)
    out["ran"] = list(RAN)
    return out


def complete(bridge, code):
    expression = bridge.COMPLETE_EXPRESSION % (repr(bridge.STATIC_SOURCE), repr(code), len(code))
    started = time.monotonic()
    out = json.loads(eval(expression, {"__builtins__": __builtins__}, {}))
    out["elapsed_ms"] = int((time.monotonic() - started) * 1000)
    if "matches" in out:
        out["texts"] = [m["text"] for m in out["matches"]]
    return out


def main():
    bridge = load_bridge(sys.argv[1])
    name = sys.argv[2]
    if name.startswith("doc:"):
        print(json.dumps(run_doc(bridge, name[4:])))
        return
    if name.startswith("from:"):
        data, cursor = json.loads(name[5:])
        print(json.dumps(bridge.completion_from(data, cursor)))
        return
    if name == "big":
        install_shell({"big": dict.fromkeys(range(10_000_000)), "small": {"k": 1}})
        first = complete(bridge, "big[")
        then = complete(bridge, "small['")
        print(json.dumps({"big": first, "then": then}))
        return
    ns = namespace()
    install_shell(ns, {"hidden_name": 1})
    ns["hidden_name"] = 1
    RAN.clear()  # building the namespace hashed its dict keys; only completion's calls count
    results = {code: complete(bridge, code) for code in sys.argv[3:]}
    print(
        json.dumps(
            {
                "results": results,
                "ran": RAN,
                "lock_locked": LOCK.locked(),
                "cached": "cp" in ns["lzy"].__dict__,
            }
        )
    )


if __name__ == "__main__":
    main()
