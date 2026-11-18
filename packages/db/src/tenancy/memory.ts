import { ALL_PRIVILEGES, defineDomain } from "./types.js";

/** The optional pgvector columns of the three memory item version tables (KOBE-409, 0230). */
export const MEMORY_EMBEDDING_COLUMNS = ["embedding", "embedding_model", "embedding_dims"] as const;

/**
 * Semantic memory (v1.3, KOBE-376). Workspace items are team tables; portable and Site items are
 * site-wide, read with app-role grants and filtered by the server (no SECURITY DEFINER, KOBE-42).
 * File memory (`memory_docs`, the UI's Notes) stays in `workspace.ts`. Site stewards are the
 * `memory_steward` value of `site_grants` (identity).
 */
export const memory = defineDomain({
  team: [
    "semantic_memory_items",
    "semantic_memory_item_versions",
    "run_memory_items",
    // Run records for the site-wide lanes: the run belongs to the Workspace.
    "run_portable_memory_items",
    "run_site_memory_items",
    // Workspace memory stewards (KOBE-380): a grant on top of any Workspace role.
    "memory_stewards",
    // Pending objects owed one 7-day reminder (KOBE-645).
    "memory_reminders",
    // Phase B learning (KOBE-389): passes, candidates, dismissals, watermarks, Workspace proposals.
    "memory_learning_passes",
    "memory_candidates",
    "memory_dismissals",
    "memory_learning_watermarks",
    "memory_proposals",
    // Readers' suggestions for a project's Notes (KOBE-652).
    "memory_project_suggestions",
  ],
  siteWide: [
    "portable_memory_items",
    "portable_memory_item_versions",
    "site_memory_items",
    "site_memory_item_versions",
    // Phase C (KOBE-402): Workspaces' proposals for the Site; statement + justification only.
    "site_memory_proposals",
  ],
  grants: {
    // Portable preferences (like personal_skills): the server confines rows to their owner.
    portable_memory_items: ALL_PRIVILEGES,
    // Versions are immutable: append and read; DELETE only for the version cap (KOBE-378), which
    // the trigger limits to non-current versions no run used (0222).
    portable_memory_item_versions: ["SELECT", "INSERT", "DELETE"],
    // Site items (like site_settings): read in every Workspace; the server writes them only for
    // Site admins and stewards. DELETE: a purge of a Site item (its versions go with it).
    site_memory_items: ALL_PRIVILEGES,
    site_memory_item_versions: ["SELECT", "INSERT", "DELETE"],
    // Site proposals (KOBE-402): read only through server paths that filter by role (proposer,
    // the proposing Workspace's Team admins, Site admins and stewards). Withdrawn, expired and
    // decided rows stay as history; rows leave only with their Workspace (cascade), so no DELETE.
    site_memory_proposals: ["SELECT", "INSERT", "UPDATE"],
  },
  teamReferencing: {
    site_memory_proposals:
      "from_team_id names the proposing Workspace (SM19/SM20): a statement and justification its " +
      "Team admin confirmed for the Site, never evidence, rationale or thread links; ON DELETE " +
      "CASCADE takes a deleted Workspace's proposals. Server paths filter rows by role.",
  },
  // Optional pgvector embeddings (KOBE-409, 0230): the server writes them after a version is saved
  // (embed on save, backfill, re-embed); the immutability trigger lets only these columns change.
  // Granted only where the columns exist (no pgvector: none).
  columnGrants: {
    portable_memory_item_versions: { UPDATE: MEMORY_EMBEDDING_COLUMNS },
    site_memory_item_versions: { UPDATE: MEMORY_EMBEDDING_COLUMNS },
  },
});
