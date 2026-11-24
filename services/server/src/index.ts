import { adoptLegacyEnv } from "@kaiju/protocol/legacy-env";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { DRAIN_TIMEOUT_MS } from "./startup/process-jobs.js";
import { startServer } from "./startup/server.js";

// The process entry point: the composition root is `startServer` (startup/server.ts, KOBE-709).
// KOBE-748: old KOBE_* names move to KAIJU_* before anything reads process.env (one release).
adoptLegacyEnv(process.env);
const server = await startServer(loadConfig(process.env));

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  // A shutdown that hangs past the drain timeout (open streams are cut at it) exits anyway.
  setTimeout(() => process.exit(1), DRAIN_TIMEOUT_MS + 1_000).unref();
  server.stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
