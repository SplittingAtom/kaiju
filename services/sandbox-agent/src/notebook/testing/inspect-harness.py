"""Runs the kernel bridge's variables snapshot (KOBE-803) on plain Python, without IPython.

Usage: python3 inspect-harness.py <kobe-kernel-bridge.py> <scenario>. Prints the snapshot JSON.
The snapshot goes through the bridge's own user expression, with a stand-in `IPython` module
whose shell holds the scenario's namespace. numpy and pandas are used when importable, and
otherwise simulated by small stand-in modules with the attributes the snapshot reads.
"""

import importlib.util
import json
import sys
import time
import types


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
    if name == "subclasses":
        return {"big": BigList(range(1_000_000)), "text": Text("t" * 10_000)}, {}
    if name == "many":
        return {f"v{i:04d}": "x" * 150 for i in range(1000)}, {}
    if name == "budget":
        return {f"s{i}": Sleeps() for i in range(5)}, {}
    raise SystemExit("unknown scenario " + name)


def main():
    bridge = load_bridge(sys.argv[1])
    ns, hidden = scenario(sys.argv[2])
    limits = {"max_vars": 200, "max_bytes": 65536, "repr_chars": 200, "per_var_ms": 200, "budget_ms": 2000}
    if sys.argv[2] == "budget":
        limits["budget_ms"] = 300
    shell = types.SimpleNamespace(user_ns=ns, user_ns_hidden=hidden)
    ipython = types.ModuleType("IPython")
    ipython.get_ipython = lambda: shell
    sys.modules["IPython"] = ipython
    safe = {k: v for k, v in limits.items() if k in bridge.INSPECT_LIMIT_KEYS}
    expression = bridge.INSPECT_EXPRESSION % (repr(bridge.INSPECT_SOURCE), repr(safe))
    started = time.monotonic()
    text = eval(expression, {"__builtins__": __builtins__}, {})
    elapsed = time.monotonic() - started
    snap = json.loads(text)
    snap["elapsed_ms"] = int(elapsed * 1000)
    snap["user_names_after"] = sorted(k for k in ns if not k.startswith("__"))
    print(json.dumps(snap))


if __name__ == "__main__":
    main()
