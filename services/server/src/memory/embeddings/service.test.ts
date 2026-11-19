import { describe, expect, it } from "vitest";
import type { KobeDb } from "@kobe/db";
import { BackgroundTasks } from "../../background.js";
import type { EmbeddingClient } from "../../models/embedding-client.js";
import { ServerCallError } from "../../models/gateway-client.js";
import { documentText, queryText, storedVectorModel } from "./prefixes.js";
import { MemoryEmbeddings, isBudgetSkip } from "./service.js";
import { pickEmbeddingModel } from "./model.js";
import { mergeVectorRows, startVectorLeg } from "../items/vector-leg.js";
import type { ItemRow } from "../items/item-row.js";

const silent = { info: () => undefined, warn: () => undefined };
const input = {
  teamId: "t",
  userId: "u",
  threadId: "th",
  runId: "r",
  message: "where do I park?",
};

function service(embed: EmbeddingClient["embed"], deadline = 30) {
  const s = new MemoryEmbeddings({
    db: undefined as unknown as KobeDb,
    client: { embed },
    background: new BackgroundTasks(),
    log: silent,
    queryDeadlineMs: deadline,
  });
  s.usableModel = async () => "kobe-local/nomic-embed-text";
  return s;
}

describe("query embedding deadline (KOBE-409)", () => {
  it("returns the vector made in time, with the query text and the run named", async () => {
    let seen: Parameters<EmbeddingClient["embed"]>[0] | undefined;
    const s = service(async (i) => {
      seen = i;
      return [[0.1, 0.2]];
    });
    expect(await s.queryVector(input)).toEqual({
      model: "kobe-local/nomic-embed-text",
      vector: [0.1, 0.2],
    });
    expect(seen?.inputs).toEqual(["where do I park?"]);
    expect(seen?.run).toEqual({ runId: "r", threadId: "th" });
  });

  it("gives up at the deadline and on errors (keywords alone)", async () => {
    const slow = service(
      (i) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve([[1]]), 500);
          i.signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new ServerCallError("timeout"));
          });
        }),
      20,
    );
    const started = Date.now();
    expect(await slow.queryVector(input)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(200);
    const failing = service(async () => {
      throw new ServerCallError("http_500");
    });
    expect(await failing.queryVector(input)).toBeUndefined();
  });

  it("asks for nothing without a model", async () => {
    let called = false;
    const s = service(async () => {
      called = true;
      return [[1]];
    });
    s.usableModel = async () => undefined;
    expect(await s.queryVector(input)).toBeUndefined();
    expect(called).toBe(false);
  });
});

