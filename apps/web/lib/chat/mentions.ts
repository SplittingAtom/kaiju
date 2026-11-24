/**
 * `@file` mentions in the composer (CE22, KOBE-223). A file picked with `@` (KOBE-756), dropped
 * from the Files tree or sent there with "Mention in message" (KOBE-374) is a chip of the draft
 * ({@link MentionStore}): no marker in the text while composing; the send appends the protocol's
 * marker, `@file(<path>)`, for each chip ({@link MentionStore.contentFor}) and lists the paths in
 * `mentions`, and the server rewrites exactly those markers to absolute `/workspace/...` paths.
 * A typed or pasted `@file(...)` or `@path` is never a chip, so it stays literal text.
 */
import type { TriggerItem } from "@assistant-ui/react";
import {
  decodeMentionPath,
  findMentionMarkers,
  MENTION_MAX_PER_MESSAGE,
  mentionMarker,
  mentionPathIssue,
  sandboxPathOf,
} from "@kaiju/protocol";
import type { FileEntry } from "../files/api";
import { mentionRefusal } from "./mention-insert";

/** The trigger character of file mentions (`/` is the command menu's, KOBE-224). */
export const MENTION_TRIGGER = "@";
/** The `TriggerItem.type` of a workspace file. */
export const MENTION_ITEM_TYPE = "file";

export interface ComposerMention {
  /** The marker as written in the text. */
  readonly raw: string;
  /** Relative to `/workspace`. */
  readonly path: string;
  readonly name: string;
  /** Where the agent will find it. */
  readonly sandboxPath: string;
}

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The mentions of `picked` paths in a text, in order, one per distinct marker: markers written
 * exactly as the send writes them (anything else is literal text).
 */
export function mentionsIn(text: string, picked: ReadonlySet<string>): readonly ComposerMention[] {
  const seen = new Set<string>();
  const out: ComposerMention[] = [];
  for (const m of findMentionMarkers(text)) {
    const path = decodeMentionPath(m.encoded);
    if (path === undefined || seen.has(m.raw) || !picked.has(path)) continue;
    if (m.raw !== mentionMarker(path)) continue;
    seen.add(m.raw);
    out.push({ raw: m.raw, path, name: nameOf(path), sandboxPath: sandboxPathOf(path) });
  }
  return out;
}

/**
 * Where the `@` being typed at `caret` starts, as assistant-ui's default trigger detection reads
 * it (the `@` starts the text or follows whitespace; no whitespace after it), or null.
 */
export function mentionStartAt(text: string, caret: number): number | null {
  const upTo = text.slice(0, caret);
  for (let i = upTo.length - 1; i >= 0; i -= 1) {
    const c = upTo[i] ?? "";
    if (/\s/u.test(c)) return null;
    if (c === MENTION_TRIGGER && (i === 0 || /\s/u.test(upTo[i - 1] ?? ""))) return i;
  }
  return null;
}

/** The query of an `@` being typed at `caret` (the text after it), or null. */
export function mentionQueryAt(text: string, caret: number): string | null {
  const start = mentionStartAt(text, caret);
  return start === null ? null : text.slice(start + 1, caret);
}

/** Whether the picker may offer a file: never one whose name holds invisible characters (B1). */
export function mentionable(entry: FileEntry): boolean {
  return entry.type === "file" && mentionPathIssue(entry.path) === undefined;
}

const NO_CHIPS: readonly string[] = [];

/**
 * The files mentioned per composer draft (the thread id, or the new-thread draft), for this tab,
 * as chips in the order they were added. Picks, drops and "Mention in message" all add chips.
 */
export class MentionStore {
  #chips = new Map<string, readonly string[]>();
  readonly #listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** The files mentioned in the draft, shown as chips (no marker in the text), in order. */
  readonly chips = (draft: string): readonly string[] => this.#chips.get(draft) ?? NO_CHIPS;

  /** A mentioned file: a chip until the send, which appends its marker. Never twice. */
  addChip(draft: string, path: string): void {
    const chips = this.chips(draft);
    if (chips.includes(path)) return;
    this.#setChips(draft, [...chips, path]);
  }

  removeChip(draft: string, path: string): void {
    const chips = this.chips(draft);
    if (!chips.includes(path)) return;
    this.#setChips(
      draft,
      chips.filter((p) => p !== path),
    );
  }

  /**
   * Chips kept with a draft in storage (KOBE-756), back on the draft: each is checked as a pick
   * would be (storage is not trusted), so nothing the rules refuse and never more than 20.
   */
  restore(draft: string, paths: readonly string[]): void {
    let chips = this.chips(draft);
    for (const path of paths) {
      if (typeof path !== "string" || chips.includes(path)) continue;
      if (chips.length >= MENTION_MAX_PER_MESSAGE) break;
      if (mentionRefusal(path, "file", chips) !== undefined) continue;
      chips = [...chips, path];
    }
    if (chips !== this.chips(draft)) this.#setChips(draft, chips);
  }

  /**
   * The message content a send carries: `text` with the markers of the draft's chips that it does
   * not already mention appended on a line of their own (blank text sends the markers alone).
   */
  contentFor(draft: string, text: string): string {
    const inText = new Set(mentionsIn(text, new Set(this.chips(draft))).map((m) => m.path));
    const markers = this.chips(draft)
      .filter((p) => !inText.has(p))
      .map((p) => mentionMarker(p));
    if (markers.length === 0) return text;
    const body = text.trimEnd();
    return body === "" ? markers.join(" ") : `${body}\n\n${markers.join(" ")}`;
  }

  /**
   * The paths a send lists in `mentions`: the draft's chips (their markers are in
   * {@link contentFor}'s result). `_text` is kept for the callers' symmetry with `contentFor`.
   */
  forText(draft: string, _text: string): string[] {
    return [...this.chips(draft)];
  }

  clear(draft: string): void {
    if (this.#chips.has(draft)) this.#setChips(draft, []);
  }

  /**
   * After a send (KOBE-415): drops the chips that went with it; chips added meanwhile stay.
   * `_remaining` (the text left in the composer) never holds a chip's marker.
   */
  settleSent(draft: string, sent: readonly string[], _remaining: string): void {
    const chips = this.chips(draft);
    const left = chips.filter((p) => !sent.includes(p));
    if (left.length !== chips.length) this.#setChips(draft, left);
  }

  /** A new thread was created by a send that failed: the chips follow the draft to it. */
  move(from: string, to: string): void {
    const chips = this.#chips.get(from);
    if (chips !== undefined) {
      this.#setChips(from, []);
      this.#setChips(to, chips);
    }
  }

  #setChips(draft: string, chips: readonly string[]): void {
    const next = new Map(this.#chips);
    if (chips.length === 0) next.delete(draft);
    else next.set(draft, chips);
    this.#chips = next;
    this.#notify();
  }

  #notify(): void {
    for (const l of this.#listeners) l();
  }
}

/** A workspace file as an item of the picker. */
export function fileItem(entry: FileEntry): TriggerItem {
  const folder = entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/")));
  return {
    id: entry.path,
    type: MENTION_ITEM_TYPE,
    label: entry.name,
    description: folder === "" ? "/workspace" : sandboxPathOf(folder),
    metadata: { area: entry.area },
  };
}
