/**
 * Built-in tools Pi is not offered this run (KOBE-776): the server names them in
 * `run.start.config.hidden_tools` because the agent's allow list leaves them out and every call
 * would be refused. The agent passes them in `KOBE_HIDDEN_TOOLS` (comma-separated); before each
 * prompt this removes them from Pi's active tools. kobe-policy loads last, so this runs after the
 * memory and project hooks have set theirs. Only narrows what Pi lists: the server still decides
 * every call, and a Pi without the active-tools API just keeps offering them (they are refused).
 */
export const HIDDEN_TOOLS_ENV = "KOBE_HIDDEN_TOOLS";

/** The slice of Pi's `ExtensionAPI` this uses (structural). */
export interface ActiveToolsApiLike {
  on(event: "input", handler: () => unknown): unknown;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

const NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** Reads (and removes) the variable; malformed names are ignored. */
export function hiddenToolsFrom(env: Record<string, string | undefined>): ReadonlySet<string> {
  const raw = env[HIDDEN_TOOLS_ENV];
  Reflect.deleteProperty(env, HIDDEN_TOOLS_ENV);
  if (raw === undefined || raw === "") return new Set();
  return new Set(raw.split(",").filter((name) => NAME.test(name)));
}

function isActiveToolsApi(pi: unknown): pi is ActiveToolsApiLike {
  const api = pi as Partial<ActiveToolsApiLike>;
  return (
    typeof api.on === "function" &&
    typeof api.getActiveTools === "function" &&
    typeof api.setActiveTools === "function"
  );
}

export function applyHiddenTools(pi: unknown, hidden: ReadonlySet<string>): void {
  if (hidden.size === 0 || !isActiveToolsApi(pi)) return;
  const sync = () => {
    const active = pi.getActiveTools();
    const kept = active.filter((name) => !hidden.has(name));
    if (kept.length !== active.length) pi.setActiveTools(kept);
  };
  sync();
  pi.on("input", sync);
}
