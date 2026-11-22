/**
 * The kernel's variables as the Variables tab shows them (KOBE-804, wire KOBE-803). A snapshot
 * comes live from the sandbox on demand (`POST .../notebook/variables`) and is never stored by the
 * server or this page beyond the open tab. Reprs are untrusted text from the member's own code:
 * shown only as text (never HTML), with control and bidi characters made visible, cut short in
 * the row and capped when expanded; values of names that look like credentials, and environment
 * mappings, stay hidden until the member asks to see them.
 */

export interface Variable {
  readonly name: string;
  /** The type's qualified name (`int`, `DataFrame`). */
  readonly type: string;
  /** The type's top-level package (`numpy`, `pandas`, `__main__`); absent for built-ins. */
  readonly module?: string | undefined;
  readonly repr: string;
  readonly reprError?: "raised" | "timeout" | undefined;
  readonly len?: number | undefined;
  readonly shape?: readonly number[] | undefined;
  readonly dtype?: string | undefined;
  readonly columns?: readonly { readonly name: string; readonly dtype: string }[] | undefined;
  readonly columnsTotal?: number | undefined;
}

export interface OtherName {
  readonly name: string;
  readonly kind: "module" | "function" | "class";
}

export interface VariablesSnapshot {
  readonly status: "ok";
  readonly takenAt: string;
  readonly executionCount: number | null;
  readonly variables: readonly Variable[];
  readonly other: readonly OtherName[];
  readonly truncated: boolean;
  readonly stale?: boolean | undefined;
  readonly autoPaused?: "snapshot_timeout" | undefined;
}

export type VariablesResult =
  | VariablesSnapshot
  | {
      readonly status: "busy" | "no_kernel" | "unavailable";
      readonly autoPaused?: "snapshot_timeout" | undefined;
    };

/** Characters of a repr the row shows before an ellipsis; the expanded row shows the rest. */
export const ROW_REPR_CHARS = 80;
/** The most the expanded row shows (the wire caps reprs at 200; this guards a bigger one). */
export const FULL_REPR_CHARS = 400;

// C0 controls but tab and newline, DEL, C1 controls, and the bidi embeddings and isolates.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/gu; // eslint-disable-line no-control-regex

/** The text with control and direction-changing characters written as `\uXXXX`. */
export function visibleText(text: string): string {
  return text.replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** At most `max` characters, an ellipsis marking a cut. */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

const SECRET_NAME = /pass(word|wd)?|secret|token|api_?key|credential|private_?key|auth|cookie/iu;
const ENVIRON_TYPES = new Set(["_Environ", "environ"]);

/** Hidden until shown: a credential-like name, or an environment mapping (`os.environ`). */
export function isSensitive(v: Pick<Variable, "name" | "type">): boolean {
  return SECRET_NAME.test(v.name) || ENVIRON_TYPES.has(v.type);
}

/** `DataFrame`, or `numpy.ndarray` when the module adds something. */
export function typeLabel(v: Pick<Variable, "type" | "module">): string {
  return v.module && v.module !== "__main__" && v.module !== "builtins"
    ? `${v.module}.${v.type}`
    : v.type;
}

/** A short size summary: rows × columns, shape and dtype, or a length. Empty when none. */
export function summaryOf(v: Variable): string {
  const parts: string[] = [];
  if (v.columnsTotal !== undefined && v.shape?.length === 2) {
    parts.push(`${v.shape[0]} rows × ${v.columnsTotal} columns`);
  } else if (v.shape !== undefined) {
    parts.push(`shape (${v.shape.join(", ")}${v.shape.length === 1 ? "," : ""})`);
  } else if (v.len !== undefined) {
    parts.push(`len ${v.len}`);
  }
  if (v.dtype !== undefined) parts.push(v.dtype);
  return parts.join(" · ");
}

/** The value as the row says it: the repr (cut), or why there is none. */
export function reprText(v: Variable, max: number): string {
  if (v.reprError === "raised") return "(its repr raised an error)";
  if (v.reprError === "timeout") return "(its repr took too long)";
  return clip(visibleText(v.repr), max);
}

export type SortDir = "ascending" | "descending";

/** Variables whose name holds `filter` (any case), sorted by name. */
export function shownVariables(
  variables: readonly Variable[],
  filter: string,
  dir: SortDir,
): readonly Variable[] {
  const q = filter.trim().toLowerCase();
  const kept =
    q === "" ? [...variables] : variables.filter((v) => v.name.toLowerCase().includes(q));
  kept.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return dir === "ascending" ? kept : kept.reverse();
}
