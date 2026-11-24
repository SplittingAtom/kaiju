#!/usr/bin/env node
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { pino } from "pino";
import { z } from "zod";
import { isRetryableConnectError } from "../connect-errors.js";
import { MigrationCancelledError, runMigrations } from "../migrate.js";

// Entry point for the Helm pre-install/pre-upgrade migration Job.
const logger = pino({ base: { service: "kaiju-migrate" } });

const envSchema = z.object({
  KOBE_DB_MIGRATE_URL: z.url({
    protocol: /^postgres(ql)?$/,
    error: "KOBE_DB_MIGRATE_URL must be a postgres:// URL",
  }),
  KOBE_DB_APP_ROLE: z.string().min(1, "KOBE_DB_APP_ROLE is required"),
  KOBE_DB_CONNECT_TIMEOUT_S: z.coerce.number().int().positive().default(300),
});

/** A bundled database may still be starting (CloudNativePG post-install); retry until it accepts. */
async function waitForDatabase(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    try {
      await client.connect();
      return;
    } catch (err) {
      if (!isRetryableConnectError(err) || Date.now() >= deadline) throw err;
      logger.info("database not reachable yet; retrying");
      await sleep(3_000);
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

// Kubernetes stops the Job at its deadline (activeDeadlineSeconds) with SIGTERM: cancel the
// running statement in Postgres so no build keeps going (and holding the migration lock) after
// the pod is gone (KOBE-734).
const stop = new AbortController();
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    logger.warn({ signal: sig }, "stopping: cancelling the running migration statement");
    stop.abort(new Error(sig));
  });
}

async function main(): Promise<void> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  await waitForDatabase(
    parsed.data.KOBE_DB_MIGRATE_URL,
    parsed.data.KOBE_DB_CONNECT_TIMEOUT_S * 1000,
  );
  await runMigrations({
    databaseUrl: parsed.data.KOBE_DB_MIGRATE_URL,
    appRole: parsed.data.KOBE_DB_APP_ROLE,
    // Upgrade notes a migration raises (no content beyond ids and setting values).
    onNotice: (message) => logger.warn({ notice: message }, "migration notice"),
    signal: stop.signal,
  });
  logger.info({ appRole: parsed.data.KOBE_DB_APP_ROLE }, "migrations applied");
}

main().catch((err: unknown) => {
  if (err instanceof MigrationCancelledError) {
    logger.error(
      { err },
      "migration stopped before it finished (Job deadline or SIGTERM); the migrations before the " +
        "running one are applied, re-run the upgrade to continue (see postgres.migrateJob)",
    );
    process.exit(1);
  }
  logger.error({ err }, "migration failed");
  process.exit(1);
});
