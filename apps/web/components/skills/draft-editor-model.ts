import type { ApiError } from "../../lib/api/client";
import type { ManifestWritten } from "../../lib/skills/manifest-choice";

/** How long a file's edits pause before it is written, and the longest it waits while typing goes on. */
export const SAVE_IDLE_MS = 400;
export const SAVE_MAX_WAIT_MS = 1200;

export type SaveStatus = "saved" | "pending" | "saving" | "error" | "conflict";

export type ManifestOutcome =
  ({ readonly ok: true } & ManifestWritten) | { readonly ok: false; readonly error: ApiError };

/** The manifest's path (the package contract's reserved root name). */
export const MANIFEST = "kaiju.skill.yaml";

export const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** A change waits for the edits before it; when one of them failed, it doesn't go ahead. */
export const UNSAVED: ApiError = {
  status: 0,
  code: "unsaved_changes",
  message: "An earlier change isn't saved yet. Fix that first.",
};
