import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NOTEBOOK_COMPLETE_MATCHES_MAX, notebookCompletionResultSchema } from "@kaiju/protocol";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The kernel bridge's completion helpers (KOBE-808, images/sandbox/kernel/kobe-kernel-bridge.py)
 * on plain Python (testing/completion-harness.py): `doc` resolves names without running any of the
 * member's code (no property getter, `__getattr__`, repr or call), and `completion_result` caps
 * and cleans a `complete_reply`. The real kernel (jedi off, limited evaluation, silent requests)
 * is checked by images/sandbox/test-image.sh.
 */
const BRIDGE = fileURLToPath(
  new URL("../../../../images/sandbox/kernel/kobe-kernel-bridge.py", import.meta.url),
);
const HARNESS = fileURLToPath(new URL("./testing/completion-harness.py", import.meta.url));
const hasPython = spawnSync("python3", ["--version"]).status === 0;

function harness(scenario: string): Record<string, unknown> | null {
  const res = spawnSync("python3", ["-I", HARNESS, BRIDGE, scenario], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (res.status !== 0) throw new Error(`harness failed: ${res.stderr}`);
  return JSON.parse(res.stdout) as Record<string, unknown> | null;
}

describe.skipIf(!hasPython)("kernel documentation lookup (KOBE-808)", () => {
  it("a method through an instance: its signature without self, its docstring; nothing runs", () => {
    const d = harness("doc:h.method");
    expect(d).toMatchObject({
      found: true,
      signature: "method(x, y=2)",
      doc: "Doc of method.",
      type: "function",
      ran: [],
    });
  });

  it("a property: the getter's docstring, the getter never runs", () => {
    expect(harness("doc:h.prop")).toMatchObject({ found: true, doc: "The prop.", ran: [] });
    expect(harness("doc:h.prop")).not.toHaveProperty("signature");
  });

  it("a missing attribute: not found, and __getattr__ never runs", () => {
    expect(harness("doc:h.nothing")).toMatchObject({ found: false, ran: [] });
  });

  it("an instance: its type's docstring, never its repr; no signature for a callable instance", () => {
    const d = harness("doc:h");
    expect(d).toMatchObject({ found: true, type: "Hostile", doc: "A Hostile object.", ran: [] });
    expect(d).not.toHaveProperty("signature");
    // object's own docstring is never shown for a class without one.
    expect(harness("doc:p")).toEqual(
      expect.objectContaining({ found: true, type: "Plain", ran: [] }),
    );
    expect(harness("doc:p")).not.toHaveProperty("doc");
  });

  // Review M1: lazy proxies and hooked objects run nothing either (isinstance's __class__
  // fallback, __getattribute__, metaclass __getattr__, __wrapped__/__signature__, default reprs).
  it.each([
    [
      "lz",
      {
        found: true,
        type: "ClassProperty",
        doc: "A lazy proxy's trick: __class__ is a property (Django's SimpleLazyObject).",
      },
    ],
    ["lz.method", { found: true, signature: "method(a)", doc: "Doc of a proxy method." }],
    ["ga", { found: true, type: "GetAttribute", doc: "Every attribute read runs code." }],
    ["ga.method", { found: true, signature: "method(a)", doc: "Doc of a watched method." }],
    ["WM", { found: true, type: "Meta", doc: "A class with a hooked metaclass." }],
    // A class with a metaclass other than `type` is not looked into (its hooks would run).
    ["WM.__init__", { found: false }],
    ["proxy", { found: true, type: "LazyProxy" }],
    ["proxy.anything", { found: false }],
    ["with_defaults", { signature: "with_defaults(a, b=…, *rest, c=1, d=…, **more)" }],
    ["wrapped", { signature: "wrapped(a)", doc: "Wrapped." }],
    ["WD", { signature: "WD(x)" }],
    ["WMG", { found: true, type: "MetaGA", doc: "Hooked class." }],
    ["WMG.method", { found: false }],
    ["wmg.method", { found: true, signature: "method()", doc: "Never looked into." }],
  ])("%s: described statically, nothing of the member's runs", (name, expected) => {
    const d = harness(`doc:${name}`);
    expect(d).toMatchObject({ ...expected, ran: [] });
  });

  it("a class with a custom metaclass gets no signature (reading it could run the metaclass)", () => {
    expect(harness("doc:WM")).not.toHaveProperty("signature");
  });

  it("functions, classes, static methods, modules and builtins", () => {
    expect(harness("doc:add")).toMatchObject({ signature: "add(a, b=1)", doc: "Adds." });
    expect(harness("doc:Hostile")).toMatchObject({ signature: "Hostile()", type: "type" });
    expect(harness("doc:Hostile.static")).toMatchObject({
      signature: "static(a)",
      doc: "Doc of static.",
    });
    expect(harness("doc:json.dumps")).toMatchObject({ found: true, type: "function" });
    expect(harness("doc:json")).toMatchObject({ found: true, type: "module" });
    expect(harness("doc:len")).toMatchObject({ found: true, signature: "len(obj, /)" });
    expect(harness("doc:nope")).toMatchObject({ found: false });
  });
});

/** The bridge's static completer on the hostile namespace; `codes` completed at their end. */
function completeAll(...codes: string[]) {
  const res = spawnSync("python3", ["-I", HARNESS, BRIDGE, "complete", ...codes], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (res.status !== 0) throw new Error(`harness failed: ${res.stderr}`);
  return JSON.parse(res.stdout) as {
    results: Record<string, { texts?: string[]; cursor_start?: number; error?: string }>;
    ran: string[];
    lock_locked: boolean;
    cached: boolean;
  };
}

/**
 * Review round 3: kernel completion is the bridge's own static resolver (IPython's completer is
 * never called). Every probe of the three review rounds records zero calls into member code.
 */
describe.skipIf(!hasPython)("kernel completion: nothing of the member's runs (KOBE-808)", () => {
  const PROBES = [
    // round 1: hooks, __class__, properties
    "h.",
    "h.prop.",
    "hooks.",
    "hooks['",
    "hooks[",
    "lz.",
    "lz[",
    "ga.",
    "WM.",
    "proxy.",
    // round 2: cached_property (lock-holding), descriptors, metaclass hooks, hashing keys
    "lzy.cp.",
    "lzy.p.",
    "hd.d.",
    "HD.d.",
    "WMG.",
    "WMG.x.",
    "dd[1].",
    "dd['alpha'].",
    // round 3: the keyword-argument path (an open call)
    "lzy.p.m(",
    "lzy.cp.m(",
    "lz(",
    "proxy.m(",
    "ga.method(",
    "hd.d.bit_length(",
    "sp(",
    "WM(",
    "WMG(",
    "dd2[(1, 1)].",
    "lazy_mod.nope.",
    "lazy_mod.",
    // round 4: keys that are not plain str (namespace and instance dicts) are never touched
    "zz",
    "my_v",
    "sized.",
    "sized.method(",
  ];
  let r: ReturnType<typeof completeAll>;
  beforeAll(() => {
    r = completeAll(...PROBES);
  });

  it("records zero calls: no getter, descriptor, hook, hash, eq or call; no lock, no cache", () => {
    expect(r.ran).toEqual([]);
    expect(r.lock_locked).toBe(false);
    expect(r.cached).toBe(false);
    for (const code of PROBES) expect(r.results[code]?.error, code).toBeUndefined();
  });

  it("stops at what it would have to run: no kernel matches there", () => {
    for (const code of [
      "h.prop.",
      "lzy.cp.",
      "lzy.p.",
      "hd.d.",
      "HD.d.",
      "WMG.",
      "WMG.x.",
      "lzy.p.m(",
      "lzy.cp.m(",
      "proxy.m(",
      "ga.method(",
      "sp(",
      "WM(",
      "lazy_mod.nope.",
      "hooks['",
    ]) {
      expect(r.results[code]?.texts, code).toEqual([]);
    }
    // A module's own dict only (its __getattr__ is never asked).
    expect(r.results["lazy_mod."]?.texts).toEqual(["real"]);
  });
});

describe.skipIf(!hasPython)("kernel completion: what it offers (KOBE-808)", () => {
  let r: ReturnType<typeof completeAll>;
  beforeAll(() => {
    r = completeAll(
      "my_v",
      "json.du",
      "keywords(",
      "keywords(1, c",
      "sized.",
      "Sized(",
      "sized.method(",
      "dd['",
      "dd[",
      "sorted(x, ",
      "dd[1].",
      "sized.own['k'][0].bit_l",
      "hid",
      "lz.method(",
    );
  });
  const texts = (code: string) => r.results[code]?.texts;

  it("names set by runs, module members and a plain instance's attributes", () => {
    expect(texts("my_v")).toEqual(["my_value"]);
    expect(texts("json.du")).toEqual(["dump", "dumps"]);
    expect(texts("sized.")).toEqual(["attr", "method", "own"]);
    expect(texts("dd[1].")).toEqual(["attr", "method", "own"]);
    expect(texts("sized.own['k'][0].bit_l")).toEqual(["bit_length"]);
    // IPython's own names stay out.
    expect(texts("hid")).toEqual([]);
  });

  it("keyword arguments from code objects and built-in text signatures", () => {
    expect(texts("keywords(")).toEqual(["a=", "b=", "c="]);
    expect(texts("keywords(1, c")).toEqual(["c="]);
    expect(texts("Sized(")).toEqual(["colour=", "size="]);
    expect(texts("sized.method(")).toEqual(["q="]);
    expect(texts("sorted(x, ")).toEqual(["key=", "reverse="]);
    expect(texts("lz.method(")).toEqual(["a="]);
  });

  it("keys of a plain dict, quoted or not, with the span they replace", () => {
    expect(texts("dd['")).toEqual(["alpha", "beta"]);
    expect(r.results["dd['"]?.cursor_start).toBe(4);
    expect(texts("dd[")).toEqual(["'alpha'", "'beta'", "1"]);
  });

  it("a 10-million-entry dict: answered within the budget, the next request at once", () => {
    const res = spawnSync("python3", ["-I", HARNESS, BRIDGE, "big"], {
      encoding: "utf8",
      timeout: 120_000,
    });
    if (res.status !== 0) throw new Error(`harness failed: ${res.stderr}`);
    const big = JSON.parse(res.stdout) as {
      big: { texts: string[]; elapsed_ms: number };
      then: { texts: string[]; elapsed_ms: number };
    };
    expect(big.big.texts).toHaveLength(200);
    expect(big.big.elapsed_ms).toBeLessThan(300);
    expect(big.then).toMatchObject({ texts: ["k"] });
    expect(big.then.elapsed_ms).toBeLessThan(100);
  });

  it("the bridge caps and cleans the answer", () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ text: `x${i}`, type: "variable" }));
    const capped = harness(
      `from:${JSON.stringify([{ matches: [...many, { text: "bad\u0000" }, { text: "y".repeat(300) }], cursor_start: 0 }, 1])}`,
    ) as { matches: unknown[] };
    expect(capped.matches).toHaveLength(NOTEBOOK_COMPLETE_MATCHES_MAX);
    expect(notebookCompletionResultSchema.safeParse(capped).success).toBe(true);
    expect(harness(`from:${JSON.stringify([{ matches: [], cursor_start: 5 }, 1])}`)).toBeNull();
  });
});
