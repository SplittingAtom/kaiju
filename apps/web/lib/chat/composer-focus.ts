/**
 * When the composer takes the focus on its own (KOBE-840, Chris 2026-11-25): on page load, on New
 * chat and when another conversation comes on screen (the Threads panel, the palette, a search
 * hit), so the member can type straight away. Never over a dialog or menu, never away from another
 * field the member is in, and never on a touch screen's page load (no keyboard popping up).
 */

/** An open layer the focus must not be taken from: a dialog, a menu, a listbox, a popover. */
export const OPEN_LAYER = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/**
 * How long a focus request waits for an open layer to close: the one the choice was made in (the
 * Threads panel, the palette, a menu) closes right after it. Past this the focus stays put.
 */
export const LAYER_CLOSE_WAIT_MS = 1_500;

/** A field the member types or picks in (the composer itself excepted). */
export function isTypingField(el: Element | null, composer: Element | null): boolean {
  if (el === null || el === composer) return false;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  // An editor (CodeMirror's content, a rich field) or a widget that takes typing.
  if (el.closest('[contenteditable]:not([contenteditable="false"])') !== null) return true;
  if (el.matches('[role="textbox"], [role="searchbox"], [role="combobox"]')) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (el as HTMLInputElement).type;
  return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes(
    type,
  );
}

/** Whether a visible layer is open in `doc` (one the composer is inside does not count). */
export function hasOpenLayer(doc: Document, composer: Element | null): boolean {
  for (const el of doc.querySelectorAll(OPEN_LAYER)) {
    if (composer !== null && el.contains(composer)) continue;
    if ((el as HTMLElement).hidden || el.closest("[hidden], [inert]") !== null) continue;
    return true;
  }
  return false;
}

/** The page was loaded on a touch screen (a coarse primary pointer): no keyboard on load. */
export function coarsePointer(win: Window): boolean {
  try {
    return win.matchMedia?.("(pointer: coarse)").matches === true;
  } catch {
    return false;
  }
}

export type FocusVerdict = "focus" | "wait" | "skip";

/** Where the focus was when the request was made (the New button, a row in the Threads panel). */
export interface FocusRequest {
  readonly before: Element | null;
  /** `before` was inside an open layer, which closes onto the thread and puts the focus back. */
  readonly fromLayer: boolean;
}

/**
 * The request as it is made now. At page load nothing asked: focus anywhere but the page itself
 * (an editor that opened with the page, say) is left alone.
 */
export function focusRequest(doc: Document, atLoad = false): FocusRequest {
  if (atLoad) return { before: null, fromLayer: false };
  const before = doc.activeElement;
  return { before, fromLayer: before?.closest(OPEN_LAYER) != null };
}

/** The member moved the focus since the request: it is theirs, not ours to take. */
function movedSince(doc: Document, request: FocusRequest): boolean {
  const at = doc.activeElement;
  if (at === null || at === doc.body || at === request.before) return false;
  // The layer the choice was made in put the focus back where it was before it opened.
  return !(request.fromLayer && request.before !== null && !request.before.isConnected);
}

/**
 * What to do now about focusing `composer`: focus it, wait for an open layer to close (the Threads
 * panel closing onto the chosen thread), or leave the focus where it is (on another field, or
 * wherever the member has moved it since the request).
 */
export function focusVerdict(
  doc: Document,
  composer: HTMLElement | null,
  request: FocusRequest = { before: null, fromLayer: false },
): FocusVerdict {
  if (composer === null || !composer.isConnected) return "skip";
  const at = doc.activeElement;
  if (at === composer) return "skip";
  if (isTypingField(at, composer)) return "skip";
  if (hasOpenLayer(doc, composer) || composer.closest("[inert], [hidden]") !== null) return "wait";
  return movedSince(doc, request) ? "skip" : "focus";
}

/**
 * Set on the composer while it holds a focus it took on its own and the member has not used it
 * yet: an editor that opens then (a file restored with the page) may take the focus from it.
 */
export const AUTO_FOCUS_ATTR = "data-kaiju-autofocus";

const CLEARS = ["keydown", "input", "pointerdown", "blur"] as const;

/** Focuses the composer, marked as taken on its own until the member types, presses or leaves. */
export function autoFocusComposer(composer: HTMLElement): void {
  composer.setAttribute(AUTO_FOCUS_ATTR, "");
  const clear = () => {
    composer.removeAttribute(AUTO_FOCUS_ATTR);
    for (const type of CLEARS) composer.removeEventListener(type, clear);
  };
  for (const type of CLEARS) composer.addEventListener(type, clear);
  composer.focus({ preventScroll: true });
}
