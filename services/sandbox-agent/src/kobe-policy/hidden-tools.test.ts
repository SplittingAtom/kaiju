import { describe, expect, it } from "vitest";
import { HIDDEN_TOOLS_ENV, hiddenToolsFrom, applyHiddenTools } from "./hidden-tools.js";

function fakePi(active: string[]) {
  const handlers: (() => unknown)[] = [];
  const state = { active: [...active] };
  return {
    state,
    handlers,
    pi: {
      on: (_event: "input", handler: () => unknown) => handlers.push(handler),
      getActiveTools: () => [...state.active],
      setActiveTools: (names: string[]) => {
        state.active = [...names];
      },
    },
  };
}

describe("hidden tools (KOBE-776)", () => {
  it("reads the variable once, removes it and ignores malformed names", () => {
    const env: Record<string, string | undefined> = { [HIDDEN_TOOLS_ENV]: "write,edit,Bad Name" };
    expect([...hiddenToolsFrom(env)]).toEqual(["write", "edit"]);
    expect(env).not.toHaveProperty(HIDDEN_TOOLS_ENV);
    expect(hiddenToolsFrom({}).size).toBe(0);
  });

  it("removes them from Pi's active tools now and before every prompt", () => {
    const f = fakePi(["read", "bash", "write", "edit"]);
    applyHiddenTools(f.pi, new Set(["write", "edit"]));
    expect(f.state.active).toEqual(["read", "bash"]);
    f.state.active = [...f.state.active, "write", "remember"]; // another hook re-adds one
    for (const h of f.handlers) h();
    expect(f.state.active).toEqual(["read", "bash", "remember"]);
  });

  it("does nothing without hidden tools or without Pi's active-tools API", () => {
    const f = fakePi(["read", "write"]);
    applyHiddenTools(f.pi, new Set());
    expect(f.handlers).toHaveLength(0);
    expect(() => applyHiddenTools({ on: () => undefined }, new Set(["write"]))).not.toThrow();
  });
});
