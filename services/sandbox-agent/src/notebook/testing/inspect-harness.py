"""Runs the kernel bridge's variables snapshot (KOBE-803/816) on plain Python, without IPython.

Usage: python3 inspect-harness.py <kobe-kernel-bridge.py> <scenario>. Prints the snapshot JSON
with `ran` (every hook of the member's objects that ran: zero allowed) and `lock_locked`.
The snapshot is STATIC_SOURCE's `variables` (what the kernel's inspect handler calls) on the
scenario's namespace. numpy and pandas are used when importable, and otherwise simulated by small
stand-in modules with the attributes the snapshot reads.
"""

import importlib.util
import json
import sys
import threading
import time
import types

RAN = []
LOCK = threading.Lock()


def load_bridge(path):
    spec = importlib.util.spec_from_file_location("kobe_kernel_bridge", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fake_numpy():
    np = types.ModuleType("numpy")

    class dtype:
        def __init__(self, name):
            self.name = name
            self.kind = "f" if name.startswith("float") else "O"

        __module__ = "numpy"

        def __str__(self):
            return self.name

    class ndarray:
        def __init__(self, shape, kind):
            self.shape = tuple(shape)
            self.dtype = dtype(kind)

    def array2string(a, threshold, edgeitems, max_line_width):
        return "[[0. 0. ... 0.]\n ...]"

    def zeros(shape):
        return ndarray(shape, "float64")

    np.ndarray, np.array2string, np.zeros = ndarray, array2string, zeros
    ndarray.__module__ = "numpy"
    return np


def fake_pandas():
    pd = types.ModuleType("pandas")

    class Dtypes:
        def __init__(self, pairs):
            self.pairs = pairs

        def items(self):
            return iter(self.pairs)

    class DataFrame:
        def __init__(self, data):
            self.columns = list(data)
            self.index = list(range(len(next(iter(data.values())))))
            self.dtypes = Dtypes(
                [(c, "int64" if all(isinstance(v, int) for v in vs) else "object") for c, vs in data.items()]
            )

        def __repr__(self):
            raise AssertionError("a DataFrame's data is never rendered")

    class Series:
        def __init__(self, values):
            self.values = list(values)
            self.dtype = "int64"

        def __len__(self):
            return len(self.values)

        def __repr__(self):
            raise AssertionError("a Series' data is never rendered")

    DataFrame.__module__ = "pandas.core.frame"
    Series.__module__ = "pandas.core.series"
    pd.DataFrame, pd.Series = DataFrame, Series
    return pd


def libraries():
    try:
        import numpy as np  # noqa: F401
    except ImportError:
        sys.modules["numpy"] = fake_numpy()
    try:
        import pandas as pd  # noqa: F401
    except ImportError:
        sys.modules["pandas"] = fake_pandas()
    return sys.modules["numpy"], sys.modules["pandas"]


class Raises:
    def __repr__(self):
        raise RuntimeError("boom")


class Hangs:
    def __repr__(self):
        while True:
            pass


class Sleeps:
    def __repr__(self):
        time.sleep(30)
        return "never"


class Exits:
    def __repr__(self):
        raise SystemExit(3)


class BigList(list):
    def __repr__(self):
        raise AssertionError("a list subclass never gets its own full repr")


class Text(str):
    def __repr__(self):
        raise AssertionError("a str subclass never gets its own full repr")


class Huge:
    def __repr__(self):
        return "h" * 5_000_000


class Recorder:
    """Every hook a value-reader might call, recording itself."""

    def __repr__(self):
        RAN.append("repr")
        return "R"

    def __str__(self):
        RAN.append("str")
        return "S"

    def __len__(self):
        RAN.append("len")
        return 1

    def __iter__(self):
        RAN.append("iter")
        return iter(())

    def __format__(self, spec):
        RAN.append("format")
        return "F"


class ClassProperty:
    @property
    def __class__(self):
        RAN.append("__class__")
        return int


class GetAttribute:
    def __getattribute__(self, name):
        RAN.append("getattribute:" + name)
        return object.__getattribute__(self, name)


class Meta(type):
    def __getattribute__(cls, name):
        RAN.append("meta_getattribute:" + name)
        return type.__getattribute__(cls, name)

    def __repr__(cls):
        RAN.append("meta_repr")
        return "M"

    def __subclasscheck__(cls, other):
        RAN.append("subclasscheck")
        return False

    def __instancecheck__(cls, other):
        RAN.append("instancecheck")
        return False


class WithMeta(metaclass=Meta):
    pass


class LockRepr:
    def __repr__(self):
        RAN.append("lock_repr")
        LOCK.acquire()
        time.sleep(0.5)
        LOCK.release()
        return "L"


class HookList(list):
    def __iter__(self):
        RAN.append("list_iter")
        return iter(())

    def __len__(self):
        RAN.append("list_len")
        return 0

    def __repr__(self):
        RAN.append("list_repr")
        return "HL"


class HookDict(dict):
    def items(self):
        RAN.append("dict_items")
        return []

    def __iter__(self):
        RAN.append("dict_iter")
        return iter(())


class Key:
    def __hash__(self):
        RAN.append("key_hash")
        return 1

    def __eq__(self, other):
        RAN.append("key_eq")
        return False


def stdlib_values():
    import datetime
    import decimal
    import fractions
    import pathlib
    import uuid

    class RecTz(datetime.tzinfo):
        def utcoffset(self, dt):
            RAN.append("utcoffset")
            return datetime.timedelta(0)

        def tzname(self, dt):
            RAN.append("tzname")
            return "X"

        def dst(self, dt):
            RAN.append("dst")
            return None

        def __repr__(self):
            RAN.append("tz_repr")
            return "RecTz()"

    def recording(base):
        class Sub(base):
            def __repr__(self):
                RAN.append("sub_repr:" + base.__name__)
                return "sub"

            def __str__(self):
                RAN.append("sub_str:" + base.__name__)
                return "sub"

        Sub.__name__ = "Sub" + base.__name__
        Sub.__qualname__ = Sub.__name__
        return Sub

    class MyInt(int):
        def __repr__(self):
            RAN.append("myint_repr")
            return "3"

        def __str__(self):
            RAN.append("myint_str")
            return "3"

    odd_fraction = fractions.Fraction(3, 4)
    fractions.Fraction.__dict__["_numerator"].__set__(odd_fraction, MyInt(3))
    base_path = pathlib.PurePosixPath
    return {
        "when": datetime.datetime(2026, 11, 22, 10, 30),
        "when_utc": datetime.datetime(2026, 11, 22, 10, 30, tzinfo=datetime.timezone.utc),
        "when_member_tz": datetime.datetime(2026, 11, 22, 10, 30, tzinfo=RecTz()),
        "time_member_tz": datetime.time(10, 30, tzinfo=RecTz()),
        "day": datetime.date(2026, 11, 22),
        "span": datetime.timedelta(days=2, seconds=5),
        "tz": datetime.timezone.utc,
        "money": decimal.Decimal("12.50"),
        "ratio": fractions.Fraction(3, 4),
        "odd_ratio": odd_fraction,
        "ident": uuid.UUID("12345678-1234-5678-1234-567812345678"),
        "where": pathlib.PurePosixPath("/workspace/data.csv"),
        "real_path": pathlib.PosixPath("/workspace"),
        "dots": Ellipsis,
        "kinds": [int, len, sys, Ellipsis],
        "sub_datetime": recording(datetime.datetime)(2026, 1, 1),
        "sub_date": recording(datetime.date)(2026, 1, 1),
        "sub_decimal": recording(decimal.Decimal)("1"),
        "sub_fraction": recording(fractions.Fraction)(1, 2),
        "sub_uuid": recording(uuid.UUID)("12345678-1234-5678-1234-567812345678"),
        "sub_path": recording(base_path)("/x"),
        "in_list": [datetime.datetime(2026, 1, 1, tzinfo=RecTz()), decimal.Decimal("2")],
    }


def scenario(name):
    np, pd = libraries()
    if name == "basic":
        import math

        def f():
            return 1

        return {
            "n": 42,
            "s": "hello",
            "xs": list(range(1000)),
            "d": {"a": 1},
            "_private": 1,
            "In": [],
            "Out": {},
            "get_ipython": print,
            "exit": None,
            "math": math,
            "f": f,
            "Raises": Raises,
            "length": len,
            "hidden_one": "from IPython",
        }, {"hidden_one": "from IPython"}
    if name == "hostile":
        return {"bad": Raises(), "slow": Hangs(), "sleepy": Sleeps(), "quits": Exits(), "huge": Huge(), "ok": 1}, {}
    if name == "data":
        df = pd.DataFrame({"a": [1, 2, 3], "b": ["x", "y", "z"]})
        return {"arr": np.zeros((3, 4)), "df": df, "ser": pd.Series([1, 2]), "wide": pd.DataFrame({f"c{i}": [i] for i in range(80)})}, {}
    if name == "recording":
        return {
            "rec": Recorder(),
            "cp": ClassProperty(),
            "ga": GetAttribute(),
            "wm": WithMeta(),
            "lock": LockRepr(),
            "hl": HookList([1, 2, 3]),
            "hd": HookDict(a=Recorder()),
            "nested": [Recorder(), {"k": LockRepr()}, (ClassProperty(), 1)],
            "keyed": {Key(): 1, "plain": Recorder()},
            "frame_of_objects": pd.DataFrame({"a": [1]}),
            "ok": 1,
        }, {}
    if name == "stdlib":
        return stdlib_values(), {}
    if name == "huge":
        return {
            "big_list": list(range(5_000_000)),
            "big_dict": dict.fromkeys(range(2_000_000)),
            "big_str": "x" * 10_000_000,
            "big_int": 10**100_000,
            "deep": [[[[[[1]]]]]],
            "big_set": set(range(1_000_000)),
        }, {}
    if name == "subclasses":
        return {"big": BigList(range(1_000_000)), "text": Text("t" * 10_000)}, {}
    if name == "many":
        return {f"v{i:04d}": "x" * 150 for i in range(1000)}, {}
    if name == "budget":
        return {f"s{i}": list(range(10)) for i in range(50)}, {}
    raise SystemExit("unknown scenario " + name)


def main():
    bridge = load_bridge(sys.argv[1])
    ns, hidden = scenario(sys.argv[2])
    limits = {"max_vars": 200, "max_bytes": 65536, "repr_chars": 200, "per_var_ms": 200, "budget_ms": 2000}
    if sys.argv[2] == "budget":
        limits["budget_ms"] = 0
    g = {"__name__": "kobe_static"}
    exec(bridge.STATIC_SOURCE, g)
    RAN.clear()  # building the namespace (dict keys) may have hashed; only the snapshot counts
    safe = {k: v for k, v in limits.items() if k in bridge.INSPECT_LIMIT_KEYS}
    started = time.monotonic()
    text = g["variables"](safe, ns, hidden, 7)
    elapsed = time.monotonic() - started
    snap = json.loads(text)
    snap["elapsed_ms"] = int(elapsed * 1000)
    snap["user_names_after"] = sorted(k for k in ns if type(k) is str and not k.startswith("__"))
    snap["ran"] = RAN
    snap["lock_locked"] = LOCK.locked()
    print(json.dumps(snap))


if __name__ == "__main__":
    main()
