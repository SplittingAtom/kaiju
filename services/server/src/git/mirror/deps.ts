import type { ServerDeps } from "../../deps.js";
import { logger } from "../../logger.js";
import type { MirrorDeps } from "./refresh.js";

/** The Repo mirror's dependencies from the server's (KOBE-766). */
export function mirrorDeps(deps: ServerDeps): MirrorDeps {
  return {
    db: deps.database.db,
    envelope: deps.envelope,
    net: deps.gitHostNet,
    blobs: deps.blobs,
    log: logger,
  };
}
