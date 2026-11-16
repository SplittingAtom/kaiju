import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SandboxToServerFrame } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { PICKS_HEADER } from "./memory/semantic-context.js";
import { sessionFilePath } from "./pi/session-files.js";
import { THREAD, runStart, startHarness, until, type Harness } from "./testing/harness.js";
import {
  FAUX_MODEL_EXTENSION,
  PI_AVAILABLE,
  PI_BIN,
  REAL_POLICY_EXTENSION,
  REAL_TOOLS_EXTENSION,
  fauxScript,
} from "./testing/real-pi.js";

/**
 * KOBE-662: the request up to the newest user message stays byte-stable from one message to the
 * next, against the REAL Pi with the real kobe-tools, through kobe-sandbox-agent, as gate1 runs
 * it. The server sends every run after the first with `parent_entry_id` = the thread's leaf, so
 * the agent stops Pi, appends the run's `kobe.branch` marker and starts a new Pi for each message.
 * Before the fix the picks notes of earlier messages lived only in kobe-tools' memory and died
 * with that Pi: `latest_user_keep` (and `tool_only`, which the server runs as keep until
 * KOBE-399) dropped the previous message's note on every turn, so the provider's cache (Ollama
 * Cloud keeps one checkpoint just before the end of the previous prompt) never hit. A scripted
 * model writes each request it is given (prompt, tools, messages) to a file.
 */
type PiEventFrame = Extract<SandboxToServerFrame, { type: "pi.event" }>;
type Msg = Record<string, unknown>;
type Request = { readonly messages: Msg[]; readonly [k: string]: unknown };

/** A picks note as the provider gets it: Pi sends the custom message in user role. */
const isNote = (m: Msg): boolean =>
  m.role === "user" && JSON.stringify(m.content).includes(`"text":"${PICKS_HEADER}\\n`);

let h: Harness | undefined;
afterEach(async () => {
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  h = undefined;
});

let n = 0;
const item = (over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  version: 1,
  scope: "team",
  kind: "fact",
  statement: "The staging cluster is k3s.",
  policy: false,
  pinned: false,
  provenance: { actor_kind: "user", as_of: null, saved_on: "2026-11-01" },
  ...over,
});
const POLICY = item({ scope: "site", kind: "convention", policy: true, statement: "POLICY-1" });
const PINNED = item({ pinned: true, statement: "PINNED-1" });
const PICKS = [item({ statement: "PICK-ONE" }), item({ statement: "PICK-TWO" })];
const HELD = item({ statement: "HELD-ONE" });

/** gate1's payload per placement; the picks change on every message. */
function memory(placement: string, turn: number) {
  const pick = PICKS[turn % 2];
  const items =
    placement === "stable_plus_delta"
      ? [POLICY, PINNED, { ...HELD, held: true }, pick]
      : placement === "tool_only"
        ? [POLICY, PINNED]
        : [POLICY, PINNED, pick];
  return {
    scopes: ["user"],
    indexes: [
      { scope: "user", content: "- [tea](tea.md) likes tea", version: 1, truncated: false },
    ],
    semantic: { items, omitted_count: 0, placement },
  };
}

async function sessionEntries(t: Harness): Promise<Msg[]> {
  const lines = (await readFile(sessionFilePath(t.sessions, THREAD), "utf8")).trim().split("\n");
  return lines.map((l) => JSON.parse(l) as Msg);
}

