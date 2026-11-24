"""KOBE-808/816: completion, docs and the variables snapshot through the real bridge transport
fire none of the kernel's execution machinery. Usage: python3 kernel-transport-probe.py <python> <kobe-kernel-bridge.py>.

Run by images/sandbox/test-image.sh (in the image) and by sandbox-agent's
transport.e2e.test.ts (with KAIJU_TEST_KERNEL_PYTHON pointing at a Python with ipykernel).
The member's namespace registers a hook of every kind the execution path runs: pre/post_execute
and pre/post_run_cell events, an input transformer, a text/plain formatter for `str`, a warnings
hook, and autoreload (whose own event callbacks are wrapped to record calls). Cells between the
requests measure: the hooks a cell itself fires are the same before and after, so any difference
is the requests'. Also the execution count, history and Out must not move. Prints one line:
`ok <hook calls by the requests> <count moved> <history moved> <Out moved> cell_hooks_fire
<complete> <doc> vars=<my_value>,<thing: not_read>,<arr preview>,<API_KEY: name>,secret_absent,
shown=<API_KEY's value after Show>` (cell_hooks_fire: the hooks do fire for a cell, so the zero means something).
"""

import json
import os
import subprocess
import sys

p = subprocess.Popen(
    sys.argv[1:],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True,
    cwd=os.environ.get("KAIJU_PROBE_CWD", "/workspace"),
)


def read():
    return json.loads(p.stdout.readline() or '{"ev": "eof"}')


assert read()["ev"] == "ready"


def send(m):
    p.stdin.write(json.dumps(m) + "\n")
    p.stdin.flush()


def run(code, i):
    send({"op": "execute", "id": i, "code": code})
    outs = []
    while True:
        m = read()
        if m["ev"] == "output":
            outs.append(m["output"])
        elif m["ev"] in ("done", "died", "fatal", "eof"):
            return m, outs


SETUP = """
import warnings
hits = []
ip = get_ipython()
ip.run_line_magic("load_ext", "autoreload")
ip.run_line_magic("autoreload", "2")
def _wrap(event, cb):
    def wrapped(*a, **k):
        hits.append(event)
        return cb(*a, **k)
    return wrapped
for _event, _cbs in ip.events.callbacks.items():
    _cbs[:] = [_wrap(_event, _cb) for _cb in _cbs]
ip.events.register("pre_execute", lambda: hits.append("pre_execute"))
ip.events.register("post_execute", lambda: hits.append("post_execute"))
ip.events.register("pre_run_cell", lambda info: hits.append("pre_run_cell"))
ip.events.register("post_run_cell", lambda result: hits.append("post_run_cell"))
def _transform(lines):
    hits.append("input_transformer")
    return lines
ip.input_transformers_cleanup.append(_transform)
ip.display_formatter.formatters["text/plain"].for_type(
    str, lambda o, pp, cycle: (hits.append("str_formatter"), pp.text(repr(o)))[1]
)
_show = warnings.showwarning
def _warned(*a, **k):
    hits.append("warning")
    return _show(*a, **k)
warnings.showwarning = _warned
class Thing:
    def method(self, alpha, beta=1):
        '''Doc of method.'''
    def __repr__(self):
        hits.append("repr")
        return "Thing()"
thing = Thing()
my_value = 3
API_KEY = "sk-live-123"
import numpy as np
np.set_printoptions(formatter={"float": lambda x: (hits.append("np_formatter"), "F")[1]})
arr = np.arange(3.0)
"""

MEASURE = (
    "measured = (len(hits), ip.execution_count, len(ip.history_manager.input_hist_raw), len(Out))"
)

setup, _ = run(SETUP, "setup")
assert setup["status"] == "ok", setup
run(MEASURE + "\nfirst = measured", "m1")
completed = []
for code in ("my_v", "thing.", "thing.method(", "thing.method(al"):
    send({"op": "complete", "id": code, "code": code, "cursor": len(code), "timeout_ms": 2000})
    m = read()
    completed.append(",".join(x["text"] for x in m["result"]["matches"]) if "result" in m else "!")
send({"op": "doc", "id": "d", "name": "thing.method", "timeout_ms": 2000})
doc = read().get("result", {})
send({"op": "doc", "id": "e", "name": "my_value", "timeout_ms": 2000})
read()
send({"op": "inspect", "id": "v", "limits": {"budget_ms": 2000}})
raw = p.stdout.readline()
snap = json.loads(raw).get("snapshot", {})
values = {v["name"]: v.get("repr") or v.get("repr_error") or v.get("hidden") for v in snap.get("variables", [])}
# KOBE-816: a credential-like name's value never leaves the kernel in a snapshot; Show asks for it.
absent = "secret_absent" if "sk-live" not in raw else "secret_sent"
send({"op": "inspect", "id": "s", "limits": {}, "show": "API_KEY"})
shown = read().get("snapshot", {}).get("variables", [{}])[0].get("repr")
variables = "vars=%s,%s,%s,%s,%s,shown=%s" % (
    values.get("my_value"), values.get("thing"), values.get("arr"), values.get("API_KEY"), absent, shown
)
run(MEASURE + "\nsecond = measured", "m2")
run(MEASURE + "\nthird = measured", "m3")
_, outs = run(
    "print(second[0] - first[0] - (third[0] - second[0]), second[1] - first[1], "
    "second[2] - first[2] - (third[2] - second[2]), second[3] - first[3], "
    "'cell_hooks_fire' if third[0] - second[0] >= 4 else 'cell_hooks_silent')",
    "report",
)
send({"op": "shutdown"})
p.wait(timeout=30)
report = "".join(o.get("text", "") for o in outs if o.get("output_type") == "stream").split()
print("ok", *report, "|".join(completed), doc.get("signature"), variables)
