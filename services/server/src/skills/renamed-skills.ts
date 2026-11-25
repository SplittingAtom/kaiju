import { PRE_RENAME_KAIJU_SKILL_NAMES } from "@kaiju/protocol";
import { sql, type KaijuTx } from "@kaiju/db";

/**
 * An agent's skill names as they resolve now (KOBE-833, spec rename-kaiju §11 A12): a name one of
 * Kaiju's skills had before the rename (`kobe-guide`) reads as its new name (`kaiju-guide`), so
 * agents written before the rename (drafts, forks of the gallery agent, published versions, which
 * are immutable) keep getting the skill. Not where a catalog skill still holds the old name: a
 * maintainer's skill that had the name before Kaiju took it (KOBE-620), or Kaiju's own skill on a
 * Site where migration 0263 could not rename it. Order kept, duplicates dropped. Permanent.
 */
export async function currentSkillNames(tx: KaijuTx, names: readonly string[]): Promise<string[]> {
  const old = [...new Set(names)].filter((n) => Object.hasOwn(PRE_RENAME_KAIJU_SKILL_NAMES, n));
  if (old.length === 0) return [...new Set(names)];
  const { rows } = await tx.execute<{ name: string }>(sql`
    SELECT name FROM registry_skills WHERE name IN (${sql.join(
      old.map((n) => sql`${n}`),
      sql`, `,
    )})`);
  const held = new Set(rows.map((r) => r.name));
  const mapped = names.map((n) =>
    old.includes(n) && !held.has(n) ? (PRE_RENAME_KAIJU_SKILL_NAMES[n] ?? n) : n,
  );
  return [...new Set(mapped)];
}

/**
 * The names an agent may use for the catalog skill `name` (KOBE-833): the name itself, and the
 * pre-rename names that read as it (`currentSkillNames`), so "agents that name it" counts agents
 * written before the rename too.
 */
export async function namesResolvingTo(tx: KaijuTx, name: string): Promise<string[]> {
  const old = Object.entries(PRE_RENAME_KAIJU_SKILL_NAMES)
    .filter(([, now]) => now === name)
    .map(([before]) => before);
  if (old.length === 0) return [name];
  const current = await currentSkillNames(tx, old);
  return [name, ...old.filter((n) => !current.includes(n))];
}
