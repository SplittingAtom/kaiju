/**
 * The fake model's learning extractor (KOBE-675, Gate 7 on k3d): answers a `memory_learn` server
 * call (services/server/src/memory/learn/prompt/build.ts) with a reply that passes the protocol's
 * `memoryExtractorOutputSchema`, scripted by markers in the transcript, so learning passes run end
 * to end on k3d without a real model. Like a naive model, it offers whatever the transcript asks
 * for; the server's screen, selection and save checks decide what survives (an injection must
 * never become a Workspace or Site candidate: that is the server's job, not this fake's).
 *
 * A request is an extractor call when one of its user messages carries the transcript fence
 * (`<<<entry <nonce> id=<id> speaker=<speaker>>>>`). The reply's candidates, in transcript order,
 * at most {@link MAX_CANDIDATES}, each statement once:
 *
 * - `kaiju-learn {JSON}` (one line, in any entry): one candidate from the JSON's fields:
 *   `statement` (required); `kind` (fact); `scope` (`user` | `team`, default user); `portable`,
 *   `project_specific` (false); `source` (stated); `confidence` (0.9); `rationale`; `quote` (a
 *   verbatim span of the cited entry, default the statement); `target` (a substring of an
 *   existing memory's statement from the prompt's memories block: the operation becomes `update`,
 *   or `operation` when given, with that item's id); `cite` (`person` | `assistant`, default
 *   person: the evidence is the first such entry holding the directive, so `assistant` cites the
 *   fake's own echo, a claim the person never made).
 * - In the person's own messages: `I prefer <x>.` gives the preference "Prefers <x>." (personal)
 *   and `For the record: <fact>.` gives the Workspace fact "<Fact>." (stated, quoting it).
 *
 * Nothing else is offered, so a transcript without markers learns nothing (`{"candidates": []}`).
 */

