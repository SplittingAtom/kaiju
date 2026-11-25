import { readBuiltinRenames, type BuiltinRenames, type KaijuDb } from "@kaiju/db";

/**
 * The `kaiju_mcp.renamed` marker (KOBE-826), cached briefly: the policy engine reads it for every
 * MCP call (deny and ask rules also match a tool's pre-rename names). Written once by migration
 * 0260 and never changed by the app, so a short cache is exact in practice; a failed read is not
 * cached and fails the decision closed.
 */
export interface RenamesSource {
  get(): Promise<BuiltinRenames>;
}

export function createRenamesSource(
  db: Pick<KaijuDb, "execute">,
  ttlMs = 5_000,
  now: () => number = Date.now,
): RenamesSource {
  let cached: { value: BuiltinRenames; at: number } | undefined;
  return {
    async get() {
      if (cached && now() - cached.at < ttlMs) return cached.value;
      const value = await readBuiltinRenames(db);
      cached = { value, at: now() };
      return value;
    },
  };
}
