import { readFileSync } from "node:fs";
import { neutralizeMemoryMarkers } from "./memory-fence.js";
import { sanitizeRememberInput } from "./memory-tools.js";
import {
  TOOL_COMMIT_PROJECT,
  TOOL_RECALL,
  TOOL_REMEMBER,
  TOOL_SHOW_MEMORY_ITEM,
} from "./protocol.js";

/**
 * Per-run memory and project wiring of the kaiju-tools extension (KOBE-157, review of #205). The agent writes the
 * run's memory file (`KAIJU_MEMORY_FILE`, memory/context-file.ts) before every prompt, so a change
 * to memory never restarts Pi:
 *  - `tools`: whether memory is on for this run; `remember` / `recall` / `show_memory_item` are
 *    active only then;
 *  - `known` / `picks` (KOBE-383): "What Kaiju knows", the stable part first and the per-message
 *    picks after the project instructions; added with or without Notes (Policy reaches every agent);
 *  - `picks_placement` / `held` (KOBE-658): with `message_keep` / `message_strip` the picks leave
 *    the system prompt and go before the run's user message instead (see {@link installMemoryHooks});
 *    `held` (stable_plus_delta's held picks) joins the system prompt after the project;
 *  - `picks_notes` (KOBE-662): the notes earlier messages of the thread were sent with, kept by
 *    the agent across Pi restarts;
 *  - `text`: the run's memory section (already sanitised, capped and fenced by the agent), added
 *    to that run's system prompt only: not part of the launch, not stored in the session;
 *  - `project` and `viewing` (KOBE-245, KOBE-462): the project instructions and the fenced file
 *    the user has open, added the same way;
 *  - `project_write` (KOBE-580): the viewer may edit the run's project (`run.start.project.access`
 *    is `write`); `commit_project` is active only then (registerProjectHooks).
 * An unreadable or malformed file means no tools and no text (fail closed).
 */
export interface MemoryRunFile {
  readonly tools: boolean;
  readonly text: string;
  /** What Kaiju knows, stable part (KOBE-383): first, with or without Notes. */
  readonly known: string;
  /** What Kaiju knows, per-message picks (KOBE-383): after the project instructions. */
  readonly picks: string;
  /** Held picks (KOBE-658, stable_plus_delta): in the system prompt after the project. */
  readonly held: string;
  /** Where `picks` goes (KOBE-658): the system prompt, or before the run's user message. */
  readonly picksPlacement: PicksPlacement;
  /** The project-instructions block (KOBE-245); independent of whether memory is on. */
  readonly project: string;
  /** The viewed-file section (KOBE-462); independent of whether memory is on. */
  readonly viewing: string;
  /** Sync conflicts told at the run's start (KOBE-492): part of the run's system prompt. */
  readonly conflicts: string;
  /** Sync conflicts told mid-run (KOBE-492): a custom message before each later model call. */
  readonly conflictsLive: string;
  /** The viewer may edit the run's project (KOBE-580): `commit_project` is listed. */
  readonly projectWrite: boolean;
  /**
   * The notes of the thread's earlier messages (KOBE-662), by their user message's timestamp: the
   * agent keeps them across Pi restarts (the server restarts Pi for every message), so each
   * message keeps the note it was sent with and the request stays a cacheable prefix.
   */
  readonly picksNotes: ReadonlyMap<number, string>;
}
export type PicksPlacement = "system" | "message_keep" | "message_strip";
const PICKS_PLACEMENTS: readonly string[] = ["system", "message_keep", "message_strip"];

const OFF: MemoryRunFile = {
  tools: false,
  text: "",
  known: "",
  picks: "",
  held: "",
  picksPlacement: "system",
  project: "",
  viewing: "",
  conflicts: "",
  conflictsLive: "",
  projectWrite: false,
  picksNotes: new Map(),
};

/** Notes kept per thread (here and by the agent): older user messages lose theirs past this. */
export const PICKS_NOTES_MAX = 256;

/**
 * `picks_notes` as the agent writes it: `[[timestamp, text], ...]`, oldest first. Undefined when
 * malformed (the whole file then fails closed).
 */
function readPicksNotes(value: unknown): Map<number, string> | undefined {
  if (value === undefined) return new Map();
  if (!Array.isArray(value) || value.length > PICKS_NOTES_MAX) return undefined;
  const notes = new Map<number, string>();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return undefined;
    const [ts, text] = entry as unknown[];
    if (typeof ts !== "number" || !Number.isFinite(ts) || typeof text !== "string")
      return undefined;
    notes.set(ts, text);
  }
  return notes;
}