const ENTRY_HEADER = /^<<<entry ([A-Za-z0-9]+) id=(\S+) speaker=([a-z]+)>>>$/;
const MEMORIES_OPEN = /^<<<memories ([A-Za-z0-9]+)>>>$/;
const DIRECTIVE = /kaiju-learn (\{[^\n]*\})/g;
const PREFERENCE = /\bI prefer ([^.!?\n]{3,200})[.!?]/g;
const RECORD = /\bFor the record: ([^\n]{3,300}?[.!?])(?=\s|$|['"])/g;
/** The protocol's cap per reply is 20; the server keeps at most 10 of them. */
const MAX_CANDIDATES = 20;
const QUOTE_MAX = 200;
const STATEMENT_MAX = 500;

export interface ExtractorEntry {
  readonly id: string;
  readonly speaker: string;
  readonly text: string;
}

export interface ExtractorMemory {
  readonly id: string;
  readonly statement: string;
}

interface Candidate {
  statement: string;
  kind: string;
  suggested_scope: "user" | "team";
  portable: boolean;
  project_specific: boolean;
  source: "stated" | "confirmed" | "inferred";
  operation: "add" | "update" | "supersede" | "conflict";
  target_id: string | null;
  confidence: number;
  rationale: string;
  evidence: { entry_id: string; quote: string }[];
}

function messageTexts(body: unknown): string[] {
  const messages = ((body ?? {}) as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return [];
  return messages
    .map((m) => (m ?? {}) as Record<string, unknown>)
    .filter((m) => m.role === "user")
    .map((m) => {
      const c = m.content;
      if (typeof c === "string") return c;
      return Array.isArray(c)
        ? c.map((p) => ((p as Record<string, unknown>).text as string | undefined) ?? "").join("")
        : "";
    });
}

/** The transcript entries of an extractor call, or undefined when the request is not one. */
export function extractorEntries(body: unknown): ExtractorEntry[] | undefined {
  const transcript = messageTexts(body).find((t) =>
    t.split("\n").some((line) => ENTRY_HEADER.test(line)),
  );
  if (transcript === undefined) return undefined;
  const entries: { id: string; speaker: string; lines: string[] }[] = [];
  let nonce: string | undefined;
  for (const line of transcript.split("\n")) {
    const header = ENTRY_HEADER.exec(line);
    if (header?.[1] && header[2] && header[3]) {
      nonce = header[1];
      entries.push({ id: header[2], speaker: header[3], lines: [] });
      continue;
    }
    if (nonce !== undefined && line === `<<<end ${nonce}>>>`) break;
    entries.at(-1)?.lines.push(line);
  }
  return entries.map((e) => ({ id: e.id, speaker: e.speaker, text: e.lines.join("\n") }));
}

/** The existing memories the prompt listed (id and statement), in its order. */
export function extractorMemories(body: unknown): ExtractorMemory[] {
  for (const text of messageTexts(body)) {
    const lines = text.split("\n");
    const open = lines.findIndex((l) => MEMORIES_OPEN.test(l));
    if (open < 0) continue;
    const nonce = MEMORIES_OPEN.exec(lines[open] ?? "")?.[1];
    const out: ExtractorMemory[] = [];
    for (const line of lines.slice(open + 1)) {
      if (line === `<<<end ${nonce}>>>`) break;
      try {
        const item = JSON.parse(line) as { id?: unknown; statement?: unknown };
        if (typeof item.id === "string" && typeof item.statement === "string")
          out.push({ id: item.id, statement: item.statement });
      } catch {
        // "(none)"
      }
    }
    return out;
  }
  return [];
}

const clip = (s: string, max: number) => [...s].slice(0, max).join("");
const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function base(
  statement: string,
  entryId: string,
  quote: string,
  over: Partial<Candidate> = {},
): Candidate {
  return {
    statement: clip(statement, STATEMENT_MAX),
    kind: "fact",
    suggested_scope: "user",
    portable: false,
    project_specific: false,
    source: "stated",
    operation: "add",
    target_id: null,
    confidence: 0.9,
    rationale: "The person said so in this conversation (fake extractor).",
    evidence: [{ entry_id: entryId, quote: clip(quote, QUOTE_MAX) }],
    ...over,
  };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const bool = (v: unknown): boolean => v === true;

function fromDirective(
  raw: string,
  entries: readonly ExtractorEntry[],
  memories: readonly ExtractorMemory[],
): Candidate | undefined {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const statement = str(d.statement);
  if (!statement) return undefined;
  const cite = str(d.cite) ?? "person";
  const entry = entries.find((e) => e.speaker === cite && e.text.includes(raw));
  if (!entry) return undefined;
  const targetText = str(d.target);
  const target = targetText ? memories.find((m) => m.statement.includes(targetText)) : undefined;
  const operation = (str(d.operation) ?? (target ? "update" : "add")) as Candidate["operation"];
  const scope = d.scope === "team" ? "team" : "user";
  return base(statement, entry.id, str(d.quote) ?? statement, {
    kind: str(d.kind) ?? "fact",
    suggested_scope: scope,
    portable: bool(d.portable),
    project_specific: bool(d.project_specific),
    source: (str(d.source) ?? "stated") as Candidate["source"],
    operation,
    target_id: operation === "add" ? null : (target?.id ?? null),
    confidence: typeof d.confidence === "number" ? d.confidence : 0.9,
    ...(str(d.rationale) ? { rationale: str(d.rationale) as string } : {}),
  });
}

function fromPersonText(entry: ExtractorEntry): Candidate[] {
  const out: Candidate[] = [];
  for (const m of entry.text.matchAll(PREFERENCE)) {
    const what = m[1]?.trim();
    if (what)
      out.push(base(`Prefers ${what}.`, entry.id, `I prefer ${what}`, { kind: "preference" }));
  }
  for (const m of entry.text.matchAll(RECORD)) {
    const fact = m[1]?.trim();
    if (fact)
      out.push(base(capitalised(fact), entry.id, fact, { kind: "fact", suggested_scope: "team" }));
  }
  return out;
}

/** The extractor's candidates for these entries (pure; tested). */
export function scriptedCandidates(
  entries: readonly ExtractorEntry[],
  memories: readonly ExtractorMemory[],
): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (c: Candidate | undefined) => {
    if (!c || seen.has(c.statement) || out.length >= MAX_CANDIDATES) return;
    seen.add(c.statement);
    out.push(c);
  };
  for (const entry of entries) {
    for (const m of entry.text.matchAll(DIRECTIVE))
      if (m[1]) add(fromDirective(m[1], entries, memories));
    if (entry.speaker === "person") for (const c of fromPersonText(entry)) add(c);
  }
  return out;
}

/** The extractor reply (JSON text) for a `memory_learn` request, or undefined for any other. */
export function extractorReply(body: unknown): string | undefined {
  const entries = extractorEntries(body);
  if (entries === undefined) return undefined;
  const candidates = scriptedCandidates(entries, extractorMemories(body));
  return JSON.stringify({ candidates, skill_hints: [] });
}