describe("recall query embedding (KOBE-664)", () => {
  it("embeds the recall query now, as the run's member, with the model's query text", async () => {
    let seen: Parameters<EmbeddingClient["embed"]>[0] | undefined;
    const s = service(async (i) => {
      seen = i;
      return [[0.5, 0.6]];
    });
    // The selector's 30 ms deadline does not apply: recall is a tool call, not the run's start.
    s.usableModel = async () => {
      await sleep(40);
      return "kobe-local/nomic-embed-text";
    };
    expect(await s.recallVector({ ...input, message: "where's my car" })).toEqual({
      model: "kobe-local/nomic-embed-text",
      vector: [0.5, 0.6],
    });
    expect(seen?.inputs).toEqual(["where's my car"]);
    expect(seen?.run).toEqual({ runId: "r", threadId: "th" });
    expect(seen?.teamId).toBe("t");
    expect(seen?.userId).toBe("u");
  });

  it("answers undefined (keywords) on no model, a budget refusal, an error or its deadline", async () => {
    let called = false;
    const none = service(async () => {
      called = true;
      return [[1]];
    });
    none.usableModel = async () => undefined;
    expect(await none.recallVector(input)).toBeUndefined();
    expect(called).toBe(false);
    for (const code of ["budget_exhausted", "http_500"]) {
      const refused = service(async () => {
        throw new ServerCallError(code);
      });
      expect(await refused.recallVector(input)).toBeUndefined();
    }
    const slow = new MemoryEmbeddings({
      db: undefined as unknown as KobeDb,
      client: {
        embed: (i) =>
          new Promise((resolve, reject) => {
            const t = setTimeout(() => resolve([[1]]), 500);
            i.signal.addEventListener("abort", () => {
              clearTimeout(t);
              reject(new ServerCallError("timeout"));
            });
          }),
      },
      background: new BackgroundTasks(),
      log: silent,
      recallDeadlineMs: 20,
    });
    slow.usableModel = async () => "kobe-local/nomic-embed-text";
    const t0 = Date.now();
    expect(await slow.recallVector(input)).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(200);
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("query embedding started when the message is accepted (KOBE-409 review M1)", () => {
  /** A gateway call that takes `ms` (token checks, budget reservation, Bifrost, the provider). */
  const slowEmbed = (ms: number, order: string[]) => async () => {
    order.push("embed");
    await sleep(ms);
    return [[0.3, 0.4]];
  };

  it("starts the embedding before selection, which only waits for it within the deadline", async () => {
    const order: string[] = [];
    const s = service(slowEmbed(80, order), 20);
    s.runWantsVectors = async () => true;
    s.prefetchQuery(input);
    await sleep(120); // the sandbox claim or wake
    order.push("select");
    const t0 = Date.now();
    expect(await s.queryVector(input)).toEqual({
      model: "kobe-local/nomic-embed-text",
      vector: [0.3, 0.4],
    });
    expect(Date.now() - t0).toBeLessThan(15);
    expect(order).toEqual(["embed", "select"]);
    // Started once per run, even when delivery asks again.
    s.prefetchQuery(input);
    expect(order).toEqual(["embed", "select"]);
  });

  it("without the early start the same call misses the deadline (keywords alone)", async () => {
    const s = service(slowEmbed(80, []), 20);
    expect(await s.queryVector(input)).toBeUndefined();
  });

  it("a selection that comes before the embedding answered still waits only the deadline", async () => {
    const s = service(slowEmbed(200, []), 20);
    s.runWantsVectors = async () => true;
    s.prefetchQuery(input);
    const t0 = Date.now();
    expect(await s.queryVector(input)).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("pays for nothing when the run reads no memory lane, and never embeds again at selection", async () => {
    const order: string[] = [];
    const s = service(slowEmbed(1, order), 20);
    s.runWantsVectors = async () => false;
    s.prefetchQuery(input);
    expect(await s.queryVector(input)).toBeUndefined();
    expect(order).toEqual([]);
  });

  it("an early embedding of another message is not used", async () => {
    let seen = "";
    const s = service(async (i) => {
      seen = i.inputs[0] ?? "";
      return [[1]];
    }, 50);
    s.runWantsVectors = async () => true;
    s.prefetchQuery({ ...input, message: "an edited message" });
    await sleep(5);
    expect(await s.queryVector(input)).toEqual({
      model: "kobe-local/nomic-embed-text",
      vector: [1],
    });
    expect(seen).toBe("where do I park?");
  });
});

describe("vector leg deadline (KOBE-409 L5)", () => {
  it("reads no rows once the deadline passed", async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      return [];
    };
    const db = undefined as unknown as KobeDb;
    const late = new Promise<{ model: string; vector: number[] }>((resolve) =>
      setTimeout(() => resolve({ model: "m/x", vector: [1] }), 40),
    );
    expect(await startVectorLeg(db, { teamId: "t", userId: "u" }, late, 10, read)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(reads).toBe(0);
    const inTime = Promise.resolve({ model: "m/x", vector: [1] });
    expect(await startVectorLeg(db, { teamId: "t", userId: "u" }, inTime, 50, read)).toEqual([]);
    expect(reads).toBe(1);
  });
});

describe("embedding helpers (KOBE-409)", () => {
  it("prefixes per model family", () => {
    // nomic-embed-text ranks better without its card's prefixes on the relevance set (gate-7b).
    expect(documentText("kobe-local/nomic-embed-text", "x")).toBe("x");
    expect(queryText("mac/nomic-embed-text:latest", "x")).toBe("x");
    expect(queryText("mac/qwen3-embedding:0.6b", "x")).toMatch(/^Instruct: .*\nQuery: x$/s);
    expect(documentText("mac/qwen3-embedding:0.6b", "x")).toBe("x");
    expect(queryText("openai/text-embedding-3-small", "x")).toBe("x");
    expect(queryText("m/nomic-embed-text", "y".repeat(5000))).toHaveLength(4000);
    expect(queryText("m/qwen3-embedding:0.6b", "y".repeat(5000))).toHaveLength(4000);
  });

  it("stores vectors under the document scheme, so a scheme change re-embeds", () => {
    // nomic's documents lost their prefix (scheme 2): vectors stored by scheme 1 no longer match.
    expect(storedVectorModel("kobe-local/nomic-embed-text")).toBe("kobe-local/nomic-embed-text#d2");
    expect(storedVectorModel("mac/qwen3-embedding:0.6b")).toBe("mac/qwen3-embedding:0.6b");
    expect(storedVectorModel("openai/text-embedding-3-small")).toBe(
      "openai/text-embedding-3-small",
    );
  });

  it("picks the stored model only while its provider is on the gateway", () => {
    expect(pickEmbeddingModel(null, new Set(["kobe-local"]))).toEqual({
      ok: false,
      reason: "no_model",
    });
    expect(pickEmbeddingModel("gone/m", new Set(["kobe-local"]))).toEqual({
      ok: false,
      reason: "provider_missing",
    });
    expect(pickEmbeddingModel("kobe-local/m", new Set(["kobe-local"]))).toEqual({
      ok: true,
      model: "kobe-local/m",
    });
  });

  it("treats budget refusals as skips", () => {
    expect(isBudgetSkip(new ServerCallError("budget_exhausted"))).toBe(true);
    expect(isBudgetSkip(new ServerCallError("http_500"))).toBe(false);
  });

  it("merges vector similarities onto keyword rows and appends the rest", () => {
    const row = (lane: ItemRow["lane"], id: string, extra: Partial<ItemRow> = {}): ItemRow => ({
      lane,
      id,
      kind: "fact",
      pinned: false,
      version: 1,
      statement: id,
      actor_kind: "user",
      as_of: null,
      saved_on: "2026-11-15",
      matched: true,
      rank: 0.1,
      age_days: 0,
      sticky: false,
      total: 2,
      ...extra,
    });
    const merged = mergeVectorRows(
      [row("policy", "p"), row("team", "a"), row("team", "b")],
      [
        row("team", "a", { sim: 0.8, total: -1 }),
        row("team", "c", { sim: 0.7, total: -1 }),
        row("site", "s", { sim: 0.9, total: -1 }),
      ],
      ["team"],
      ["c"],
    );
    expect(merged.map((r) => [r.id, r.sim, Number(r.total), r.sticky])).toEqual([
      ["p", undefined, 2, false],
      ["a", 0.8, 2, false],
      ["b", undefined, 2, false],
      ["c", 0.7, -1, true],
    ]);
  });
});
