import { describe, expect, it } from "vitest";
import { RedirectRefusedError } from "../connectors/oauth/http.js";
import { GitHostError, cappedResetAt, safePermissionName, safeWebUrl } from "./adapter.js";
import { hostRequest, type GitHostNet } from "./http.js";
import { gitHostTarget, type GitHostTarget } from "./target.js";
import { githubError, rateLimitOf } from "./github/errors.js";

/**
 * `hostRequest` redirect handling and the one Site matcher (KOBE-758 review M1, L5). The network
 * is a stub: each call records the URL and headers it was given and answers from a script.
 */
type Step = { readonly redirect: string } | { readonly status: number; readonly body?: unknown };

function stub(steps: readonly Step[]) {
  const seen: { url: string; authorization: string | undefined; method: string }[] = [];
  let i = 0;
  const net: GitHostNet = {
    policy: {
      allowHttp: false,
      allowedPorts: [443, 8443],
      allowedInternalCidrs: [],
      deniedCidrs: [],
      resolve: () => Promise.resolve(["140.82.112.6"]),
    },
    request: (url, _io, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({
        url: url.toString(),
        authorization: headers.authorization,
        method: init?.method ?? "GET",
      });
      const step = steps[i++] ?? { status: 200 };
      if ("redirect" in step) return Promise.reject(new RedirectRefusedError(step.redirect));
      return Promise.resolve({
        status: step.status,
        headers: {},
        text: step.body === undefined ? "" : JSON.stringify(step.body),
      });
    },
  };
  return { net, seen };
}

const API = "https://git.example.com/api/v1";
const target = (settings = { enabled: true, allowedHosts: [] as string[] }): GitHostTarget =>
  gitHostTarget(settings, "https://git.example.com");

async function caught(p: Promise<unknown>): Promise<GitHostError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof GitHostError) return error;
    throw error;
  }
  throw new Error("expected a GitHostError");
}

const get = { method: "GET" as const, headers: { authorization: "token secret-t" } };

describe("hostRequest redirects (review L5)", () => {
  it("follows a same-origin hop under the API path, keeping the credential on that origin", async () => {
    const { net, seen } = stub([{ redirect: `${API}/repositories/7` }, { status: 200, body: {} }]);
    const res = await hostRequest(net, target(), API, `${API}/repos/o/old`, get);
    expect(res.status).toBe(200);
    expect(seen.map((s) => s.url)).toEqual([`${API}/repos/o/old`, `${API}/repositories/7`]);
  });

  it.each([
    ["another origin", "https://evil.example/api/v1/x"],
    ["a scheme downgrade", "http://git.example.com/api/v1/x"],
    ["a port change", "https://git.example.com:8443/api/v1/x"],
    ["outside the API path", "https://git.example.com/user/login"],
    ["userinfo", "https://u:p@git.example.com/api/v1/x"],
  ])("refuses %s, sending nothing (and no credential) there", async (_n, location) => {
    const { net, seen } = stub([{ redirect: location }]);
    const error = await caught(hostRequest(net, target(), API, `${API}/repos/o/r`, get));
    expect(error).toMatchObject({ code: "host_refused", reason: "redirect" });
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(error)).not.toContain(location);
  });

  it.each(["POST", "PATCH"] as const)(
    "never follows a 307/308 on %s (the body would move)",
    async (method) => {
      const { net, seen } = stub([{ redirect: `${API}/repos/o/r2` }]);
      const error = await caught(
        hostRequest(net, target(), API, `${API}/repos/o/r`, { ...get, method, body: { x: 1 } }),
      );
      expect(error.code).toBe("host_refused");
      expect(seen).toHaveLength(1);
    },
  );

  it("stops after three same-origin hops", async () => {
    const { net, seen } = stub(Array.from({ length: 5 }, (_, i) => ({ redirect: `${API}/h${i}` })));
    expect((await caught(hostRequest(net, target(), API, `${API}/h`, get))).code).toBe(
      "host_refused",
    );
    expect(seen).toHaveLength(4);
  });
});

