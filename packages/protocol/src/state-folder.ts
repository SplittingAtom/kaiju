/**
 * The sandbox's own folder on the workspace volume and the names Kaiju stored in Pi sessions and
 * thread entries before the rename (KOBE-827, spec rename-kaiju §11 A4).
 *
 * - The folder: `/workspace/.kaiju/` (Pi sessions, repo working copies, the agent's sync state).
 *   Volumes made before the rename hold `/workspace/.kobe/`; the sandbox agent moves it at wake,
 *   before Pi or any tool runs (sandbox-agent `workspace/state-folder.ts`). Both names stay
 *   agent-internal for good ({@link WORKSPACE_EXCLUDED_PREFIXES}): a folder left under the old
 *   name (a refused or failed move) is never synced, browsed or shared.
 * - Entry types: Pi session files and `thread_entries` rows written before the rename carry the
 *   old custom types (kaiju-tools' picks and conflict notes are not here: they only ever live in a
 *   model call's context, never in a session). Postgres is the record (D15) and is append-only history, so the rows are
 *   not rewritten: readers accept both names ({@link isEntryType}); writers use the new one.
 */
export const KAIJU_STATE_FOLDER = ".kaiju";
/** The folder's name before the rename: moved at wake, never created again. */
export const PRE_RENAME_STATE_FOLDER = ".kobe";

/** Custom entry types with the name each had before the rename (read, never written). */
export const PRE_RENAME_ENTRY_TYPES = {
  /** The sandbox agent's branch marker (`custom`). */
  "kaiju.branch": "kobe.branch",
  /** An MCP App card (`custom_message`, KOBE-440). */
  "kaiju.app_card": "kobe.app_card",
  /** A scheduled run's skipped-actions summary (`custom_message`, KOBE-178). */
  "kaiju.skipped_actions": "kobe.skipped_actions",
} as const;
export type KaijuEntryType = keyof typeof PRE_RENAME_ENTRY_TYPES;

/** Whether `customType` is `type` under its current name or the one it had before the rename. */
export function isEntryType(customType: unknown, type: KaijuEntryType): boolean {
  return customType === type || customType === PRE_RENAME_ENTRY_TYPES[type];
}

/**
 * Hello capability (KOBE-827): the agent takes the new entry type names in `run.start`. An older
 * agent (a sandbox still on the image from before the rename) gets app cards under their old
 * type, which its schema requires. One release (KOBE-754).
 */
export const CAPABILITY_KAIJU_NAMES = "kaiju_names";

/**
 * What the agent's move of the old folder did at this wake (`hello.state_folder`, sent only when
 * there was an old folder). `moved`: renamed in one step (an empty `.kaiju` folder or a link
 * there was removed first); `removed_empty`: the old folder was empty and is gone; `conflict`: both
 * folders hold data and both were left as they are (the agent runs on `.kaiju`); `failed`: the
 * rename failed and the old folder is intact; `not_a_folder`: `.kobe` is a link or a file, left
 * alone and never followed.
 */
export const STATE_FOLDER_OUTCOMES = [
  "moved",
  "removed_empty",
  "conflict",
  "failed",
  "not_a_folder",
] as const;
export type StateFolderOutcome = (typeof STATE_FOLDER_OUTCOMES)[number];

/**
 * KOBE-827 review round 2: a sandbox agent that cannot move the old folder exits with this code and
 * writes {@link STATE_FOLDER_TERMINATION_PREFIX} and the errno code (`...: EACCES`) to the
 * container's termination log, before the wire starts (a hello cannot carry it). The server's
 * stall check maps either to the stall cause `sandbox_start_failed` and a fixed member message;
 * nothing the sandbox wrote reaches a member (78 = EX_CONFIG).
 */
export const STATE_FOLDER_EXIT_CODE = 78;
export const STATE_FOLDER_TERMINATION_PREFIX = "kaiju-state-folder-move-failed";
/** The errno code in a termination message the agent wrote; undefined for any other text. */
export function stateFolderTerminationCode(message: string): string | undefined {
  const match = /^kaiju-state-folder-move-failed: ([A-Z][A-Z0-9_]{0,31})\s*$/.exec(message);
  return match?.[1];
}

/** The Pi provider id Kaiju's models were registered under before the rename (`kobe/<model>`). */
export const PRE_RENAME_PROVIDER_ID = "kobe";

// `.kaiju` or `.kobe` as a whole path segment: not part of a longer name (`x.kobe`, `.kobe-x`).
const FOLDER_NAME = /(?<![\w.-])\.(kaiju|kobe)(?![\w.-])/g;

/**
 * `value` with the state folder's name swapped for its other name wherever it appears as a path
 * segment (`/workspace/.kaiju/repos` → `/workspace/.kobe/repos` and back), or undefined when it
 * names neither. Policy rules use it (KOBE-827): a deny or ask rule written for one name also
 * matches a path under the other, so the move never lifts a rule; allow rules never do.
 */
export function swapStateFolderName(value: string): string | undefined {
  if (!value.includes(".kaiju") && !value.includes(".kobe")) return undefined;
  let changed = false;
  const swapped = value.replace(FOLDER_NAME, (_m, name: string) => {
    changed = true;
    return name === "kaiju" ? PRE_RENAME_STATE_FOLDER : KAIJU_STATE_FOLDER;
  });
  return changed ? swapped : undefined;
}