/** `turns` messages in one thread, each after the previous run ended; the requests, in order. */
async function replay(placement: string, turns: number): Promise<Request[]> {
  h = await startHarness({
    piBin: PI_BIN,
    env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION },
    extensions: [FAUX_MODEL_EXTENSION],
    toolsExtension: REAL_TOOLS_EXTENSION,
  });
  const t = h;
  const dump = path.join(t.dir, "requests.jsonl");
  const settled = () =>
    (t.server.frames("pi.event") as PiEventFrame[]).filter(
      (f) => (f.event as { type?: string }).type === "agent_settled",
    ).length;
  for (let i = 0; i < turns; i += 1) {
    // The server's branch point for a plain message: the thread's leaf (the session's last entry).
    const parent = i === 0 ? {} : { parent_entry_id: (await sessionEntries(t)).at(-1)?.id };
    const result = await t.server.command(
      runStart(fauxScript([{ dumpContext: dump, text: `answer ${i}`, turn: i }]), {
        run_id: randomUUID(),
        memory: memory(placement, i),
        ...parent,
      }),
      30_000,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    await until(() => settled() >= i + 1, 30_000);
  }
  // As on gate1: one `kobe.branch` marker (and so one Pi start) per message after the first.
  const markers = (await sessionEntries(t)).filter((e) => e.customType === "kobe.branch");
  expect(markers).toHaveLength(turns - 1);
  return (await readFile(dump, "utf8"))
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Request);
}

/** Pi bookkeeping no provider receives (timestamps) or that differs per answer (usage). */
const wire = (m: Msg): Msg => {
  const { timestamp: _t, usage: _u, durationMs: _d, api: _a, ...rest } = m;
  return rest;
};
const text = (req: Request, messages: readonly Msg[]): string =>
  JSON.stringify({ ...req, messages: messages.map(wire) });

/** First differing character, -1 when `a` is a prefix of `b` (what a provider cache needs). */
function firstDiff(a: string, b: string): number {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return i;
  return -1;
}

describe.skipIf(!PI_AVAILABLE)("KOBE-662: request prefix across messages (real Pi)", () => {
  it.each(["latest_user_keep", "tool_only", "stable_plus_delta"])(
    "%s: each request starts with the whole previous one, byte for byte",
    async (placement) => {
      const reqs = await replay(placement, 3);
      expect(reqs).toHaveLength(3);
      for (let i = 1; i < reqs.length; i += 1) {
        const prev = reqs[i - 1] as Request;
        const cur = reqs[i] as Request;
        const a = text(prev, prev.messages);
        // Up to the end of the previous request's messages (its answer and the new turn follow).
        const b = text(cur, cur.messages.slice(0, prev.messages.length));
        const at = firstDiff(a, b);
        expect(at, `turn ${i}: ${a.slice(at - 120, at + 80)} | ${b.slice(at - 120, at + 80)}`).toBe(
          -1,
        );
        // Every message keeps the note it was sent with.
        if (placement !== "tool_only") {
          expect(cur.messages.filter(isNote)).toHaveLength(i + 1);
        }
      }
    },
    120_000,
  );

  it("latest_user_strip: only the newest message has a note; the rest is unchanged", async () => {
    const reqs = await replay("latest_user_strip", 3);
    for (let i = 1; i < reqs.length; i += 1) {
      const prev = reqs[i - 1] as Request;
      const cur = reqs[i] as Request;
      const notes = cur.messages.filter(isNote);
      expect(notes).toHaveLength(1);
      expect(isNote(cur.messages.at(-2) ?? {})).toBe(true);
      // By design the previous message loses its note; everything else stays byte for byte.
      const unnoted = prev.messages.filter((m) => !isNote(m));
      expect(text(cur, cur.messages.slice(0, unnoted.length))).toBe(text(prev, unnoted));
    }
  }, 120_000);

  it("system: the history is stable, the system prompt changes only with the picks", async () => {
    const reqs = await replay("system", 3);
    const sys = (r: Request) => JSON.stringify(r.messages.filter((m) => m.role === "system"));
    const rest = (r: Request) => r.messages.filter((m) => m.role !== "system");
    expect(sys(reqs[0] as Request)).toContain("PICK-ONE");
    expect(sys(reqs[1] as Request)).toContain("PICK-TWO");
    expect(sys(reqs[2] as Request)).toBe(sys(reqs[0] as Request));
    for (let i = 1; i < reqs.length; i += 1) {
      const prev = rest(reqs[i - 1] as Request);
      const cur = rest(reqs[i] as Request);
      expect(JSON.stringify(cur.slice(0, prev.length).map(wire))).toBe(
        JSON.stringify(prev.map(wire)),
      );
    }
  }, 120_000);
});
