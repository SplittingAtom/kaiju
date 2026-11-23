import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NOTEBOOK_COMPLETE_MATCHES_MAX, notebookCompletionResultSchema } from "@kobe/protocol";
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
const GUARD = fileURLToPath(new URL("./testing/guard-harness.py", import.meta.url));
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

describe.skipIf(!hasPython)("kernel completion answers (KOBE-808)", () => {
  const valid = (r: unknown) =>
    expect(notebookCompletionResultSchema.safeParse(r).success).toBe(true);

  it("attribute matches start after the dot, deduplicated, with the kernel's types", () => {
    const r = harness("complete-dot");
    expect(r).toEqual({
      status: "ok",
      op: "complete",
      matches: [{ text: "align", type: "attribute" }, { text: "all" }, { text: "alpha" }],
      cursor_start: 3,
      cursor_end: 5,
    });
    valid(r);
  });

  it("caps the count and drops overlong or NUL matches", () => {
    const r = harness("complete-many") as { matches: { text: string }[] };
    expect(r.matches).toHaveLength(NOTEBOOK_COMPLETE_MATCHES_MAX);
    expect(r.matches.some((m) => m.text.startsWith("y") || m.text.includes("\u0000"))).toBe(false);
    valid(r);
  });

  it("an error reply is no answer; a cursor span outside the code falls back to the cursor", () => {
    expect(harness("complete-error")).toBeNull();
    expect(harness("complete-bad-cursor")).toMatchObject({ cursor_start: 2, cursor_end: 2 });
  });
});

/**
 * Review round 2: the kernel launcher's completer guard (COMPLETER_GUARD) on stand-in IPython
 * modules. Typing completion evaluates the expression before the cursor statically: no getter,
 * descriptor, `cached_property`, metaclass hook, key hash/eq, object hook or registered completer
 * of the member's runs; nothing is interrupted; nothing starts while a member's timer is pending.
 */
describe.skipIf(!hasPython)("the kernel's completer guard (KOBE-808 review)", () => {
  const run = () => {
    const res = spawnSync("python3", ["-I", GUARD, BRIDGE], { encoding: "utf8", timeout: 60_000 });
    if (res.status !== 0) throw new Error(`guard harness failed: ${res.stderr}`);
    return JSON.parse(res.stdout) as Record<string, unknown>;
  };
  let r: Record<string, unknown> = {};
  beforeAll(() => {
    r = run();
  });

  it("runs nothing of the member's: the lock is never taken, nothing is cached", () => {
    expect(r.ran).toEqual([]);
    expect(r.lock_locked).toBe(false);
    expect(r.cached_stored).toBe(false);
  });

  it("refuses properties, cached_property, descriptors, metaclass hooks and calls", () => {
    expect(r.evaluated).toEqual({
      "slow.locked": "rejected:GuardRejection",
      "slow.lazy": "rejected:GuardRejection",
      "slow.prop": "rejected:GuardRejection",
      "slow.method": "ok:function",
      "hd.nd": "rejected:GuardRejection",
      "hd.dd": "rejected:GuardRejection",
      "HD.nd": "rejected:GuardRejection",
      "WM.x": "rejected:GuardRejection",
      "wm.x": "ok:int",
      "ga.x": "rejected:GuardRejection",
      "d[1]": "ok:Plain",
      "d['a']['b']": "ok:int",
      "d[(1, 2)]": "rejected:GuardRejection",
      "hooks.zz": "rejected:GuardRejection",
      "plain.own['k'][0]": "ok:type",
      "plain.attr": "ok:int",
      "Plain.attr": "ok:int",
      "json.dumps": "ok:function",
      len: "ok:builtin_function_or_method",
      "slow.method()": "rejected:GuardRejection",
      "plain + 1": "rejected:GuardRejection",
    });
    expect(r.subscript).toEqual(["a", 1]);
  });

  it("lists attributes and keys statically; a registered completer is never consulted", () => {
    expect(r.dirs).toEqual({ hooks: false, plain_own: true, wm: true });
    expect(r.keys).toEqual({ hooks: [], dict: ["a"] });
    expect(r.generic).toEqual(["x"]);
  });

  it("completes normally, but not while a timer of the member's is pending", () => {
    expect(r.plain_answer).toEqual(["real"]);
    expect(r.with_timer).toEqual([]);
    expect(r.real_completions).toEqual(["pla"]);
  });
});
