#!/usr/bin/env node
import { pino } from "pino";
import { z } from "zod";
import { waitForMigrations } from "../wait.js";

// initContainer for the server and scheduler: wait (as the app role) for this build's migrations.
const logger = pino({ base: { service: "kaiju-db-wait" } });

const envSchema = z.object({
  KAIJU_DATABASE_URL: z.url({
    protocol: /^postgres(ql)?$/,
    error: "KAIJU_DATABASE_URL must be a postgres:// URL",
  }),
  KAIJU_DB_WAIT_TIMEOUT_S: z.coerce.number().int().positive().default(600),
});

async function main(): Promise<void> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  await waitForMigrations({
    databaseUrl: parsed.data.KAIJU_DATABASE_URL,
    timeoutMs: parsed.data.KAIJU_DB_WAIT_TIMEOUT_S * 1000,
  });
  logger.info("migrations are current");
}

main().catch((err: unknown) => {
  logger.error({ err }, "waiting for migrations failed");
  process.exit(1);
});
