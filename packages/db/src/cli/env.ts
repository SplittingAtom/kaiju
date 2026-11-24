import { legacyEnv, type LegacyEnvWarn } from "@kaiju/protocol/legacy-env";
import { z } from "zod";

/**
 * The environment of the migration Job and the wait initContainer, validated at startup. KAIJU_*
 * names; the old KOBE_* names stand in for one release with one warning (KOBE-748).
 */
type Env = Readonly<Record<string, string | undefined>>;

const migrateSchema = z.object({
  KAIJU_DB_MIGRATE_URL: z.url({
    protocol: /^postgres(ql)?$/,
    error: "KAIJU_DB_MIGRATE_URL must be a postgres:// URL",
  }),
  KAIJU_DB_APP_ROLE: z.string().min(1, "KAIJU_DB_APP_ROLE is required"),
  KAIJU_DB_CONNECT_TIMEOUT_S: z.coerce.number().int().positive().default(300),
});

const waitSchema = z.object({
  KAIJU_DATABASE_URL: z.url({
    protocol: /^postgres(ql)?$/,
    error: "KAIJU_DATABASE_URL must be a postgres:// URL",
  }),
  KAIJU_DB_WAIT_TIMEOUT_S: z.coerce.number().int().positive().default(600),
});

function parse<T>(schema: z.ZodType<T>, env: Env, warn: LegacyEnvWarn): T {
  const parsed = schema.safeParse(legacyEnv(env, warn));
  if (!parsed.success) {
    // Names and messages only, never values (the URLs hold passwords).
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

export type MigrateEnv = z.infer<typeof migrateSchema>;
export type WaitEnv = z.infer<typeof waitSchema>;

export const parseMigrateEnv = (env: Env, warn: LegacyEnvWarn): MigrateEnv =>
  parse(migrateSchema, env, warn);

export const parseWaitEnv = (env: Env, warn: LegacyEnvWarn): WaitEnv =>
  parse(waitSchema, env, warn);
