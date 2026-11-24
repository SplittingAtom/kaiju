import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServerCredentials, type GrantAnswer, type GrantSource } from "./credentials.js";
import { createPolicyServer } from "./server-client.js";

const KEY = "sk-live-0123456789abcdef";
const connector = (auth_kind: "oauth" | "api_key" | "none") => ({
  id: randomUUID(),
  url: "https://mcp.example.com/mcp",
  auth_kind,
});
const request = (auth_kind: "oauth" | "api_key" | "none") => ({
  token: "sandbox-token",
  teamId: randomUUID(),
  userId: randomUUID(),
  connector: connector(auth_kind),
});

function source(answer: GrantAnswer) {
  const asked: { token: string; connectorId: string }[] = [];
  const grants: GrantSource = {
    fetchGrant: (token, connectorId) => {
      asked.push({ token, connectorId });
      return Promise.resolve(answer);
    },
  };
  return { asked, grants };
}

describe("createServerCredentials", () => {
  it("asks for nothing for a connector without credentials", async () => {
    const s = source({ ok: true, value: { kind: "api_key", apiKey: KEY, source: "member" } });
    const out = await createServerCredentials(s.grants).headersFor(request("none"));
    expect(out).toEqual({ ok: true, headers: {}, credential: "none" });
    expect(s.asked).toEqual([]);
  });

  it("attaches the user's API key as a bearer token, fetched with the sandbox's own token", async () => {
    const s = source({ ok: true, value: { kind: "api_key", apiKey: KEY, source: "member" } });
    const req = request("api_key");
    const out = await createServerCredentials(s.grants).headersFor(req);
    expect(out).toEqual({
      ok: true,
      headers: { authorization: `Bearer ${KEY}` },
      credential: "member",
    });
    expect(s.asked).toEqual([{ token: "sandbox-token", connectorId: req.connector.id }]);
  });

  it("says the site key was used when the server served one (KOBE-449)", async () => {
    const s = source({ ok: true, value: { kind: "api_key", apiKey: KEY, source: "site" } });
    const out = await createServerCredentials(s.grants).headersFor(request("api_key"));
    expect(out).toEqual({
      ok: true,
      headers: { authorization: `Bearer ${KEY}` },
      credential: "site",
    });
  });

  it.each(["not_connected", "unavailable"] as const)("passes %s through", async (failure) => {
    const out = await createServerCredentials(source({ ok: false, failure }).grants).headersFor(
      request("api_key"),
    );
    expect(out).toEqual({ ok: false, code: failure });
  });

  it("attaches the user's OAuth access token as a bearer token (KOBE-109)", async () => {
    const s = source({
      ok: true,
      value: { kind: "oauth", accessToken: "at-123", source: "member" },
    });
    const req = request("oauth");
    const out = await createServerCredentials(s.grants).headersFor(req);
    expect(out).toEqual({
      ok: true,
      headers: { authorization: "Bearer at-123" },
      credential: "member",
    });
    expect(s.asked).toEqual([{ token: "sandbox-token", connectorId: req.connector.id }]);
  });

  it("caches nothing: a credential destroyed on the server is refused on the next call (KOBE-454)", async () => {
    let answer: GrantAnswer = { ok: true, value: { kind: "api_key", apiKey: KEY, source: "site" } };
    const resolver = createServerCredentials({ fetchGrant: () => Promise.resolve(answer) });
    const req = request("api_key");
    expect(await resolver.headersFor(req)).toMatchObject({ ok: true });
    answer = { ok: false, failure: "not_connected" };
    expect(await resolver.headersFor(req)).toEqual({ ok: false, code: "not_connected" });
  });

  it.each([
    ["oauth", { kind: "api_key", apiKey: KEY, source: "member" }],
    ["api_key", { kind: "oauth", accessToken: "at-123", source: "member" }],
  ] as const)(
    "refuses a %s connector answered with the other kind of grant",
    async (kind, value) => {
      const out = await createServerCredentials(source({ ok: true, value }).grants).headersFor(
        request(kind),
      );
      expect(out).toEqual({ ok: false, code: "not_connected" });
    },
  );
});

describe("forced refresh after an upstream refusal (KOBE-778)", () => {
  it("passes the refresh request to the grant source for an OAuth connector", async () => {
    const asked: unknown[] = [];
    const grants: GrantSource = {
      fetchGrant: (_t, _c, options) => {
        asked.push(options);
        return Promise.resolve({
          ok: true,
          value: { kind: "oauth", accessToken: "at-new", source: "member" },
        });
      },
    };
    const out = await createServerCredentials(grants).headersFor(request("oauth"), {
      refresh: true,
    });
    expect(out).toEqual({
      ok: true,
      headers: { authorization: "Bearer at-new" },
      credential: "member",
    });
    expect(asked).toEqual([{ refresh: "force" }]);
  });

  it("passes the call's deadline to the grant fetch (review F1)", async () => {
    const seen: unknown[] = [];
    const grants: GrantSource = {
      fetchGrant: (_t, _c, options) => {
        seen.push(options?.signal);
        return Promise.resolve({
          ok: true,
          value: { kind: "oauth", accessToken: "at", source: "member" },
        });
      },
    };
    const signal = AbortSignal.timeout(1_000);
    await createServerCredentials(grants).headersFor(request("oauth"), { signal });
    await createServerCredentials(grants).headersFor(request("oauth"), { refresh: true, signal });
    expect(seen).toEqual([signal, signal]);
  });
});

