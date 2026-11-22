import { egressAccessOpenApiSchemas } from "../../egress-access.js";
import type { NamedSchema } from "../build.js";
import { int, num, str } from "../json.js";

/**
 * Pieces shared by the Team area's details (KOBE-771): `team.ts` and `team-admin.ts` both read
 * these, so the area's two halves name the same components the same way.
 */

type JsonSchema = Record<string, unknown>;

/** Usage totals as `models/usage-store.ts` sums them (`UsageTotals`). */
export const usageTotals: Readonly<Record<string, JsonSchema>> = {
  calls: int,
  input_tokens: int,
  output_tokens: int,
  cache_read_tokens: int,
  cache_write_tokens: int,
  cost_usd: num,
  cost_usd_exact: str,
  unpriced_calls: int,
  estimated_calls: int,
  reasoning_tokens: int,
};

/** A component the hand-written egress-access area already publishes (the very same schema). */
function egressComponent(name: "EgressRequestList" | "EgressRequestDecision"): NamedSchema {
  const json = egressAccessOpenApiSchemas()[name];
  if (!json) throw new Error(`egress-access has no ${name} schema`);
  return { name, json };
}

export const EgressRequestList = egressComponent("EgressRequestList");
export const EgressRequestDecision = egressComponent("EgressRequestDecision");
