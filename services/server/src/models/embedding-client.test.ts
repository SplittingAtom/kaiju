import { describe, expect, it } from "vitest";
import { SERVER_CALL_TOKEN_HEADER } from "@kaiju/protocol";
import { generateSessionKeyPair, verifyServerCallToken } from "@kaiju/session-token";
import { createEmbeddingClient, vectorsOf } from "./embedding-client.js";
import { ServerCallError } from "./gateway-client.js";

const PAIR = generateSessionKeyPair();
const TEAM = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const THREAD = "44444444-4444-4444-8444-444444444444";
const MODEL = "kobe-local/nomic-embed-text";

interface Seen {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function fakeFetch(status: number, reply: unknown, seen: Seen[]): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    seen.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as unknown,
    });
    return new Response(JSON.stringify(reply), { status });
  }) as typeof fetch;
}

const ok = (vectors: number[][]) => ({
  data: vectors.map((embedding, index) => ({ index, embedding })).reverse(),
});

describe("embedding client (KOBE-409)", () => {
  it("posts the inputs to /v1/embeddings with a memory_embed token bound to the run", async () => {
    const seen: Seen[] = [];
    const client = createEmbeddingClient({
      url: "http://gateway:8080",
      key: PAIR.signing,
      fetch: fakeFetch(
        200,
        ok([
          [1, 0],
          [0, 1],
        ]),
        seen,
      ),
    });
    const out = await client.embed({
      teamId: TEAM,
      userId: USER,
      run: { runId: RUN, threadId: THREAD },
      model: MODEL,
      inputs: ["a", "b"],
      signal: AbortSignal.timeout(1000),
    });
    expect(out).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(seen[0]?.url).toBe("http://gateway:8080/v1/embeddings");
    expect(seen[0]?.body).toEqual({ model: MODEL, input: ["a", "b"], encoding_format: "float" });
    const claims = verifyServerCallToken(
      PAIR.verify,
      seen[0]?.headers[SERVER_CALL_TOKEN_HEADER],
      Math.floor(Date.now() / 1000),
    );
    expect(claims).toMatchObject({ ok: true });
    expect(claims.ok && claims.claims).toMatchObject({
      purpose: "memory_embed",
      team_id: TEAM,
      user_id: USER,
      run_id: RUN,
      thread_id: THREAD,
      model: MODEL,
    });
    expect(Object.keys(seen[0]?.headers ?? {}).sort()).toEqual(
      ["content-type", SERVER_CALL_TOKEN_HEADER].sort(),
    );
  });

  it("names no run for a save or a backfill", async () => {
    const seen: Seen[] = [];
    const client = createEmbeddingClient({
      url: "http://gateway:8080",
      key: PAIR.signing,
      fetch: fakeFetch(200, ok([[0.5]]), seen),
    });
    await client.embed({
      teamId: TEAM,
      userId: USER,
      model: MODEL,
      inputs: ["a"],
      signal: AbortSignal.timeout(1000),
    });
    const claims = verifyServerCallToken(
      PAIR.verify,
      seen[0]?.headers[SERVER_CALL_TOKEN_HEADER],
      Math.floor(Date.now() / 1000),
    );
    expect(claims.ok && claims.claims.run_id).toBeUndefined();
    expect(claims.ok && claims.claims.thread_id).toBeUndefined();
  });

  it("throws the gateway's code on a refusal, bad_reply on an unusable answer", async () => {
    const refused = createEmbeddingClient({
      url: "http://gateway:8080",
      key: PAIR.signing,
      fetch: fakeFetch(429, { error: { code: "budget_exceeded" } }, []),
    });
    const input = {
      teamId: TEAM,
      userId: USER,
      model: MODEL,
      inputs: ["a"],
      signal: AbortSignal.timeout(1000),
    };
    await expect(refused.embed(input)).rejects.toMatchObject({ code: "budget_exceeded" });
    const bad = createEmbeddingClient({
      url: "http://gateway:8080",
      key: PAIR.signing,
      fetch: fakeFetch(200, ok([[1], [2]]), []),
    });
    await expect(bad.embed(input)).rejects.toBeInstanceOf(ServerCallError);
    await expect(bad.embed({ ...input, inputs: [] })).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("vectorsOf orders by index and refuses gaps, duplicates and mixed dimensions", () => {
    expect(vectorsOf(ok([[1], [2]]), 2)).toEqual([[1], [2]]);
    expect(
      vectorsOf(
        {
          data: [
            { index: 0, embedding: [1] },
            { index: 0, embedding: [2] },
          ],
        },
        2,
      ),
    ).toBe("bad_reply");
    expect(vectorsOf(ok([[1], [2, 3]]), 2)).toBe("bad_reply");
    expect(vectorsOf({ nope: 1 }, 1)).toBe("bad_reply");
  });
});
