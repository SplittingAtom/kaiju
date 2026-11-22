import { Hono } from "hono";
import type { AuthVariables } from "../auth/session.js";
import { requireSitePermission } from "../authz/middleware.js";
import type { IngressRateLimitSource } from "../config.js";

const INGRESS_RATE_LIMIT_DOCS = "docs/install.md#rate-limit-at-the-ingress-optional";

export interface SiteHealthOptions {
  /** Who limits requests at the ingress (chart `ingress.rateLimit`, KOBE-811). */
  readonly ingressRateLimit: IngressRateLimitSource;
}

/**
 * One check of the Site console's health view. `ok` needs nothing; `info` is a notice with a
 * pointer to the install guide, never an error (KOBE-811: the ingress limit is off by default).
 */
type HealthCheck =
  | {
      readonly id: "ingress_rate_limit";
      readonly level: "ok";
      readonly state: "configured";
      readonly source: "chart" | "external";
    }
  | {
      readonly id: "ingress_rate_limit";
      readonly level: "info";
      readonly state: "none" | "unknown";
      readonly docs: string;
    };

function ingressRateLimitCheck(source: IngressRateLimitSource): HealthCheck {
  if (source === "chart" || source === "external") {
    return { id: "ingress_rate_limit", level: "ok", state: "configured", source };
  }
  return { id: "ingress_rate_limit", level: "info", state: source, docs: INGRESS_RATE_LIMIT_DOCS };
}

/**
 * Site health (KOBE-811): install checks for the Site console overview. Site Owner/Admin only, as
 * the answers describe how the install is deployed.
 */
export function siteHealthRoutes(options: SiteHealthOptions): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use(requireSitePermission("site.settings.manage"));
  app.get("/", (c) => c.json({ checks: [ingressRateLimitCheck(options.ingressRateLimit)] }));
  return app;
}
