import { describe, expect, it } from "vitest";
import type { KobeDb } from "@kobe/db";
import { BackgroundTasks } from "../../background.js";
import type { EmbeddingClient } from "../../models/embedding-client.js";
import { ServerCallError } from "../../models/gateway-client.js";
import { documentText, queryText } from "./prefixes.js";
import { MemoryEmbeddings, isBudgetSkip } from "./service.js";
import { pickEmbeddingModel } from "./model.js";
import { mergeVectorRows } from "../items/vector-leg.js";
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
  it("returns the vector made in time, with the query prefix and the run named", async () => {
    let seen: Parameters<EmbeddingClient["embed"]>[0] | undefined;
    const s = service(async (i) => {
      seen = i;
      return [[0.1, 0.2]];
    });
    expect(await s.queryVector(input)).toEqual({
      model: "kobe-local/nomic-embed-text",
      vector: [0.1, 0.2],
    });
    expect(seen?.inputs).toEqual(["search_query: where do I park?"]);
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

describe("embedding helpers (KOBE-409)", () => {
  it("prefixes per model family", () => {
    expect(documentText("kobe-local/nomic-embed-text", "x")).toBe("search_document: x");
    expect(queryText("mac/nomic-embed-text:latest", "x")).toBe("search_query: x");
    expect(queryText("mac/qwen3-embedding:0.6b", "x")).toMatch(/^Instruct: .*\nQuery: x$/s);
    expect(documentText("mac/qwen3-embedding:0.6b", "x")).toBe("x");
    expect(queryText("openai/text-embedding-3-small", "x")).toBe("x");
    expect(queryText("m/nomic-embed-text", "y".repeat(5000))).toHaveLength(4000);
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
