import { describe, expect, it } from "vitest";
import { checkRegisteredUrl, createRegisteredUrlLookup } from "./registered-url.js";

const ID = "11111111-1111-4111-8111-111111111111";
const KEY = "k".repeat(40);

describe("checkRegisteredUrl (KOBE-693)", () => {
  const lookup = (url: string | undefined) => () => Promise.resolve(url);

  it("accepts only the connector's registered URL", async () => {
    const at = "https://mcp.example.com/mcp";
    expect(await checkRegisteredUrl(lookup(at), ID, at)).toBe("registered");
    // The same URL written another way is the same URL.
    expect(await checkRegisteredUrl(lookup(at), ID, "HTTPS://MCP.example.com:443/mcp")).toBe(
      "registered",
    );
    expect(await checkRegisteredUrl(lookup(at), ID, "https://elsewhere.example/mcp")).toBe(
      "not_registered",
    );
    expect(await checkRegisteredUrl(lookup(at), ID, "not a url")).toBe("not_registered");
    expect(await checkRegisteredUrl(lookup(undefined), ID, at)).toBe("not_registered");
  });

  it("is unavailable when the registry cannot be asked", async () => {
    const down = () => Promise.reject(new Error("down"));
    expect(await checkRegisteredUrl(down, ID, "https://mcp.example.com/mcp")).toBe("unavailable");
  });
});

describe("createRegisteredUrlLookup", () => {
  it("asks the server's internal listener with the proxy's key", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return String(input).endsWith(`/${ID}/endpoint`)
        ? Response.json({ url: "https://mcp.example.com/mcp" })
        : new Response("{}", { status: 404 });
    }) as typeof fetch;
    const lookup = createRegisteredUrlLookup({
      baseUrl: "http://kobe-server:8082",
      internalKey: KEY,
      timeoutMs: 1000,
      fetch: fetchFn,
    });
    expect(await lookup(ID)).toBe("https://mcp.example.com/mcp");
    expect(seen[0]).toEqual({
      url: `http://kobe-server:8082/internal/v1/mcp/connectors/${ID}/endpoint`,
      auth: `Bearer ${KEY}`,
    });
    expect(await lookup("22222222-2222-4222-8222-222222222222")).toBeUndefined();
  });

  it("rejects on any other answer", async () => {
    const lookup = createRegisteredUrlLookup({
      baseUrl: "http://kobe-server:8082",
      internalKey: KEY,
      timeoutMs: 1000,
      fetch: (async () => new Response("no", { status: 401 })) as typeof fetch,
    });
    await expect(lookup(ID)).rejects.toThrow();
  });
});
