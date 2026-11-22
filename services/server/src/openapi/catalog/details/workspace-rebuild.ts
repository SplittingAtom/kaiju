import { confirmSchema } from "../../../routes/workspace-rebuild.js";
import { named, untyped, type CatalogDetail } from "../build.js";
import { bool, dateTime, nullable, obj, oneOfStrings } from "../json.js";

/**
 * Workspace rebuild after a lost volume (KOBE-739, `routes/workspace-rebuild.ts`): the member's own
 * (`/v1/workspace/rebuild`) and a team admin's for a member (`/v1/team/workspaces/{userId}/rebuild`)
 * answer the same shapes (KOBE-771). Error bodies are the `Error` envelope; `volume_not_yet_lost`
 * (409) adds `offer_at`, the status 429 adds `retry_after_ms` (and a `Retry-After` header).
 */

const RebuildStatus = untyped(
  "WorkspaceRebuildStatus",
  obj({
    // `rebuild.ts` RebuildStatus: a VolumeVerdict state, or `rebuilding` / `unknown`.
    volume: oneOfStrings("lost", "unreachable", "present", "missing", "rebuilding", "unknown"),
    last_synced_at: nullable(dateTime),
    rebuildable: bool,
    "down_since?": dateTime,
    "offer_at?": dateTime,
  }),
);

const RebuildResult = untyped(
  "WorkspaceRebuildResult",
  obj({ status: oneOfStrings("rebuilt", "already"), last_synced_at: nullable(dateTime) }),
);

const status: CatalogDetail = {
  response: RebuildStatus,
  responseDescription: "The volume's state; cached 30 s.",
  errors: ["429", "503"],
};

const rebuild: CatalogDetail = {
  body: named("WorkspaceRebuildConfirmBody", confirmSchema),
  response: RebuildResult,
  responseDescription: "Rebuilt (the next wake restores from the last sync), or already done.",
  errors: ["404", "409", "503"],
};

export const workspaceRebuildDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/workspace/rebuild": status,
  "post /v1/workspace/rebuild": rebuild,
};

export const teamWorkspaceRebuildDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/team/workspaces/{userId}/rebuild": status,
  "post /v1/team/workspaces/{userId}/rebuild": rebuild,
};