/**
 * What kaiju-tools puts before the run's user message outside `system` (KOBE-658): the parts that
 * change per message. The agent renders the same text to keep it for later messages (KOBE-662).
 */
export function perMessageNote(parts: {
  readonly picks: string;
  readonly viewing: string;
  readonly conflicts: string;
}): string {
  return [parts.picks, parts.viewing, parts.conflicts].filter((part) => part !== "").join("\n\n");
}

const optionalText = (value: unknown): string | undefined | false =>
  value === undefined ? undefined : typeof value === "string" ? value : false;

export function readMemoryRunFile(
  file: string | undefined,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): MemoryRunFile {
  if (file === undefined) return OFF;
  try {
    const value: unknown = JSON.parse(read(file));
    if (typeof value !== "object" || value === null) return OFF;
    const record = value as Record<string, unknown>;
    const { tools, text } = record;
    if (typeof tools !== "boolean" || typeof text !== "string") return OFF;
    // The other blocks are absent in files from an older agent: no such block.
    const project = optionalText(record.project);
    const viewing = optionalText(record.viewing);
    const conflicts = optionalText(record.conflicts);
    const conflictsLive = optionalText(record.conflicts_live);
    const known = optionalText(record.known);
    const picks = optionalText(record.picks);
    const held = optionalText(record.held);
    if ([project, viewing, conflicts, conflictsLive, known, picks, held].includes(false))
      return OFF;
    // Absent in files from an older agent: the system prompt, as KOBE-383 built it.
    const picksPlacement = record.picks_placement ?? "system";
    if (typeof picksPlacement !== "string" || !PICKS_PLACEMENTS.includes(picksPlacement)) {
      return OFF;
    }
    // Absent in files from an older agent: no write access (fail closed).
    const projectWrite = record.project_write ?? false;
    if (typeof projectWrite !== "boolean") return OFF;
    // Absent in files from an older agent: no earlier notes.
    const picksNotes = readPicksNotes(record.picks_notes);
    if (picksNotes === undefined) return OFF;
    return {
      tools,
      text: tools ? text : "",
      known: known || "",
      picks: picks || "",
      held: held || "",
      picksPlacement: picksPlacement as PicksPlacement,
      project: project || "",
      viewing: viewing || "",
      conflicts: conflicts || "",
      conflictsLive: conflictsLive || "",
      projectWrite,
      picksNotes,
    };
  } catch {
    return OFF;
  }
}

