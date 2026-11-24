/**
 * The fake server's records and helpers (KOBE-717: out of `fake-kaiju.ts`): the wire shapes it
 * stores, as the server's tables hold them, and the JSON answers every area builds.
 */
import type { KaijuEvent } from "@kaiju/protocol";

export type Json = Record<string, unknown>;

export interface FakeThread {
  thread_id: string;
  title: string | null;
  status: "idle" | "running" | "interrupted";
  /** Stop holds the queue until the user resumes or sends (Chris's D17 decision, KOBE-26). */
  queue_paused: boolean;
  leaf_entry_id: string | null;
  deleted_at: string | null;
  last_activity_at: string;
  created_at: string;
  /** The thread's chosen model alias (KOBE-44); null = the team default. */
  model: string | null;
  /** The thread's chosen thinking level (KOBE-260); absent or null = the model's default. */
  thinking_level?: string | null;
  /** The model the thread's agent pins (KOBE-44/47 seam); it wins over `model`. */
  agent_model?: string | null;
  /** A builder test thread (KOBE-85): the draft's agent, no version, out of the lists. */
  is_test?: boolean;
  /** A Workbench test chat (KOBE-323): listed, runs only this draft. */
  skill_draft_id?: string;
  agent_id?: string | null;
  /** The agent version the thread is pinned to (D19); absent = none. */
  agent_version?: number | null;
  /** The agent's current published version, as the thread detail reports it (KOBE-420). */
  agent_current_version?: number | null;
  /** What the thread detail says of the pinned agent (KOBE-122). */
  agent_name?: string | null;
  agent_status?: "active" | "suspended" | "archived" | null;
  /** The thread's project and sharing (KOBE-163); `read_only` = shared to you by someone else. */
  project_id?: string | null;
  visibility?: "private" | "project" | "team";
  read_only?: boolean;
  /** For a reader: who shared it (KOBE-221); null once they left the team. */
  owner_name?: string | null;
  /** Set on a thread a schedule started (KOBE-173); absent = a normal thread. */
  schedule_id?: string | null;
  /** The owner's organization (CE19, KOBE-220); absent = neither. */
  pinned_at?: string | null;
  archived_at?: string | null;
  /** The team folder it is filed in (KOBE-534/536); absent or null = `Current`. */
  folder_id?: string | null;
  /** Fork provenance (KOBE-216): the source only when the viewer may open it. */
  forked_from_thread_id?: string | null;
  forked_from_title?: string | null;
  forked_at_entry_id?: string | null;
  /** The source was deleted forever (the key nulled): the lineage shows no hidden root (TL1). */
  forked_from_purged?: boolean;
  entries: FakeEntry[];
}

/** A catalog model as `GET /v1/team/models` answers it (KOBE-40/44). */
export interface FakeTeamModel {
  readonly alias: string;
  readonly label: string | null;
  enabled: boolean;
  is_default: boolean;
  /** Tokens; absent or null: unknown (KOBE-210). */
  context_window?: number | null;
  /** KOBE-260: what members may pick for it in the team; absent: no thinking control. */
  thinking_in_team?: { readonly default: string | null; readonly levels: readonly string[] };
}

/** An agent as `GET /v1/agents/runnable` lists it (KOBE-122). */
export interface FakeRunnableAgent {
  readonly id: string;
  readonly scope: "team" | "personal" | "gallery";
  readonly galleryKey?: string;
  /** The server's new-conversation default (KOBE-458). */
  readonly default?: true;
  /** Default: derived from the name. */
  readonly slug?: string;
  readonly name: string;
  readonly description?: string;
  readonly model: string | null;
  /** The current version's starters (KOBE-222); default none. */
  readonly starters?: readonly string[];
  /** The picker's group (agents-roster AR15, KOBE-571); absent: derived from the scope. */
  readonly group?: "personal" | "team" | "site";
  /** An admin's Dangerous agent (KOBE-476). */
  readonly dangerous?: true;
}

export interface FakeEntry {
  entry_id: string;
  parent_id: string | null;
  seq: number;
  type: string;
  payload: Json;
  payload_offloaded: boolean;
  created_at: string;
}

export interface FakeRun {
  run_id: string;
  thread_id: string;
  status: string;
  input: string;
  parent_entry_id: string | null;
  queue_pos: number;
  retry_of_run_id?: string;
  events: KaijuEvent[];
  compacted: boolean;
  /** Last entry this run committed (where its next entry hangs). */
  tip: string | null;
  client_key?: string;
  /** The model alias the server ran it with (the agent's pin, else the thread's; null = default). */
  model?: string | null;
  /** The prompt entry the run committed (`runs.user_entry_id`; KOBE-275 feedback lists it). */
  user_entry_id?: string;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly team: string | null;
  readonly idempotencyKey: string | null;
  readonly body: unknown;
}

export const NOW = "2026-10-02T10:00:00.000Z";
export const ORGANIZE: ReadonlySet<string | undefined> = new Set([
  "pin",
  "unpin",
  "archive",
  "unarchive",
  "move",
]);
export const ACTIVE = new Set(["running", "waiting_approval"]);
export const ENDED = new Set(["completed", "failed", "interrupted", "cancelled", "budget_stopped"]);

export function uuid(prefix: number, n: number): string {
  return `00000000-0000-4000-8000-${String(prefix).padStart(4, "0")}${String(n).padStart(8, "0")}`;
}

export function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function error(status: number, code: string, message = code): Response {
  return json(status, { code, message });
}

/** An artifact (KOBE-55 D-6): `versions[0]` is version 1. */
export interface FakeArtifact {
  id: string;
  thread_id: string;
  kind: string;
  title: string;
  language: string | null;
  versions: string[];
}

/** The frame route's CSP, as D-6 specifies it (the server, KOBE-129, sets it). */
export const FAKE_FRAME_CSP =
  "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

/** The newest message entry whose text holds `q` (the fake's content search, CT15). */
export function matchedEntry(thread: FakeThread, q: string): string | null {
  const needle = q.toLowerCase();
  const hit = [...thread.entries].reverse().find((e) => {
    const message = (e.payload as { message?: { content?: unknown } }).message;
    return JSON.stringify(message?.content ?? "")
      .toLowerCase()
      .includes(needle);
  });
  return hit?.entry_id ?? null;
}

/** A deterministic 64-hex stand-in for the server's SHA-256 digest (tests only). */
export function fakeDigest(text: string): string {
  let out = "";
  for (let seed = 0; seed < 8; seed += 1) {
    let h = 0x811c9dc5 ^ seed;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return out;
}

/** One request as an area handler sees it (the JSON body parsed; `raw` as sent). */
export interface FakeRequest {
  readonly method: string;
  readonly url: URL;
  readonly body: Json | undefined;
  readonly raw: unknown;
  readonly headers: Headers;
}

/** An area's answer, or undefined when the path is not its own. */
export type FakeAnswer = Response | Promise<Response> | undefined;