describe("one Site matcher (review M1)", () => {
  it("refuses a target that did not come from the Site's decision", async () => {
    const { net, seen } = stub([]);
    const forged = { baseUrl: "https://git.example.com", host: "git.example.com" } as GitHostTarget;
    const error = await caught(hostRequest(net, forged, API, `${API}/x`, get));
    expect(error).toMatchObject({ code: "host_refused", reason: "no_site_decision" });
    expect(seen).toEqual([]);
  });

  it("refuses a request to a host other than the decided one", async () => {
    const { net, seen } = stub([]);
    const other = "https://other.example.com/api/v1";
    const error = await caught(hostRequest(net, target(), other, `${other}/x`, get));
    expect(error).toMatchObject({ code: "host_refused", reason: "other_host" });
    expect(seen).toEqual([]);
  });

  it("matches the Site limit with patterns and refuses IP literals and a switched-off Site", () => {
    expect(target({ enabled: true, allowedHosts: ["*.example.com"] }).host).toBe("git.example.com");
    expect(() => gitHostTarget({ enabled: true, allowedHosts: [] }, "https://10.0.0.1")).toThrow(
      expect.objectContaining({ code: "invalid_request" }),
    );
    expect(() => target({ enabled: false, allowedHosts: [] })).toThrow(
      expect.objectContaining({ reason: "site_git_off" }),
    );
    expect(() => target({ enabled: true, allowedHosts: ["github.com"] })).toThrow(
      expect.objectContaining({ reason: "site_host_limit" }),
    );
  });

  it("pairs github.com with api.github.com only", async () => {
    const { net, seen } = stub([{ status: 200, body: {} }]);
    const gh = gitHostTarget({ enabled: true, allowedHosts: ["github.com"] }, "https://github.com");
    await hostRequest(net, gh, "https://api.github.com", "https://api.github.com/user", get);
    expect(seen).toHaveLength(1);
    const error = await caught(
      hostRequest(net, gh, "https://uploads.github.com", "https://uploads.github.com/x", get),
    );
    expect(error.reason).toBe("other_host");
  });
});

describe("host-supplied values (review M2, L2, L3)", () => {
  it.each([
    ["https://git.example.com/acme/docs", "https://git.example.com/acme/docs"],
    ["javascript:alert(1)", ""],
    ["https://evil.example/acme/docs", ""],
    ["http://git.example.com/acme/docs", ""],
    ["https://git.example.com:8443/acme/docs", ""],
    ["https://u:p@git.example.com/acme", ""],
    ["/acme/docs", ""],
  ])("keeps web link %s only on the connection's origin", (raw, want) => {
    expect(safeWebUrl(raw, "https://git.example.com")).toBe(want);
  });

  it("keeps a sub-path install's links under its path", () => {
    expect(safeWebUrl("https://h.example/gitea/o/r", "https://h.example/gitea")).not.toBe("");
    expect(safeWebUrl("https://h.example/other/o/r", "https://h.example/gitea")).toBe("");
  });

  it("keeps only permission-shaped names, capped", () => {
    expect(safePermissionName("contents=write")).toBe("contents=write");
    expect(safePermissionName("write:issue")).toBe("write:issue");
    expect(safePermissionName("<script>")).toBeUndefined();
    expect(safePermissionName("a".repeat(121))).toBeUndefined();
    expect(
      new GitHostError("forbidden", "x", { missingPermission: "<b>hi</b>" }).missingPermission,
    ).toBeUndefined();
  });

  it("caps a rate-limit reset at a day", () => {
    const now = 1_000_000;
    expect(cappedResetAt(now + 10 * 86_400_000, now).getTime()).toBe(now + 86_400_000);
    expect(cappedResetAt(now - 5, now).getTime()).toBe(now);
    const far = {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-reset": "9999999999",
      },
      json: { message: "API rate limit exceeded" },
    };
    expect(githubError(far, now).resetAt?.getTime()).toBe(now + 86_400_000);
    expect(rateLimitOf(far, now)?.resetAt.getTime()).toBe(now + 86_400_000);
    const header = {
      status: 403,
      headers: { "x-accepted-github-permissions": "x".repeat(500) },
      json: {},
    };
    expect(githubError(header, now).missingPermission).toBeUndefined();
  });
});
