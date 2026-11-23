import type { ServerDeps } from "../../deps.js";
import { logger } from "../../logger.js";
import type { ConversionDeps } from "./runner.js";

/** Convert to repo's dependencies from the server's (KOBE-765). */
export function conversionDeps(deps: ServerDeps): ConversionDeps {
  return {
    db: deps.database.db,
    envelope: deps.envelope,
    net: deps.gitHostNet,
    blobs: deps.blobs,
    mailer: deps.mailer,
    publicUrl: deps.publicUrl,
    log: logger,
  };
}
