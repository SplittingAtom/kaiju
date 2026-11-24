import { adoptLegacyEnv, legacyEnvMessage } from "@kaiju/protocol/legacy-env";
import { logger } from "../logger.js";

/**
 * First thing in every CLI entry point (KOBE-748): the old KOBE_* names move to KAIJU_* in
 * `process.env` for one release, with one warning naming them (never their values).
 */
export function adoptCliLegacyEnv(env: Record<string, string | undefined> = process.env): void {
  const report = adoptLegacyEnv(env);
  const message = legacyEnvMessage(report);
  if (message !== undefined) logger.warn(report, message);
}
