#!/usr/bin/env node
import { pino } from "pino";
import { waitForMigrations } from "../wait.js";
import { parseWaitEnv } from "./env.js";

// initContainer for the server and scheduler: wait (as the app role) for this build's migrations.
const logger = pino({ base: { service: "kaiju-db-wait" } });

async function main(): Promise<void> {
  const env = parseWaitEnv(process.env, (message, fields) => logger.warn(fields, message));
  await waitForMigrations({
    databaseUrl: env.KAIJU_DATABASE_URL,
    timeoutMs: env.KAIJU_DB_WAIT_TIMEOUT_S * 1000,
  });
  logger.info("migrations are current");
}

main().catch((err: unknown) => {
  logger.error({ err }, "waiting for migrations failed");
  process.exit(1);
});
