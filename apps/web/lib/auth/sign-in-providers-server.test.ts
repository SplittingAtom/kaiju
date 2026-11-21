import { describe, expect, it, vi } from "vitest";
import {
  createProvidersLoader,
  PROVIDERS_CACHE_MS,
  PROVIDERS_FAILURE_CACHE_MS,
} from "./sign-in-providers-server";

/** KOBE-755: the sign-in page's providers, read in the server render. */
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("createProvidersLoader", () => {
  it("reads the server's public providers route, keeping well-formed entries in order", async () => {
    const fetch = vi.fn(async () =>
      json({
        providers: [
          { slug: "kc", displayName: "Keycloak" },
          { slug: 1 },
          { slug: "corp", displayName: "Contoso" },
        ],
      }),
    );
    const load = createProvidersLoader({ serverUrl: "http://server", fetch });
    expect(await load()).toEqual([
      { slug: "kc", displayName: "Keycloak" },
      { slug: "corp", displayName: "Contoso" },
    ]);
    expect(fetch).toHaveBeenCalledWith("http://server/api/auth/sso/providers", expect.anything());
  });

  it("none while single sign-on is off (404)", async () => {
    const load = createProvidersLoader({
      serverUrl: "http://server",
      fetch: vi.fn(async () => json({}, 404)),
    });
    expect(await load()).toEqual([]);
  });

  it("null (the browser asks) on any other failure or without a server URL", async () => {
    expect(await createProvidersLoader({ serverUrl: null })()).toBeNull();
    const failing = createProvidersLoader({
      serverUrl: "http://server",
      fetch: vi.fn(async () => json({}, 429)),
    });
    expect(await failing()).toBeNull();
    const throwing = createProvidersLoader({
      serverUrl: "http://server",
      fetch: vi.fn(async () => {
        throw new Error("down");
      }),
    });
    expect(await throwing()).toBeNull();
  });

  it("keeps the list for a while, then reads it again", async () => {
    let now = 0;
    const fetch = vi.fn(async () => json({ providers: [] }));
    const load = createProvidersLoader({ serverUrl: "http://server", fetch, now: () => now });
    await load();
    now = PROVIDERS_CACHE_MS - 1;
    await load();
    expect(fetch).toHaveBeenCalledTimes(1);
    now = PROVIDERS_CACHE_MS;
    await load();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps a failure for about 2 s, so a down server never slows every sign-in render", async () => {
    let now = 0;
    const fetch = vi.fn(async () => json({}, 503));
    const load = createProvidersLoader({ serverUrl: "http://server", fetch, now: () => now });
    expect(await load()).toBeNull();
    now = PROVIDERS_FAILURE_CACHE_MS - 1;
    expect(await load()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    now = PROVIDERS_FAILURE_CACHE_MS;
    await load();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(PROVIDERS_FAILURE_CACHE_MS).toBe(2000);
  });
});
