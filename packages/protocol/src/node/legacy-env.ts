/**
 * One-release fallback for the old environment variable names (rename step RN-4, KOBE-748; spec
 * docs/specs/rename-kaiju.md §3 change 5). Every service reads `KAIJU_X`; for this release a
 * `KOBE_X` stands in for an unset or empty `KAIJU_X` (the chart renders some optional settings as
 * empty strings, which must not hide a value an operator set by hand under the old name). When
 * both are set and the new one is not empty, `KAIJU_X` wins. Either way the
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
  /** Old names that stood in for an unset or empty new name. */
  readonly renamed: readonly string[];
  /** Of `renamed`, those whose new name was set but empty (absent when none). */
  readonly emptyNew?: readonly string[];
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

// Kubernetes service-link variables (KOBE-836). With `enableServiceLinks` on (the Kubernetes
// default), every pod sees, for each Service `<svc>` in its namespace, `<SVC>_SERVICE_HOST`,
// `<SVC>_SERVICE_PORT[_<NAME>]`, `<SVC>_PORT` and `<SVC>_PORT_<n>_<PROTO>[_ADDR|_PORT|_PROTO]`.
// Services named `kobe-*` make these look like old settings; they are not ours to rename, so the
// fallback leaves them alone. A variable counts as one only when its value has the service-link
// shape and its `<SVC>_SERVICE_HOST` sibling holds an IP, so a real setting is never dropped.
const IPV4 = String.raw`(?:\d{1,3}\.){3}\d{1,3}`;
const IPV6 = String.raw`[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*`;
const IP_RE = new RegExp(`^(?:${IPV4}|${IPV6})$`);
const PORT_RE = /^\d{1,5}$/;
const PROTO_RE = /^(?:tcp|udp|sctp)$/;
const URL_RE = new RegExp(`^(tcp|udp|sctp)://(?:${IPV4}|\\[${IPV6}\\]):\\d{1,5}$`);
const SERVICE_HOST = "_SERVICE_HOST";

/** True when `rest` (the name after `<SVC>_`) and `value` have a service-link variable's shape. */
function serviceLinkShape(rest: string, value: string): boolean {
  if (rest === "SERVICE_HOST") return IP_RE.test(value);
  if (/^SERVICE_PORT(?:_[A-Z0-9_]+)?$/.test(rest)) return PORT_RE.test(value);
  if (rest === "PORT") return URL_RE.test(value);
  const m = /^PORT_\d{1,5}_(TCP|UDP|SCTP)(?:_(ADDR|PORT|PROTO))?$/.exec(rest);
  if (m === null) return false;
  const [, proto, part] = m;
  if (part === "ADDR") return IP_RE.test(value);
  if (part === "PORT") return PORT_RE.test(value);
  if (part === "PROTO") return PROTO_RE.test(value);
  return URL_RE.exec(value)?.[1] === proto?.toLowerCase();
}

/** The `KOBE_*` names in `env` that are Kubernetes service-link variables. */
export function serviceLinkNames(env: Readonly<Env>): Set<string> {
  const services = Object.keys(env)
    .filter(
      (k) =>
        k.startsWith(LEGACY_ENV_PREFIX) &&
        k.endsWith(SERVICE_HOST) &&
        k.length > LEGACY_ENV_PREFIX.length + SERVICE_HOST.length &&
        IP_RE.test(env[k] ?? ""),
    )
    .map((k) => k.slice(0, -SERVICE_HOST.length) + "_");
  const out = new Set<string>();
  if (services.length === 0) return out;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || !k.startsWith(LEGACY_ENV_PREFIX)) continue;
    if (services.some((svc) => k.startsWith(svc) && serviceLinkShape(k.slice(svc.length), v))) {
      out.add(k);
    }
  }
  return out;
}

function legacyNames(env: Readonly<Env>, links: ReadonlySet<string>): string[] {
  return Object.keys(env)
    .filter((k) => k.startsWith(LEGACY_ENV_PREFIX) && env[k] !== undefined && !links.has(k))
    .sort();
}

const union = (a: readonly string[] = [], b: readonly string[] = []): string[] =>
  [...new Set([...a, ...b])].sort();

function report(renamed: string[], conflicts: string[], emptyNew: string[]): LegacyEnvReport {
  return emptyNew.length > 0 ? { renamed, conflicts, emptyNew } : { renamed, conflicts };
}

function merge(a: LegacyEnvReport, b: LegacyEnvReport): LegacyEnvReport {
  return report(
    union(a.renamed, b.renamed),
    union(a.conflicts, b.conflicts),
    union(a.emptyNew, b.emptyNew),
  );
}

/**
 * The environment as the services read it: a new object holding every variable except the old
 * names (Kubernetes service-link variables pass through unchanged and unreported), with each old name's value under its new name where that is unset, or empty while the
 * old value is not. The input is not changed.
 */
export function resolveLegacyEnv(env: Readonly<Env>): { env: Env; report: LegacyEnvReport } {
  const links = serviceLinkNames(env);
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(LEGACY_ENV_PREFIX) || links.has(k)) out[k] = v;
  }
  const renamed: string[] = [];
  const conflicts: string[] = [];
  const emptyNew: string[] = [];
  for (const old of legacyNames(env, links)) {
    const name = newEnvName(old);
    const current = env[name];
    if (current === undefined || (current === "" && env[old] !== "")) {
      out[name] = env[old];
      renamed.push(old);
      if (current === "") emptyNew.push(old);
    } else {
      conflicts.push(old);
    }
  }
  return { env: out, report: report(renamed, conflicts, emptyNew) };
}

/**
 * Applies the fallback to `env` in place (meant for `process.env`, first thing in a process entry
 * point): each old name moves to its new name where that is unset and is removed either way, so
 * modules that read `process.env` and child processes see only the new names. Returns what moved;
 * a later {@link legacyEnv} on the same object still warns about it.
 */
export function adoptLegacyEnv(env: Env): LegacyEnvReport {
  const found = resolveLegacyEnv(env).report;
  for (const old of found.renamed) env[newEnvName(old)] = env[old];
  for (const old of [...found.renamed, ...found.conflicts]) Reflect.deleteProperty(env, old);
  adopted.set(env, merge(adopted.get(env) ?? EMPTY, found));
  return found;
}

/** The warning text for a report, or undefined when nothing needs renaming. */
export function legacyEnvMessage(found: LegacyEnvReport): string | undefined {
  if (found.renamed.length === 0 && found.conflicts.length === 0) return undefined;
  const empty = new Set(found.emptyNew ?? []);
  const parts = [
    `environment variables with the old ${LEGACY_ENV_PREFIX} prefix: rename them to ${ENV_PREFIX}… ` +
      `(the old names stop working in the next release)`,
  ];
  if (found.renamed.length > 0) {
    const used = found.renamed.map(
      (n) =>
        `${n} → ${newEnvName(n)}${empty.has(n) ? ` (${newEnvName(n)} is set but empty, so ${n} is used)` : ""}`,
    );
    parts.push(`used for now: ${used.join(", ")}`);
  }
  if (found.conflicts.length > 0) {
    parts.push(
      `ignored because the new name is set too and wins: ${found.conflicts
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
  const found = merge(adopted.get(env) ?? EMPTY, resolved.report);
  const message = legacyEnvMessage(found);
  if (message !== undefined && !warned.has(env)) {
    warned.add(env);
    warn(message, found);
  }
  return resolved.env;
}
