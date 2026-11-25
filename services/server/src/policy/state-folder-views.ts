import { swapStateFolderName, type JsonObject, type JsonValue } from "@kaiju/protocol";

/**
 * KOBE-827: the sandbox's folder moved from `/workspace/.kobe` to `/workspace/.kaiju`. A rule an
 * admin wrote for one name (a deny on `/workspace/.kobe/repos/**`, an ask on a command naming
 * `.kaiju/`) must keep applying to the same folder under the other name, so the move never lifts a
 * restriction: deny and ask rules, and the agent's `tools.deny`, also match the input with the
 * folder's name swapped (as KOBE-826 does for renamed tool names). Allow rules, remembered
 * approvals and `tools.allow` never do, so nothing is allowed that was not before. Permanent:
 * stored rules may keep either name forever, and a `.kobe` left beside `.kaiju` (a refused move)
 * still holds the same data.
 */
export function stateFolderViews(view: JsonObject): JsonObject[] {
  const swapped = swapValue(view);
  return swapped === undefined ? [] : [swapped as JsonObject];
}

/** `value` with the folder's name swapped in every string value, or undefined if none named it. */
function swapValue(value: JsonValue): JsonValue | undefined {
  if (typeof value === "string") return swapStateFolderName(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const s = swapValue(v);
      if (s === undefined) return v;
      changed = true;
      return s;
    });
    return changed ? out : undefined;
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const out: Record<string, JsonValue> = {};
    for (const [key, v] of Object.entries(value)) {
      const s = swapValue(v);
      if (s !== undefined) changed = true;
      out[key] = s ?? v;
    }
    return changed ? out : undefined;
  }
  return undefined;
}
