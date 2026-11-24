import { describe, expect, it } from "vitest";
import {
  ALLOW_TTL_MS,
  DENY_TTL_MS,
  GitDecisionCache,
  serverDecider,
  type GitDecision,
  type GitDecisionQuery,
} from "./decisions.js";

const query = (repository = "app"): GitDecisionQuery => ({
  teamId: "t",
  userId: "u",
  sandboxId: "s",
  token: "sandbox-token",
  host: "git.example.test",
  request: {
    prefix: "",
    owner: "acme",
    repository,
    service: "git-upload-pack",
    endpoint: "refs",
  },
});

const allow = (expiresAt: string | null = null): GitDecision => ({
  decision: "allow",
  connection_id: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  base_path: "",
  organization: "acme",
  repository: "app",
  access: "read",
  username: "x-access-token",
  password: "ghs_FAKEfakeFAKEfake0123456789",
  expires_at: expiresAt,
  narrowed: true,
  push_limit_bytes: 1024,
});

describe("git decision cache (KOBE-763)", () => {
  it("reuses an allow briefly, a deny shorter, never past the credential's expiry margin", async () => {
    let now = 1_000_000;
    let calls = 0;
    let next: GitDecision = allow();
    const cache = new GitDecisionCache(
      async () => {
        calls += 1;
        return next;
      },
      { maxEntries: 10, now: () => now },
    );
    await cache.get(query());
    await cache.get(query());
    expect(calls).toBe(1);
    now += ALLOW_TTL_MS;
    await cache.get(query());
    expect(calls).toBe(2);

    next = { decision: "deny", code: "read_only", message: "no" };
    await cache.get(query("other"));
    now += DENY_TTL_MS - 1;
    await cache.get(query("other"));
    expect(calls).toBe(3);
    now += 1;
    await cache.get(query("other"));
    expect(calls).toBe(4);

    // A token expiring within the margin is not cached at all.
    next = allow(new Date(now + 30_000).toISOString());
    await cache.get(query("soon"));
    await cache.get(query("soon"));
    expect(calls).toBe(6);
  });

  it("never caches errors, forgets on demand and stays bounded", async () => {
    let calls = 0;
    let next: GitDecision = { decision: "error", status: 503 };
    const cache = new GitDecisionCache(
      async () => {
        calls += 1;
        return next;
      },
      { maxEntries: 2 },
    );
    await cache.get(query());
    await cache.get(query());
    expect(calls).toBe(2);
    next = allow();
    await cache.get(query("a"));
    cache.forget(query("a"));
    await cache.get(query("a"));
    expect(calls).toBe(4);
    await cache.get(query("b"));
    await cache.get(query("c"));
    expect(cache.size).toBe(2);
  });

  it("keys on the member and sandbox as well as the repository", () => {
    const a = GitDecisionCache.keyOf(query());
    const b = GitDecisionCache.keyOf({ ...query(), userId: "other" });
    const c = GitDecisionCache.keyOf({ ...query(), sandboxId: "other" });
    const d = GitDecisionCache.keyOf({
      ...query(),
      request: { ...query().request, owner: "ACME", repository: "APP" },
    });
    expect(new Set([a, b, c]).size).toBe(3);
    expect(d).toBe(a);
  });
});

describe("server decider (KOBE-763)", () => {
  it("sends the internal key and the sandbox's own token, parses the answer", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const decide = serverDecider({
      serverUrl: "http://server.internal:8082/",
      internalKey: "k".repeat(40),
      timeoutMs: 1_000,
      fetch: async (url, init) => {
        sent.push({ url: String(url), init: init ?? {} });
        return Response.json(allow());
      },
    });
    const got = await decide(query());
    expect(got).toMatchObject({ decision: "allow", organization: "acme" });
    expect(sent[0]?.url).toBe("http://server.internal:8082/internal/v1/git/transport");
    const headers = sent[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${"k".repeat(40)}`);
    expect(headers["kaiju-sandbox-token"]).toBe("sandbox-token");
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({
      host: "git.example.test",
      prefix: "",
      owner: "acme",
      repository: "app",
      service: "git-upload-pack",
    });
  });

  it("fails closed on anything unexpected", async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => new Response("", { status: 401 }),
      () => new Response("", { status: 429 }),
      () => new Response("", { status: 500 }),
      () => Response.json({ decision: "allow" }),
      () => Response.json({ ...allow(), base_path: "/../x" }),
      () => Response.json({ ...allow(), organization: "../acme" }),
      () => new Response("not json"),
      () => Promise.reject(new Error("down")),
    ];
    const statuses: unknown[] = [];
    for (const answer of answers) {
      const decide = serverDecider({
        serverUrl: "http://s",
        internalKey: "k".repeat(40),
        timeoutMs: 1_000,
        fetch: async () => answer(),
      });
      const got = await decide(query());
      expect(got.decision).toBe("error");
      statuses.push(got.decision === "error" ? got.status : undefined);
    }
    expect(statuses).toEqual([401, 429, 503, 503, 503, 503, 503, 503]);
  });
});
