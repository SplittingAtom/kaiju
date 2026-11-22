/** Site console: install checks (`GET /v1/site/health`, site.settings.manage; KOBE-811). */
import { apiRequest, type ApiResult } from "../../../api/client";

export type SiteHealthCheck =
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

export interface SiteHealth {
  readonly checks: readonly SiteHealthCheck[];
}

export function getSiteHealth(): Promise<ApiResult<SiteHealth>> {
  return apiRequest("/v1/site/health");
}
