/**
 * Names that audit rows recorded before the rename keep (KOBE-826, append-only): the built-in
 * connectors' tool names (`mcp__kobe__docs_index`), the Kaiju settings and the Kaiju admin deny
 * codes; and (KOBE-831) Kaiju's skill publisher and the gallery agent's key and slug, `kobe`, which
 * are known by their field. The audit views show each as recorded, with the name it has now.
 */
import { parseMcpToolName, PRE_RENAME_KAIJU_NAMES, renamedStoredValue } from "@kaiju/protocol";

/** The name `value` has had since the rename, or undefined when it is no pre-rename name. */
export function renamedSince(
  value: unknown,
  segments: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (typeof value !== "string") return undefined;
  if (Object.hasOwn(PRE_RENAME_KAIJU_NAMES, value)) {
    return PRE_RENAME_KAIJU_NAMES[value as keyof typeof PRE_RENAME_KAIJU_NAMES];
  }
  const parsed = parseMcpToolName(value);
  if (!parsed || !segments || !Object.hasOwn(segments, parsed.server_segment)) return undefined;
  return `mcp__${segments[parsed.server_segment]}__${parsed.tool_segment}`;
}

/**
 * "(before the rename; now mcp__kaiju__docs_index)", or undefined. With the field and the event's
 * details, also the stored values known by their field (KOBE-831, `publisher: kobe`).
 */
export function renamedNote(
  value: unknown,
  segments: Readonly<Record<string, string>> | undefined,
  field?: { readonly key: string; readonly target: Readonly<Record<string, unknown>> },
): string | undefined {
  const now =
    renamedSince(value, segments) ??
    (field === undefined ? undefined : renamedStoredValue(field.key, value, field.target));
  return now === undefined ? undefined : `(before the rename; now ${now})`;
}

/** Every top-level value of an event's details that is a pre-rename name, with its note. */
export function renamedNotes(
  target: Readonly<Record<string, unknown>>,
  segments: Readonly<Record<string, string>> | undefined,
): { readonly key: string; readonly value: string; readonly note: string }[] {
  return Object.entries(target).flatMap(([key, value]) => {
    const note = renamedNote(value, segments, { key, target });
    return note === undefined ? [] : [{ key, value: value as string, note }];
  });
}
