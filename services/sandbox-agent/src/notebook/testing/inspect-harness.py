"""Runs the kernel bridge's variables snapshot (KOBE-803/816) on plain Python, without IPython.

Usage: python3 inspect-harness.py <kaiju-kernel-bridge.py> <scenario>. Prints the snapshot JSON
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
    spec = importlib.util.spec_from_file_location("kaiju_kernel_bridge", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fake_numpy():
    """A stand-in numpy: the fields the snapshot reads, in the places numpy keeps them."""
    np = types.ModuleType("numpy")

    class dtype:
        def __init__(self, name):
            self.name = name
            self.kind = "f" if name.startswith("float") else "O"

        def __str__(self):
            return self.name

    class ndarray:
        def __init__(self, shape, kind, fill=0.0):
            self._shape = tuple(shape)
            self._dtype = dtype(kind)
            self._fill = fill

        shape = property(lambda self: self._shape)
        dtype = property(lambda self: self._dtype)

        def __getitem__(self, key):
            if isinstance(key, slice):
                n = len(range(*key.indices(self._shape[0])))
                return ndarray((n,) + self._shape[1:], self._dtype.name, self._fill)
            return ndarray(self._shape[1:], self._dtype.name, self._fill)

        def tolist(self):
            def build(shape):
                return self._fill if not shape else [build(shape[1:]) for _ in range(shape[0])]

            return build(self._shape)

    def zeros(shape):
        return ndarray(shape, "float64")

    np.ndarray, np.zeros, np.dtype = ndarray, zeros, dtype
    ndarray.__module__ = "numpy"
    return np


def fake_pandas(np):
    """A stand-in pandas with a block manager: blocks of arrays and index axes."""
    pd = types.ModuleType("pandas")

    class Index:
        def __init__(self, labels):
            self._data = np.ndarray((len(labels),), "object")
            self.labels = list(labels)

        def __len__(self):
            return len(self.labels)

        def __iter__(self):
            return iter(self.labels)

    class RangeIndex(Index):
        pass

    class Block:
        def __init__(self, values):
            self.values = values

    class Manager:
        def __init__(self, blocks, axes):
            self.blocks = blocks
            self.axes = axes

    class Dtypes:
        def __init__(self, pairs):
            self.pairs = pairs

        def items(self):
            return iter(self.pairs)

    class DataFrame:
        def __init__(self, data, values=None):
            rows = len(next(iter(data.values())))
            self.columns = Index(list(data))
            self.index = RangeIndex(range(rows))
            self.dtypes = Dtypes(
                [(c, "int64" if all(isinstance(v, int) for v in vs) else "object") for c, vs in data.items()]
            )
            block_values = values if values is not None else np.ndarray((len(data), rows), "object")
            self._mgr = Manager([Block(block_values)], [self.columns, self.index])

        def __repr__(self):
            raise AssertionError("a DataFrame's data is never rendered")

    class Series:
        def __init__(self, values, array=None):
            self.values = list(values)
            self.dtype = "int64"
            index = RangeIndex(range(len(self.values)))
            data = array if array is not None else np.ndarray((len(self.values),), "float64")
            self._mgr = Manager([Block(data)], [index])

        def __len__(self):
            return len(self.values)

        def __repr__(self):
            raise AssertionError("a Series' data is never rendered")

    DataFrame.__module__ = "pandas.core.frame"
    Series.__module__ = "pandas.core.series"
    pd.DataFrame, pd.Series, pd.Index, pd.RangeIndex = DataFrame, Series, Index, RangeIndex
    return pd


def libraries():
    try:
        import numpy as np  # noqa: F401
    except ImportError:
        sys.modules["numpy"] = fake_numpy()
    try:
        import pandas as pd  # noqa: F401
    except ImportError:
        sys.modules["pandas"] = fake_pandas(sys.modules["numpy"])
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


class MemberArray:
    """A member-written ExtensionArray: pandas would ask its dtype and length."""

    @property
    def dtype(self):
        RAN.append("ea_dtype")
        return "member"

    def __len__(self):
        RAN.append("ea_len")
        return 1


class SpoofDtype:
    """A member class claiming to be pandas'."""

    __module__ = "pandas.core.dtypes"

    def __str__(self):
        RAN.append("spoof_str")
        return "x"


