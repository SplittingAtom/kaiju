"""Runs the kernel launcher's completer guard (KOBE-808) on plain Python, without IPython.

Usage: python3 guard-harness.py <kobe-kernel-bridge.py>. Prints JSON.
Stand-in `ipykernel` / `IPython` modules hold the attributes the guard replaces; the guard's
evaluator, dir, key lister and `do_complete` are then driven with hostile member objects (a
lock-holding `cached_property`, descriptors, a metaclass `__getattribute__`, hashing keys, ...).
Each hook appends to RAN; the test expects it to stay empty.
"""

import functools
import importlib.util
import json
import signal
import sys
import threading
import time
import types

RAN = []
REAL_COMPLETIONS = []


def load_bridge(path):
    spec = importlib.util.spec_from_file_location("kobe_kernel_bridge", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def stand_ins():
    def module(name, **attrs):
        m = types.ModuleType(name)
        m.__dict__.update(attrs)
        sys.modules[name] = m
        return m

    class IPythonKernel:
        def do_complete(self, code, cursor_pos):
            REAL_COMPLETIONS.append(code)
            return {"status": "ok", "matches": ["real"], "cursor_start": 0, "cursor_end": 0}

    class GuardRejection(Exception):
        pass

    class IPCompleter:
        @staticmethod
        def _get_keys(obj):
            raise AssertionError("not guarded")

    module("ipykernel")
    module("ipykernel.ipkernel", IPythonKernel=IPythonKernel)
    module("IPython")
    module("IPython.core")
    module("IPython.core.completer", IPCompleter=IPCompleter, dir2=dir)
    guarded = module("IPython.core.guarded_eval", GuardRejection=GuardRejection, guarded_eval=eval)
    module("IPython.utils")
    generics = module(
        "IPython.utils.generics", complete_object=functools.singledispatch(lambda o, p: p)
    )
    return IPythonKernel, guarded, sys.modules["IPython.core.completer"], generics


LOCK = threading.Lock()


class Slow:
    @functools.cached_property
    def locked(self):
        RAN.append("cached_property")
        LOCK.acquire()
        time.sleep(0.3)
        LOCK.release()
        return self

    @functools.cached_property
    def lazy(self):
        RAN.append("lazy")
        return 1

    @property
    def prop(self):
        RAN.append("property")
        return self

    def method(self):
        pass


class Desc:
    def __get__(self, obj, owner=None):
        RAN.append("descriptor")
        return self


class DataDesc(Desc):
    def __set__(self, obj, value):
        pass


class HasDesc:
    nd = Desc()
    dd = DataDesc()


class MetaGA(type):
    def __getattribute__(cls, name):
        RAN.append("meta_getattribute:" + name)
        return type.__getattribute__(cls, name)


class WithMeta(metaclass=MetaGA):
    x = 1


class GA:
    def __getattribute__(self, name):
        RAN.append("getattribute:" + name)
        return object.__getattribute__(self, name)


class Key:
    def __hash__(self):
        RAN.append("hash")
        return 1

    def __eq__(self, other):
        RAN.append("eq")
        return False


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


class Plain:
    attr = 1

    def __init__(self):
        self.own = {"k": [Plain]}


def main():
    bridge = load_bridge(sys.argv[1])
    kernel, guarded, completer, generics = stand_ins()
    exec(bridge.COMPLETER_GUARD, {"__name__": "kobe_guard"})
    slow = Slow()
    ns = {
        "slow": slow,
        "hd": HasDesc(),
        "HD": HasDesc,
        "WM": WithMeta,
        "wm": WithMeta(),
        "ga": GA(),
        "d": {Key(): 1, 1: Plain(), "a": {"b": 2}},
        "hooks": Hooks(),
        "plain": Plain(),
        "Plain": Plain,
        "json": json,
    }
    mixed_keys = {"a": 1, Key(): 2}
    RAN.clear()  # building the dicts above hashed the keys; only the guard's own calls count
    ctx = types.SimpleNamespace(locals=ns, globals={}, in_subscript=False)
    evaluated = {}
    for expr in (
        "slow.locked",
        "slow.lazy",
        "slow.prop",
        "slow.method",
        "hd.nd",
        "hd.dd",
        "HD.nd",
        "WM.x",
        "wm.x",
        "ga.x",
        "d[1]",
        "d['a']['b']",
        "d[(1, 2)]",
        "hooks.zz",
        "plain.own['k'][0]",
        "plain.attr",
        "Plain.attr",
        "json.dumps",
        "len",
        "slow.method()",
        "plain + 1",
    ):
        try:
            value = guarded.guarded_eval(expr, ctx)
            evaluated[expr] = "ok:" + type(value).__name__
        except Exception as error:
            evaluated[expr] = "rejected:" + type(error).__name__
    subscript = guarded.guarded_eval("'a', 1", types.SimpleNamespace(locals=ns, globals={}, in_subscript=True))
    dirs = {
        "hooks": "zz" in completer.dir2(ns["hooks"]),
        "plain_own": "own" in completer.dir2(ns["plain"]),
        "wm": "x" in completer.dir2(ns["wm"]),
    }
    keys = {
        "hooks": completer.IPCompleter._get_keys(ns["hooks"]),
        "dict": completer.IPCompleter._get_keys(mixed_keys),
    }

    @generics.complete_object.register(Plain)
    def _member_completer(obj, prev):
        RAN.append("member_completer")
        return prev + ["mine"]

    generic = generics.complete_object(ns["plain"], ["x"])
    k = kernel()
    plain_answer = kernel.do_complete(k, "pla", 3)
    signal.signal(signal.SIGALRM, lambda *a: RAN.append("member_alarm"))
    signal.setitimer(signal.ITIMER_REAL, 30)
    with_timer = kernel.do_complete(k, "pla", 3)
    signal.setitimer(signal.ITIMER_REAL, 0)
    print(
        json.dumps(
            {
                "evaluated": evaluated,
                "subscript": list(subscript),
                "dirs": dirs,
                "keys": keys,
                "generic": generic,
                "plain_answer": plain_answer["matches"],
                "with_timer": with_timer["matches"],
                "real_completions": REAL_COMPLETIONS,
                "lock_locked": LOCK.locked(),
                "cached_stored": "locked" in slow.__dict__ or "lazy" in slow.__dict__,
                "ran": RAN,
            }
        )
    )


if __name__ == "__main__":
    main()
