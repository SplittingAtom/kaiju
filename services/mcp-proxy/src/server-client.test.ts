import { describe, expect, it } from "vitest";
import { builtinPath, createPolicyServer } from "./server-client.js";

describe("the built-in connectors' internal paths (KOBE-826)", () => {
  it("keeps calling the Kaiju connector's pre-rename path for one release", async () => {
    const urls: string[] = [];
    const server = createPolicyServer({
      baseUrl: "http://server:8082",
      internalKey: "k".repeat(40),
      timeoutMs: 1_000,
      fetch: (async (url: unknown) => {
        urls.push(String(url));
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
    });
    await server.kaijuList("tok");
    await server.kaijuCall("tok", { tool: "docs_index", arguments: {} }, "kaiju");
    await server.kaijuList("tok", "git");
    // Servers of the release before the rename serve only `kobe`; this release's serve both.
    expect(urls.map((u) => new URL(u).pathname)).toEqual([
      "/internal/v1/mcp/kobe/list",
      "/internal/v1/mcp/kobe/calls",
      "/internal/v1/mcp/git/list",
    ]);
    expect(builtinPath("kaiju")).toBe("kobe");
    expect(builtinPath("git")).toBe("git");
  });
});