class RecStr(str):
    def __repr__(self):
        RAN.append("strsub_repr")
        return "'x'"

    def replace(self, *a):
        RAN.append("strsub_replace")
        return str.replace(self, *a)

    def __str__(self):
        RAN.append("strsub_str")
        return "x"


def embedded_values():
    import datetime
    import pathlib

    named = datetime.timezone(datetime.timedelta(hours=1), RecStr("CET"))
    path = pathlib.PurePosixPath("/x")
    str(path)  # fills the cached slot
    for klass in type(path).__mro__:
        if "_str" in klass.__dict__:
            klass.__dict__["_str"].__set__(path, RecStr("/x"))
            break
    values = {
        "tz_named": named,
        "when_named": datetime.datetime(2026, 1, 1, tzinfo=named),
        "path_str": path,
    }
    try:
        import zoneinfo

        with open("/usr/share/zoneinfo/UTC", "rb") as f:
            zone = zoneinfo.ZoneInfo.from_file(f, key=Recorder())
        values["when_zone_odd"] = datetime.datetime(2026, 1, 1, tzinfo=zone)
    except Exception:
        pass
    return values


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
    if name == "secrets":
        return {
            "API_KEY": "sk-live-123",
            "my_password": "hunter2",
            "env": {"PATH": "/usr/bin", "AWS_SECRET_ACCESS_KEY": "abc", "nested": {"token": "t"}},
            "headers": {"Authorization": "Bearer abc123", "x-api-key": "k-xyz", "X-Api-Key": "k2", "Accept": "json"},
            "raw": {b"password": b"bytes-secret", b"user": b"me"},
            "pairs": [("password", "plain-in-tuple"), ("user", "me")],
            "proxy": {"HTTPS_PROXY": "http://thread:egress-token@proxy:3128"},
            "url": "postgres://app:pw-in-url@db:5432/x",
            "plain": {"a": 1},
            "count": 3,
        }, {}
    if name == "embedded":
        return embedded_values(), {}
    if name == "member_arrays":
        return {
            "ser_ea": pd.Series([1], array=MemberArray()),
            "df_ea": pd.DataFrame({"a": [1]}, values=MemberArray()),
            "spoof_in_list": [SpoofDtype()],
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


def secret_names(bridge, path):
    """The bridge's credential-name rule over the shared table: which names it masks."""
    g = {"__name__": "kaiju_static"}
    exec(bridge.STATIC_SOURCE, g)
    with open(path, encoding="utf-8") as f:
        cases = json.load(f)
    names = cases["mask"] + cases["show"]
    print(json.dumps({name: g["_secret"](name) for name in names}))


def main():
    bridge = load_bridge(sys.argv[1])
    if sys.argv[2] == "secret_names":
        return secret_names(bridge, sys.argv[3])
    ns, hidden = scenario(sys.argv[2])
    show = sys.argv[3] if len(sys.argv) > 3 else None
    limits = {"max_vars": 200, "max_bytes": 65536, "repr_chars": 200, "per_var_ms": 200, "budget_ms": 2000}
    if sys.argv[2] == "budget":
        limits["budget_ms"] = 0
    g = {"__name__": "kaiju_static"}
    exec(bridge.STATIC_SOURCE, g)
    RAN.clear()  # building the namespace (dict keys) may have hashed; only the snapshot counts
    safe = {k: v for k, v in limits.items() if k in bridge.INSPECT_LIMIT_KEYS}
    started = time.monotonic()
    text = g["variables"](safe, ns, hidden, 7, show)
    elapsed = time.monotonic() - started
    snap = json.loads(text)
    snap["elapsed_ms"] = int(elapsed * 1000)
    snap["user_names_after"] = sorted(k for k in ns if type(k) is str and not k.startswith("__"))
    snap["ran"] = RAN
    snap["lock_locked"] = LOCK.locked()
    print(json.dumps(snap))


if __name__ == "__main__":
    main()
