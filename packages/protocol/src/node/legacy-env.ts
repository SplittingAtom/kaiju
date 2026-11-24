/**
 * One-release fallback for the old environment variable names (rename step RN-4, KOBE-748; spec
 * docs/specs/rename-kaiju.md §3 change 5). Every service reads `KAIJU_X`; for this release a
 * `KOBE_X` stands in for an unset `KAIJU_X`. When both are set, `KAIJU_X` wins. Either way the
 * service logs one warning that names the variables to rename (never their values: many are
 * secrets). RN-10 (KOBE-754) removes this module.
 *
 * The mapping is mechanical: `KOBE_` + rest becomes `KAIJU_` + rest, for every variable.
 */

/** The prefix every service reads. */
export const ENV_PREFIX = "KAIJU_";
/** The prefix accepted for one release. */
export const LEGACY_ENV_PREFIX = "KOBE_";

type Env = Record<string, string | undefined>;

/** Old names, never values. */
export interface LegacyEnvReport {
  /** Old names that stood in for an unset new name. */
  readonly renamed: readonly string[];
  /** Old names ignored because the new name is set too (the new one wins). */
  readonly conflicts: readonly string[];
}

/** Receives the one warning: a message plus the old names (no values). */
export type LegacyEnvWarn = (message: string, fields: LegacyEnvReport) => void;

const EMPTY: LegacyEnvReport = { renamed: [], conflicts: [] };

/** Reports already taken from an environment by {@link adoptLegacyEnv}, by environment object. */
const adopted = new WeakMap<object, LegacyEnvReport>();
/** Environments whose warning was already given. */
const warned = new WeakSet<object>();

/** `KOBE_X` → `KAIJU_X`. */
export function newEnvName(legacyName: string): string {
  return ENV_PREFIX + legacyName.slice(LEGACY_ENV_PREFIX.length);
}

function legacyNames(env: Readonly<Env>): string[] {
  return Object.keys(env)
    .filter((k) => k.startsWith(LEGACY_ENV_PREFIX) && env[k] !== undefined)
    .sort();
}

function merge(a: LegacyEnvReport, b: LegacyEnvReport): LegacyEnvReport {
  return {
    renamed: [...new Set([...a.renamed, ...b.renamed])].sort(),
    conflicts: [...new Set([...a.conflicts, ...b.conflicts])].sort(),
  };
}

/**
 * The environment as the services read it: a new object holding every variable except the old
 * names, with each old name's value under its new name where that is unset. The input is not
 * changed.
 */
export function resolveLegacyEnv(env: Readonly<Env>): { env: Env; report: LegacyEnvReport } {
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(LEGACY_ENV_PREFIX)) out[k] = v;
  }
  const renamed: string[] = [];
  const conflicts: string[] = [];
  for (const old of legacyNames(env)) {
    const name = newEnvName(old);
    if (env[name] === undefined) {
      out[name] = env[old];
      renamed.push(old);
    } else {
      conflicts.push(old);
    }
  }
  return { env: out, report: { renamed, conflicts } };
}

/**
 * Applies the fallback to `env` in place (meant for `process.env`, first thing in a process entry
 * point): each old name moves to its new name where that is unset and is removed either way, so
 * modules that read `process.env` and child processes see only the new names. Returns what moved;
 * a later {@link legacyEnv} on the same object still warns about it.
 */
export function adoptLegacyEnv(env: Env): LegacyEnvReport {
  const { report } = resolveLegacyEnv(env);
  for (const old of report.renamed) env[newEnvName(old)] = env[old];
  for (const old of [...report.renamed, ...report.conflicts]) Reflect.deleteProperty(env, old);
  adopted.set(env, merge(adopted.get(env) ?? EMPTY, report));
  return report;
}

/** The warning text for a report, or undefined when nothing needs renaming. */
export function legacyEnvMessage(report: LegacyEnvReport): string | undefined {
  if (report.renamed.length === 0 && report.conflicts.length === 0) return undefined;
  const parts = [
    `environment variables with the old ${LEGACY_ENV_PREFIX} prefix: rename them to ${ENV_PREFIX}… ` +
      `(the old names stop working in the next release)`,
  ];
  if (report.renamed.length > 0) {
    parts.push(`used for now: ${report.renamed.map((n) => `${n} → ${newEnvName(n)}`).join(", ")}`);
  }
  if (report.conflicts.length > 0) {
    parts.push(
      `ignored because the new name is set too and wins: ${report.conflicts
        .map((n) => `${n} (${newEnvName(n)} is used)`)
        .join(", ")}`,
    );
  }
  return parts.join("; ");
}

/**
 * For a service's `loadConfig(env)`: the environment to validate (see {@link resolveLegacyEnv}),
 * calling `warn` at most once per environment object with the old names found in it, including
 * those {@link adoptLegacyEnv} already moved.
 */
export function legacyEnv(env: Readonly<Env>, warn: LegacyEnvWarn): Env {
  const resolved = resolveLegacyEnv(env);
  const report = merge(adopted.get(env) ?? EMPTY, resolved.report);
  const message = legacyEnvMessage(report);
  if (message !== undefined && !warned.has(env)) {
    warned.add(env);
    warn(message, report);
  }
  return resolved.env;
}
