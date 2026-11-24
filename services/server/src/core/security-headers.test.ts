import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { hstsValue, securityHeaders } from "../security-headers.js";

/** KOBE-695: HSTS on https installs, and nosniff + X-Frame-Options DENY unless a route frames. */
function app(publicUrl: string | undefined, includeSubDomains = false): Hono {
  const a = new Hono();
  a.use("*", securityHeaders({ publicUrl, includeSubDomains }));
  a.get("/v1/json", (c) => c.json({ ok: true }));
  a.get(
    "/v1/frame",
    () =>
      new Response("<p>x</p>", {
        headers: { "x-frame-options": "SAMEORIGIN", "content-type": "text/html" },
      }),
  );
  // A response whose headers can't change (as `Response.redirect` and `fetch` return).
  a.get("/v1/frozen", () => Response.redirect("https://kaiju.example/elsewhere", 302));
  return a;
}

describe("hstsValue", () => {
  it("is set for an https public URL only", () => {
    expect(hstsValue("https://kaiju.example", false)).toBe("max-age=31536000");
    expect(hstsValue("https://kaiju.example", true)).toBe("max-age=31536000; includeSubDomains");
    expect(hstsValue("http://kaiju.example", true)).toBeUndefined();
    expect(hstsValue(undefined, false)).toBeUndefined();
  });
});

describe("securityHeaders", () => {
  it("adds HSTS, nosniff and X-Frame-Options DENY on an https install", async () => {
    const res = await app("https://kaiju.example").request("/v1/json");
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    // Unknown routes too.
    const missing = await app("https://kaiju.example").request("/nope");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-frame-options")).toBe("DENY");
  });

  it("sends no HSTS on a plain-http install, but keeps nosniff and DENY", async () => {
    const res = await app("http://kaiju.example").request("/v1/json");
    expect(res.headers.get("strict-transport-security")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("adds includeSubDomains only when configured", async () => {
    const res = await app("https://kaiju.example", true).request("/v1/json");
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });

  it("leaves a frame route's own framing policy in place", async () => {
    const res = await app("https://kaiju.example").request("/v1/frame");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it("copies a response whose headers are immutable", async () => {
    const res = await app("https://kaiju.example").request("/v1/frozen");
    expect(res.status).toBe(302);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});