/** The slice of Pi's `ExtensionAPI` these hooks use. */
export interface MemoryHooksApi {
  on(event: string, handler: (event: never) => unknown): unknown;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

const MEMORY_TOOL_NAMES = [TOOL_REMEMBER, TOOL_RECALL, TOOL_SHOW_MEMORY_ITEM];
/** Tool results whose memory blocks are real, with their own fresh nonce (left as they are). */
const FENCED_RESULT_TOOLS: readonly string[] = [TOOL_RECALL, TOOL_SHOW_MEMORY_ITEM];

/** `customType` of the picks note before a user message (KOBE-658; never stored, never shown). */
export const MEMORY_PICKS_TYPE = "kobe-memory-picks";

export function installMemoryHooks(
  pi: MemoryHooksApi,
  file: string | undefined,
  read?: (path: string) => string,
): void {
  const state = () => readMemoryRunFile(file, read);
  // Runs before kaiju-policy (loaded last): the approval card shows the content as it is stored.
  pi.on("tool_call", ((event: { toolName: string; input: Record<string, unknown> }) => {
    if (event.toolName === TOOL_REMEMBER && typeof event.input === "object") {
      sanitizeRememberInput(event.input);
    }
  }) as never);
  // Memory is on or off per run (team, project and user switches): list the tools only when on.
  const syncTools = () => {
    const active = pi.getActiveTools().filter((name) => !MEMORY_TOOL_NAMES.includes(name));
    pi.setActiveTools(state().tools ? [...active, ...MEMORY_TOOL_NAMES] : active);
  };
  pi.on("input", syncTools as never);
  // KOBE-658: picks (and the viewed file and sync conflicts) placed in messages. Each run's note is
  // bound to the run's user message (by its timestamp: Pi creates the message right after
  // `before_agent_start`) and re-sent before it on every later request, byte for byte, so the
  // system prompt and the history stay cacheable. Never in the session (no memory text in thread
  // entries). KOBE-662: the server restarts Pi for every message (each run's `kobe.branch`
  // marker), so the agent keeps the notes (bound the same way, from the run's user message event)
  // and hands them back in the run file; this map only covers the current run until then. A new
  // agent (sandbox resumed) starts without them: one uncached request.
  const notes = new Map<number, string>();
  let pending: { readonly text: string; readonly since: number } | undefined;
  pi.on("before_agent_start", ((event: { systemPrompt: string }) => {
    // Stable first, so the provider caches the longest prefix (KOBE-383, Q6): What Kaiju knows'
    // stable part, Notes, project instructions; then what changes per message.
    const { known, text, project, held, picks, picksPlacement, viewing, conflicts } = state();
    // KOBE-658: outside `system` everything that changes per message (picks, the viewed file,
    // sync conflicts) goes before the run's user message, so the system prompt stays byte-stable.
    const inMessage = picksPlacement !== "system";
    const note = perMessageNote({ picks, viewing, conflicts });
    pending = inMessage && note !== "" ? { text: note, since: Date.now() } : undefined;
    const parts = [
      known,
      text,
      project,
      held,
      ...(inMessage ? [] : [picks, viewing, conflicts]),
    ].filter((part) => part !== "");
    return parts.length === 0
      ? undefined
      : { systemPrompt: `${event.systemPrompt}\n\n${parts.join("\n\n")}` };
  }) as never);
  // Sync conflicts told mid-run (KOBE-492): before each later model call of the run, a custom
  // message (Pi sends it in user role; the text says it is a Kaiju notice). Not stored in the
  // session: Pi's `context` result only shapes this request.
  // Tool results are rewritten for each request too (KOBE-383 review M1): a copy of a memory
  // block with the thread's nonce (stable across runs) never works as a fence there.
  pi.on("context", ((event: { messages: unknown[] }) => {
    const { conflictsLive, picksPlacement, picksNotes } = state();
    let cleaned = neutralizeToolResults(event.messages);
    if (picksPlacement !== "system") {
      if (pending !== undefined) {
        const key = runMessageKey(cleaned, pending.since);
        if (key !== undefined) {
          notes.set(key, pending.text);
          if (notes.size > PICKS_NOTES_MAX) notes.delete(notes.keys().next().value as number);
          pending = undefined;
        }
      }
      // The agent's notes of earlier messages (KOBE-662: they outlive this Pi), then this
      // process's own bindings (the current run's, before the agent has seen its message).
      const known = new Map(picksNotes);
      for (const [ts, text] of notes) if (!known.has(ts)) known.set(ts, text);
      cleaned = withPicksNotes(
        neutralizeUserMessages(cleaned),
        known,
        picksPlacement === "message_strip",
      );
    }
    if (conflictsLive === "") return cleaned === event.messages ? undefined : { messages: cleaned };
    return { messages: [...cleaned, conflictNoteMessage(conflictsLive)] };
  }) as never);
}

/**
 * The timestamp of a message a note may sit before: a user message, or a custom message that is
 * not one of kaiju-tools' own notes (a run Pi started from a custom message).
 */
const anchorTimestamp = (m: unknown, custom: boolean): number | undefined => {
  if (typeof m !== "object" || m === null) return undefined;
  const r = m as Record<string, unknown>;
  if (typeof r.timestamp !== "number") return undefined;
  if (r.role === "user") return r.timestamp;
  const own = r.customType === MEMORY_PICKS_TYPE || r.customType === CONFLICT_NOTE_TYPE;
  return custom && r.role === "custom" && !own ? r.timestamp : undefined;
};
const userTimestamp = (m: unknown): number | undefined => anchorTimestamp(m, true);

/**
 * The run's starting message: the last user message created at or after the run's
 * `before_agent_start`, else (a run started from a custom message) the first such custom message,
 * so the note always goes out with the run whose picks were recorded.
 */
function runMessageKey(messages: readonly unknown[], since: number): number | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const ts = anchorTimestamp(messages[i], false);
    if (ts !== undefined && ts >= since) return ts;
  }
  for (const m of messages) {
    const ts = anchorTimestamp(m, true);
    if (ts !== undefined && ts >= since) return ts;
  }
  return undefined;
}

/** The picks note as Pi sends it (a custom message reaches the model in user role). */
export function picksNoteMessage(text: string, timestamp: number): Record<string, unknown> {
  return {
    role: "custom",
    customType: MEMORY_PICKS_TYPE,
    content: text,
    display: false,
    timestamp,
  };
}

