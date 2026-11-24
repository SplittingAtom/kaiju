import { mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SEMANTIC_MEMORY_PLACEMENTS, TERMINAL_EVENT_TYPES } from "@kaiju/protocol";
import { formatMemoryUse, memoryUse, parseExpectations } from "./memory-use.js";
import { cacheShares, formatCacheShare, runUsageSchema } from "./score.js";

/**
 * `e2e/memory-eval.sh cache` (KOBE-387): replays e2e/fixtures/memory-cache/turns.json in one new
 * thread on a running Kaiju through its public API, as a member would, and reports the cache-read
 * share from the gateway's usage records (`GET /v1/threads/{id}/usage`, the same `run_usage` rows
 * the docs/gates/gate-7a.md SQL reads). Gate A runs it once on the KOBE-382 build ("before") and
 * once on the KOBE-383 build ("after"). Everything comes from the environment (e2e/memory-eval.sh
 * lists it); nothing about an install is committed.
 *
 * KOBE-658: `KAIJU_EVAL_PLACEMENTS=system,latest_user_keep,...` replays the same turns once per Site
 * memory placement (each in a new thread; the member must be a Site admin, and the Site's own
 * placement is put back at the end) and reports, per mode, the cache-read share and memory use:
 * how many answers used the memories they should have (e2e/fixtures/memory-cache/expect.json).
 */
const env = z
  .object({
    KAIJU_EVAL_URL: z.url(),
    KAIJU_EVAL_EMAIL: z.string().optional(),
    KAIJU_EVAL_PASSWORD: z.string().optional(),
    KAIJU_EVAL_COOKIE: z.string().optional(),
    KAIJU_EVAL_TEAM_ID: z.uuid().optional(),
    KAIJU_EVAL_AGENT_ID: z.uuid().optional(),
    KAIJU_EVAL_MODEL: z.string().optional(),
    KAIJU_EVAL_SEED: z.enum(["0", "1"]).optional(),
    KAIJU_EVAL_LABEL: z.string().optional(),
    KAIJU_EVAL_OUT: z.string().optional(),
    /** KOBE-658: comma-separated Site memory placements to replay, one thread each. */
    KAIJU_EVAL_PLACEMENTS: z.string().optional(),
    /** Per-turn limit in seconds (default 300). */
    KAIJU_EVAL_TURN_TIMEOUT_S: z.coerce.number().int().positive().optional(),
  })
  .parse(process.env);

const FIXTURES = new URL("../../../../../e2e/fixtures/memory-cache/", import.meta.url);
const read = (f: string): unknown => JSON.parse(readFileSync(new URL(f, FIXTURES), "utf8"));
const turns = z
  .object({ turns: z.array(z.string().min(1)).length(20) })
  .parse(read("turns.json")).turns;
const seed = z
  .object({ items: z.array(z.record(z.string(), z.unknown())).min(1) })
  .parse(read("seed.json")).items;
