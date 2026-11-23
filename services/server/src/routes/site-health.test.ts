import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AuthVariables, SiteRole } from "../auth/session.js";
import type { IngressRateLimitSource } from "../config.js";
import { siteHealthRoutes } from "./site-health.js";

// KOBE-811: the Site console's health view says when no rate limit is configured at the ingress.

function mount(ingressRateLimit: IngressRateLimitSource, siteRole: SiteRole) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use(async (c, next) => {
    c.set("siteRole", siteRole);
    await next();
  });
  app.route("/v1/site/health", siteHealthRoutes({ ingressRateLimit }));
  return app;
}

async function check(source: IngressRateLimitSource) {
  const res = await mount(source, "admin").request("/v1/site/health");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { checks: { id: string }[] };
  return body.checks.find((c) => c.id === "ingress_rate_limit");
}

const DOCS = "docs/install.md#rate-limit-at-the-ingress-optional";

describe("GET /v1/site/health", () => {
  it("is for site admins only", async () => {
    expect((await mount("none", null).request("/v1/site/health")).status).toBe(403);
  });

  it("is ok when the chart or the operator's own edge limits requests", async () => {
    expect(await check("chart")).toEqual({
      id: "ingress_rate_limit",
      level: "ok",
      state: "configured",
      source: "chart",
    });
    expect(await check("external")).toEqual({
      id: "ingress_rate_limit",
      level: "ok",
      state: "configured",
      source: "external",
    });
  });

  it("is an informational notice when the chart's ingress has no limit", async () => {
    expect(await check("none")).toEqual({
      id: "ingress_rate_limit",
      level: "info",
      state: "none",
      docs: DOCS,
    });
  });

  it("is an informational notice when Kobe cannot tell (ingress not managed by the chart)", async () => {
    expect(await check("unknown")).toEqual({
      id: "ingress_rate_limit",
      level: "info",
      state: "unknown",
      docs: DOCS,
    });
  });
});
