import { ENV_PREFIX, LEGACY_ENV_PREFIX } from "../node/legacy-env.js";

/** Tests (KOBE-748): the same environment with every KAIJU_* name under its old KOBE_* name. */
export function toLegacyEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => [
      k.startsWith(ENV_PREFIX) ? LEGACY_ENV_PREFIX + k.slice(ENV_PREFIX.length) : k,
      v,
    ]),
  );
}
