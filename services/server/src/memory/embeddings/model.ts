import { gatewayProviderName, modelProviders, type KobeDb, type KobeTx } from "@kobe/db";
import { catalogModelIds, type ModelDiscovery } from "../../models/discovery.js";
import { gatewayProviderOf, readMemorySiteSettings } from "../site-settings.js";

/**
 * The Site embedding model (KOBE-409) in the judge pattern's "fails clearly" form: the model the
 * Site admin named, or none, with the reason. Nothing ever falls back to another model (no chat
 * model, no other provider's model): without a usable model memory search stays keyword-only and
 * the Site console says why.
 */
export type EmbeddingModel =
  | { readonly ok: true; readonly model: string }
  | { readonly ok: false; readonly reason: "no_model" | "provider_missing" };

/**
 * The gateway provider names now: every Site provider (`gatewayProviderName`) plus the chart's
 * in-cluster embedding provider when it runs one (`localModel`, e.g. `kobe-local/nomic-embed-text`).
 */
export async function gatewayProviderNames(
  db: KobeDb | KobeTx,
  localModel: string | undefined,
): Promise<Set<string>> {
  const rows = await db
    .select({ id: modelProviders.id, kind: modelProviders.kind })
    .from(modelProviders);
  const names = new Set(rows.map((r) => gatewayProviderName(r.id, r.kind)));
  if (localModel !== undefined) names.add(gatewayProviderOf(localModel));
  return names;
}

/** Pure choice (tested): the stored model when its provider is still on the gateway. */
export function pickEmbeddingModel(
  stored: string | null,
  providers: ReadonlySet<string>,
): EmbeddingModel {
  if (stored === null) return { ok: false, reason: "no_model" };
  if (!providers.has(gatewayProviderOf(stored))) return { ok: false, reason: "provider_missing" };
  return { ok: true, model: stored };
}

export async function embeddingModelFor(
  db: KobeDb | KobeTx,
  localModel: string | undefined,
): Promise<EmbeddingModel> {
  const settings = await readMemorySiteSettings(db);
  return pickEmbeddingModel(settings.embedding_model, await gatewayProviderNames(db, localModel));
}

/**
 * Whether the gateway's model list for the model's provider has it (review L3; Bifrost's cache, no
 * provider call): `listed`, `not_listed`, or `unknown` when the provider lists nothing (a keyless
 * provider without discovery, e.g. Ollama or the in-cluster model), the list was cut short, or the
 * gateway could not be asked. Only `not_listed` refuses the setting.
 */
export async function embeddingModelListed(
  discovery: Pick<ModelDiscovery, "listModelInfo"> | undefined,
  model: string,
): Promise<"listed" | "not_listed" | "unknown"> {
  if (discovery === undefined) return "unknown";
  const provider = gatewayProviderOf(model);
  let names: string[];
  try {
    names = (await discovery.listModelInfo(provider)).map((m) => m.name);
  } catch {
    return "unknown";
  }
  const { models, truncated } = catalogModelIds(names, provider);
  if (models.length === 0) return "unknown";
  if (models.includes(model.slice(provider.length + 1))) return "listed";
  return truncated ? "unknown" : "not_listed";
}
