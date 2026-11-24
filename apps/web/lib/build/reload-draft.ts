/**
 * The composer's draft across the new-build banner's Reload (KOBE-487 ac-4). The banner marks the
 * reload as requested; each composer stashes its text when the page then unloads (`pagehide`,
 * so nothing is kept if the member cancels the unsaved-edits prompt) and takes it back once
 * after the reload, with the files it mentions as chips (KOBE-756). Kept per tab in sessionStorage; where storage is blocked the draft is lost
 * like on any reload. The stash lasts {@link RELOAD_DRAFT_TTL_MS} and sign-out clears it, so a
 * person signing in on the same tab later never gets another's draft.
 */
const KEY = "kaiju.reload-drafts";
/**
 * The key a build from before the rename to Kaiju stashes under: the Reload that installs the
 * rename itself starts on such a build, so its drafts are taken from there once (KOBE-749;
 * removed in KOBE-754).
 */
const LEGACY_KEY = "kobe.reload-drafts";
/** A reload takes seconds; anything older is not from the banner's Reload. */
export const RELOAD_DRAFT_TTL_MS = 10 * 60_000;

/** A composer's text and the workspace paths of its file chips. */
export interface ReloadDraft {
  readonly text: string;
  readonly mentions: readonly string[];
}

interface Stash {
  readonly savedAt: number;
  readonly drafts: Readonly<Record<string, ReloadDraft>>;
}

/** A kept entry: the current shape, or a plain text (kept before KOBE-756). */
function draftOf(value: unknown): ReloadDraft | undefined {
  if (typeof value === "string") return { text: value, mentions: [] };
  if (typeof value !== "object" || value === null) return undefined;
  const { text, mentions } = value as { text?: unknown; mentions?: unknown };
  if (typeof text !== "string") return undefined;
  const paths = Array.isArray(mentions)
    ? mentions.filter((m): m is string => typeof m === "string")
    : [];
  return { text, mentions: paths };
}

let reloadRequested = false;

export function requestReload(): void {
  reloadRequested = true;
}

export function isReloadRequested(): boolean {
  return reloadRequested;
}

/** For tests. */
export function resetReloadRequest(): void {
  reloadRequested = false;
}

/** Moves a stash written under {@link LEGACY_KEY} to {@link KEY} (when none is there yet). */
function adoptLegacyStash(): void {
  const legacy = sessionStorage.getItem(LEGACY_KEY);
  if (legacy === null) return;
  if (sessionStorage.getItem(KEY) === null) sessionStorage.setItem(KEY, legacy);
  sessionStorage.removeItem(LEGACY_KEY);
}

function readStash(): Readonly<Record<string, ReloadDraft>> {
  try {
    adoptLegacyStash();
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as Partial<Stash> | null;
    const savedAt = parsed?.savedAt;
    const drafts: unknown = parsed?.drafts;
    if (typeof savedAt !== "number" || typeof drafts !== "object" || drafts === null) return {};
    const age = Date.now() - savedAt;
    if (age < 0 || age > RELOAD_DRAFT_TTL_MS) {
      sessionStorage.removeItem(KEY);
      return {};
    }
    return Object.fromEntries(
      Object.entries(drafts).flatMap(([key, value]) => {
        const draft = draftOf(value);
        return draft === undefined ? [] : [[key, draft] as const];
      }),
    );
  } catch {
    return {}; // blocked storage or a garbled value: nothing to restore
  }
}

function writeStash(drafts: Readonly<Record<string, ReloadDraft>>): void {
  try {
    if (Object.keys(drafts).length === 0) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, JSON.stringify({ savedAt: Date.now(), drafts }));
  } catch {
    // Storage blocked or full: the draft goes with the page, as on any reload.
  }
}

/** Drops every kept draft (sign-out). */
export function forgetReloadDrafts(): void {
  writeStash({});
  try {
    sessionStorage.removeItem(LEGACY_KEY);
  } catch {
    // Storage blocked: nothing was kept under it either.
  }
}

/**
 * Keeps `text` and the chips' `mentions` for the composer of `draftKey` when the banner's Reload
 * unloads the page (nothing when both are empty).
 */
export function stashDraftForReload(
  draftKey: string,
  text: string,
  mentions: readonly string[] = [],
): void {
  if (!reloadRequested || (text.trim() === "" && mentions.length === 0)) return;
  writeStash({ ...readStash(), [draftKey]: { text, mentions: [...mentions] } });
}

/** The draft kept for `draftKey` by the last Reload, once. */
export function takeReloadDraft(draftKey: string): ReloadDraft | undefined {
  const stash = readStash();
  const draft = stash[draftKey];
  if (draft === undefined) return undefined;
  writeStash(Object.fromEntries(Object.entries(stash).filter(([k]) => k !== draftKey)));
  return draft;
}
