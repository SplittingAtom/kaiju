import {
  LOCAL_GATEWAY_PROVIDER,
  LOCAL_PROVIDER_ID,
  PRE_RENAME_LOCAL_GATEWAY_PROVIDER,
} from "@kaiju/protocol";
import { sql, type SQL } from "drizzle-orm";
import type { ModelProviderKind } from "../schema/index.js";

/**
 * Bifrost's name for a provider: vendor kinds use Bifrost's own provider (the kind), every
 * OpenAI-compatible endpoint is a custom provider `kobe-<id>` (never colliding with a Bifrost
 * vendor name), except the in-cluster provider `local`, which is `kaiju-local` since the rename
 * (KOBE-828). Sandboxes name a model to the gateway as `<bifrost provider>/<model>`.
 */
export function gatewayProviderName(id: string, kind: ModelProviderKind): string {
  if (kind !== "openai_compatible") return kind;
  return id === LOCAL_PROVIDER_ID ? LOCAL_GATEWAY_PROVIDER : `kobe-${id}`;
}

// The SQL forms below hold only constants of @kaiju/protocol (fixed words, no input).
const LOCAL_ID = `'${LOCAL_PROVIDER_ID}'`;
const LOCAL_NAME = `'${LOCAL_GATEWAY_PROVIDER}'`;
const OLD_PREFIX = `'${PRE_RENAME_LOCAL_GATEWAY_PROVIDER}/'`;
const NEW_PREFIX = `'${LOCAL_GATEWAY_PROVIDER}/'`;

/**
 * The gateway model id of a catalog entry, as SQL over `model_providers p` and `model_catalog c`
 * ({@link gatewayProviderName} + `/` + model): the same mapping the shim enforces.
 */
export const GATEWAY_MODEL_SQL: SQL = sql.raw(
  `(CASE WHEN p.kind = 'openai_compatible' THEN (CASE WHEN p.id = ${LOCAL_ID} THEN ${LOCAL_NAME} ` +
    `ELSE 'kobe-' || p.id END) ELSE p.kind::text END) || '/' || c.model`,
);

/**
 * A stored gateway model id (column or expression `column`, trusted SQL) as it is named now
 * (`currentModelId` of @kaiju/protocol): history written before the rename names the in-cluster
 * models `kobe-local/<model>`; reports group it with `kaiju-local/<model>` (KOBE-828 ac-2).
 */
export function currentModelSql(column: string): SQL {
  return sql.raw(
    `(CASE WHEN starts_with(${column}, ${OLD_PREFIX}) ` +
      `THEN ${NEW_PREFIX} || substr(${column}, ${PRE_RENAME_LOCAL_GATEWAY_PROVIDER.length + 2}) ` +
      `ELSE ${column} END)`,
  );
}