const expectations = parseExpectations(read("expect.json"));
if (expectations.length !== turns.length) throw new Error("expect.json needs one entry per turn");
const placementSchema = z.enum(SEMANTIC_MEMORY_PLACEMENTS);
const placements = (env.KAIJU_EVAL_PLACEMENTS ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter((p) => p !== "")
  .map((p) => placementSchema.parse(p));
const SITE_MEMORY = "/v1/memory/settings?level=site";

const say = (text: string) => writeSync(1, `${text}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const BASE = env.KAIJU_EVAL_URL.replace(/\/+$/, "");
const ORIGIN = new URL(BASE).origin;
const TERMINAL = new Set<string>(TERMINAL_EVENT_TYPES);
const USAGE_WAIT_MS = 60_000;

/** A cookie-jar client of the public API (the browser's headers: Origin for the CSRF check). */
function client() {
  const jar = new Map<string, string>();
  for (const pair of (env.KAIJU_EVAL_COOKIE ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
  const team = env.KAIJU_EVAL_TEAM_ID;
  const headers = (extra: Record<string, string> = {}) => ({
    origin: ORIGIN,
    "content-type": "application/json",
    cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    ...(team ? { "x-kobe-team": team } : {}),
    ...extra,
  });
  const keep = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const at = pair.indexOf("=");
      if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
  };
  const self = {
    async call(method: string, path: string, body?: unknown) {
      const res = await fetch(BASE + path, {
        method,
        headers: headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      keep(res);
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // not JSON
      }
      return { status: res.status, json, text };
    },
    /**
     * Reads the run's event stream until a terminal event (or the deadline); `text` collects the
     * answer's text deltas (memory use, KOBE-658).
     */
    async waitForRun(runId: string, timeoutMs: number, text: string[] = []): Promise<string> {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const res = await fetch(`${BASE}/v1/runs/${runId}/events`, {
          headers: headers({ accept: "text/event-stream" }),
          signal: abort.signal,
        });
        if (res.status !== 200 || !res.body) return `stream ${res.status}`;
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk as Uint8Array, { stream: true });
          let at;
          while ((at = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const event = /^event: ?(.*)$/m.exec(block)?.[1];
            if (event && TERMINAL.has(event)) return event;
            if (event === "text.delta") text.push(deltaOf(block));
          }
        }
        return "stream ended";
      } catch (err) {
        return abort.signal.aborted ? "timeout" : String(err);
      } finally {
        clearTimeout(timer);
        abort.abort();
      }
    },
    async signIn() {
      if (env.KAIJU_EVAL_EMAIL && env.KAIJU_EVAL_PASSWORD) {
        const r = await self.call("POST", "/api/auth/sign-in/email", {
          email: env.KAIJU_EVAL_EMAIL,
          password: env.KAIJU_EVAL_PASSWORD,
        });
        if (r.status !== 200)
          throw new Error(`sign-in failed: ${r.status} ${r.text.slice(0, 200)}`);
      }
      if (team) {
        const r = await self.call("PUT", "/v1/me/teams/active", { teamId: team });
        if (r.status >= 300) throw new Error(`could not switch to the Workspace: ${r.status}`);
      }
    },
  };
  return self;
}

/** The `delta` of one `text.delta` SSE block ("" when it does not parse). */
function deltaOf(block: string): string {
  const data = /^data: ?(.*)$/m.exec(block)?.[1];
  try {
    const parsed = JSON.parse(data ?? "") as { payload?: { delta?: unknown } };
    const delta = parsed.payload?.delta;
    return typeof delta === "string" ? delta : "";
  } catch {
    return "";
  }
}

type Client = ReturnType<typeof client>;

async function setPlacement(c: Client, placement: string): Promise<void> {
  const r = await c.call("PUT", SITE_MEMORY, { settings: { placement } });
  if (r.status !== 200) {
    throw new Error(
      `could not set the placement (a Site admin?): ${r.status} ${r.text.slice(0, 200)}`,
    );
  }
}

describe("memory cache-read replay (KOBE-387)", () => {
  it("replays 20 turns and reports the cache-read share", async () => {
    const c = client();
    await c.signIn();
    if (env.KAIJU_EVAL_SEED === "1") {
      for (const item of seed) {
        const body = item.scope === "portable" ? { ...item, confirm_portable: true } : item;
        const r = await c.call("POST", "/v1/memory/semantic/items", body);
        say(
          `seed ${String(item.scope)}/${String(item.kind)}: ${r.status} ${String(r.json.code ?? "")}`,
        );
      }
    }
    if (placements.length === 0) {
      await replay(c, env.KAIJU_EVAL_LABEL ?? null, env.KAIJU_EVAL_OUT);
      return;
    }
    // KOBE-658: one thread per placement; the Site's own placement is put back at the end.
    const before = await c.call("GET", SITE_MEMORY);
    const original = z
      .object({ settings: z.object({ placement: placementSchema }) })
      .parse(before.json).settings.placement;
    const reports: Record<string, unknown>[] = [];
    try {
      for (const placement of placements) {
        await setPlacement(c, placement);
        const label = [env.KAIJU_EVAL_LABEL, placement].filter(Boolean).join(" ");
        reports.push({ placement, ...(await replay(c, label, undefined)) });
      }
    } finally {
      await setPlacement(c, original);
    }
    say("\nKAIJU-658 placements (cache share all / turns 2-20 / memory use):");
    for (const r of reports) {
      const s = r as unknown as {
        placement: string;
        all: { share: number | null };
        afterFirst: { share: number | null };
        memoryUse: { used: number; scored: number };
      };
      const pct = (v: number | null) => (v === null ? "-" : `${(v * 100).toFixed(1)}%`);
      say(
        `${s.placement.padEnd(18)} ${pct(s.all.share)} / ${pct(s.afterFirst.share)} / ` +
          `${s.memoryUse.used} of ${s.memoryUse.scored}`,
      );
    }
    if (env.KAIJU_EVAL_OUT)
      writeReport(env.KAIJU_EVAL_OUT, { label: env.KAIJU_EVAL_LABEL ?? null, reports });
  });
});

function writeReport(file: string, report: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(report, null, 2));
}

/** One replay of the 20 turns in a new thread: its cache shares and memory use. */
async function replay(c: Client, labelText: string | null, out: string | undefined) {
  {
    const made = await c.call("POST", "/v1/threads", {
      title: `memory cache replay ${labelText ?? ""}`.trim(),
      ...(env.KAIJU_EVAL_AGENT_ID ? { agent_id: env.KAIJU_EVAL_AGENT_ID } : {}),
      ...(env.KAIJU_EVAL_MODEL ? { model: env.KAIJU_EVAL_MODEL } : {}),
    });
    const threadId = made.json.thread_id;
    if (typeof threadId !== "string") {
      throw new Error(`could not create the thread: ${made.status} ${made.text.slice(0, 200)}`);
    }
    say(`thread ${threadId}`);
    const runIds: string[] = [];
    const answers: string[] = [];
    const timeoutMs = (env.KAIJU_EVAL_TURN_TIMEOUT_S ?? 300) * 1000;
    for (const [i, content] of turns.entries()) {
      const sent = await c.call("POST", `/v1/threads/${threadId}/messages`, { content });
      const runId = sent.json.run_id;
      if (sent.status !== 201 || typeof runId !== "string") {
        throw new Error(`turn ${i + 1}: message refused ${sent.status} ${sent.text.slice(0, 200)}`);
      }
      const text: string[] = [];
      const end = await c.waitForRun(runId, timeoutMs, text);
      answers.push(text.join(""));
      say(`turn ${i + 1}: run ${runId} ${end}`);
      if (end !== "run.completed") throw new Error(`turn ${i + 1} ended with ${end}`);
      runIds.push(runId);
    }
    // Usage is written by the gateway as calls finish; wait until every turn has a row.
    const deadline = Date.now() + USAGE_WAIT_MS;
    let shares;
    for (;;) {
      const r = await c.call("GET", `/v1/threads/${threadId}/usage`);
      if (r.status !== 200) throw new Error(`thread usage: ${r.status} ${r.text.slice(0, 200)}`);
      const usage = z.array(runUsageSchema).parse(r.json.runs);
      shares = cacheShares(usage, runIds);
      if (shares.missing.length === 0 || Date.now() > deadline) break;
      await sleep(2_000);
    }
    const use = memoryUse(expectations, answers);
    const label = labelText ? ` (${labelText})` : "";
    say(`\nKAIJU-387 cache replay${label}: thread ${threadId}, ${runIds.length} turns`);
    say(formatCacheShare("all turns", shares.all));
    say(formatCacheShare("turns 2-20", shares.afterFirst));
    say(formatMemoryUse(use));
    if (shares.missing.length > 0) say(`turns without usage: ${shares.missing.join(", ")}`);
    if (shares.all.cacheRead === 0) {
      say("no cache reads at all: does this model's provider report cached prompt tokens?");
    }
    const report = { label: labelText, threadId, runIds, ...shares, memoryUse: use };
    if (out) writeReport(out, report);
    expect(runIds).toHaveLength(turns.length);
    return report;
  }
}