/**
 * Each user message that has a note gets it right before it (`strip`: only the newest such
 * message). Deterministic: the same transcript always gives the same request.
 */
export function withPicksNotes(
  messages: readonly unknown[],
  notes: ReadonlyMap<number, string>,
  strip: boolean,
): unknown[] {
  if (notes.size === 0) return messages as unknown[];
  let newest = -1;
  messages.forEach((m, i) => {
    const ts = userTimestamp(m);
    if (ts !== undefined && notes.has(ts)) newest = i;
  });
  if (newest < 0) return messages as unknown[];
  const placed = new Set<number>();
  return messages.flatMap((m, i) => {
    const ts = userTimestamp(m);
    const text = ts === undefined ? undefined : notes.get(ts);
    if (text === undefined || ts === undefined || placed.has(ts)) return [m];
    if (strip && i !== newest) return [m];
    // Once per key: another message created in the same millisecond never gets a second copy.
    placed.add(ts);
    return [picksNoteMessage(text, ts), m];
  });
}

/**
 * With picks in messages the preamble says blocks count only in Kaiju's notes and the system
 * prompt (KOBE-658), so a fence a person typed (or pasted) is put through
 * `neutralizeMemoryMarkers` for the request, like tool results. The same array when unchanged.
 */
export function neutralizeUserMessages(messages: readonly unknown[]): unknown[] {
  let changed = false;
  const out = messages.map((message) => {
    if (typeof message !== "object" || message === null) return message;
    const m = message as Record<string, unknown>;
    if (m.role !== "user") return message;
    const content = cleanContent(m.content);
    if (content === m.content) return message;
    changed = true;
    return { ...m, content };
  });
  return changed ? out : (messages as unknown[]);
}

/**
 * `commit_project` (KOBE-580) is registered with the `projects` capability but listed to the model
 * only in runs whose viewer may edit the project: a reader's runs never offer it (spec CM6, PR3).
 * Re-evaluated at every prompt, like the memory tools; an unreadable run file means not listed.
 */
export function registerProjectHooks(
  pi: MemoryHooksApi,
  file: string | undefined,
  read?: (path: string) => string,
): void {
  const syncTools = () => {
    const active = pi.getActiveTools().filter((name) => name !== TOOL_COMMIT_PROJECT);
    const write = readMemoryRunFile(file, read).projectWrite;
    pi.setActiveTools(write ? [...active, TOOL_COMMIT_PROJECT] : active);
  };
  pi.on("input", syncTools as never);
}

/** `customType` of the mid-run sync conflict note (KOBE-492). */
export const CONFLICT_NOTE_TYPE = "kobe-sync-conflict";

/** The Pi custom message that carries a mid-run sync conflict note (never displayed). */
export function conflictNoteMessage(text: string): Record<string, unknown> {
  return {
    role: "custom",
    customType: CONFLICT_NOTE_TYPE,
    content: text,
    display: false,
    timestamp: Date.now(),
  };
}

/**
 * Pi's messages with every tool result's text put through `neutralizeMemoryMarkers`, except
 * `recall` and `show_memory_item` (their blocks are real, sanitised memory with their own fresh
 * nonce). The same array when
 * nothing changed, so the request is untouched.
 */
export function neutralizeToolResults(messages: readonly unknown[]): unknown[] {
  let changed = false;
  const out = messages.map((message) => {
    if (typeof message !== "object" || message === null) return message;
    const m = message as Record<string, unknown>;
    if (m.role !== "toolResult" || FENCED_RESULT_TOOLS.includes(m.toolName as string))
      return message;
    const content = cleanContent(m.content);
    if (content === m.content) return message;
    changed = true;
    return { ...m, content };
  });
  return changed ? out : (messages as unknown[]);
}

function cleanContent(content: unknown): unknown {
  if (typeof content === "string") {
    const clean = neutralizeMemoryMarkers(content);
    return clean === content ? content : clean;
  }
  if (!Array.isArray(content)) return content;
  let changed = false;
  const blocks = content.map((block: unknown) => {
    if (typeof block !== "object" || block === null) return block;
    const b = block as Record<string, unknown>;
    if (b.type !== "text" || typeof b.text !== "string") return block;
    const text = neutralizeMemoryMarkers(b.text);
    if (text === b.text) return block;
    changed = true;
    return { ...b, text };
  });
  return changed ? blocks : content;
}