describe("policy server grant client", () => {
  const seen: { path: string; headers: Headers; body: unknown }[] = [];
  const respond = (status: number, body: unknown): typeof fetch =>
    ((url: string, init: RequestInit) => {
      seen.push({
        path: new URL(url).pathname,
        headers: new Headers(init.headers),
        body: init.body,
      });
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }) as unknown as typeof fetch;
  const client = (f: typeof fetch, errors: unknown[] = []) =>
    createPolicyServer({
      baseUrl: "http://server:8082",
      internalKey: "i".repeat(40),
      timeoutMs: 1000,
      fetch: f,
      onError: (e) => errors.push(e),
    });
  beforeAll(() => {
    seen.length = 0;
  });
  afterAll(() => {
    seen.length = 0;
  });

  it("posts with the internal key and the sandbox token, and parses the key", async () => {
    const out = await client(
      respond(200, { kind: "api_key", api_key: KEY, source: "site" }),
    ).fetchGrant("tok", "c1");
    expect(out).toEqual({ ok: true, value: { kind: "api_key", apiKey: KEY, source: "site" } });
    expect(seen.at(-1)?.path).toBe("/internal/v1/mcp/connectors/c1/grant");
    expect(seen.at(-1)?.headers.get("kaiju-sandbox-token")).toBe("tok");
    expect(seen.at(-1)?.headers.get("authorization")).toBe(`Bearer ${"i".repeat(40)}`);
  });

  it("asks for a forced refresh only when told, and sends no body otherwise (KOBE-778)", async () => {
    const f = respond(200, { kind: "oauth", access_token: "at-2", source: "member" });
    await client(f).fetchGrant("tok", "c1");
    expect(seen.at(-1)?.body ?? null).toBeNull();
    await client(f).fetchGrant("tok", "c1", { refresh: "force" });
    expect(seen.at(-1)?.body).toBe(JSON.stringify({ refresh: "force" }));
    expect(seen.at(-1)?.headers.get("content-type")).toBe("application/json");
  });

  it("gives the grant call its own, longer deadline: a refresh outlasts other server calls (KOBE-778)", async () => {
    const slow = ((_url: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            resolve(
              new Response(JSON.stringify({ kind: "oauth", access_token: "at-3" }), {
                status: 200,
              }),
            ),
          150,
        );
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      })) as unknown as typeof fetch;
    const out = await createPolicyServer({
      baseUrl: "http://server:8082",
      internalKey: "i".repeat(40),
      timeoutMs: 50,
      grantTimeoutMs: 2_000,
      fetch: slow,
    }).fetchGrant("tok", "c1");
    expect(out).toEqual({
      ok: true,
      value: { kind: "oauth", accessToken: "at-3", source: "member" },
    });
  });

  it("stops the grant call when the call's own deadline passes first (review F1)", async () => {
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const started = Date.now();
    const out = await createPolicyServer({
      baseUrl: "http://server:8082",
      internalKey: "i".repeat(40),
      timeoutMs: 5_000,
      grantTimeoutMs: 5_000,
      fetch: hanging,
    }).fetchGrant("tok", "c1", { signal: AbortSignal.timeout(100) });
    expect(out).toEqual({ ok: false, failure: "unavailable" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("parses an OAuth access token", async () => {
    const out = await client(
      respond(200, { kind: "oauth", access_token: "at-1", source: "member" }),
    ).fetchGrant("tok", "c1");
    expect(out).toEqual({
      ok: true,
      value: { kind: "oauth", accessToken: "at-1", source: "member" },
    });
  });

  it("reads a server that does not say the source (older release) as the member's own key", async () => {
    const out = await client(respond(200, { kind: "api_key", api_key: KEY })).fetchGrant("t", "c");
    expect(out).toEqual({ ok: true, value: { kind: "api_key", apiKey: KEY, source: "member" } });
  });

  it("separates not connected from everything else, failing closed", async () => {
    expect(await client(respond(404, { code: "not_connected" })).fetchGrant("t", "c")).toEqual({
      ok: false,
      failure: "not_connected",
    });
    for (const [status, body] of [
      [404, { code: "connector_not_available" }],
      [401, { code: "sandbox_unauthorized" }],
      [503, { code: "unavailable" }],
      [200, { kind: "oauth" }],
      [200, { kind: "oauth", access_token: "" }],
      [200, { kind: "api_key", api_key: "" }],
      [200, { kind: "api_key", api_key: KEY, source: "nobody" }],
    ] as const) {
      expect(await client(respond(status, body)).fetchGrant("t", "c")).toEqual({
        ok: false,
        failure: "unavailable",
      });
    }
    const failing = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
    expect(await client(failing).fetchGrant("t", "c")).toEqual({
      ok: false,
      failure: "unavailable",
    });
  });
});
