import { z } from "zod";
import {
  MODEL_ALIAS_PATTERN,
  eq,
  gatewayProviderName,
  modelCatalog,
  modelProviders,
  siteSettings,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import {
  SEMANTIC_MEMORY_PLACEMENT_DEFAULT,
  semanticMemoryPlacementSchema,
  gatewayModelSchema,
  SEMANTIC_MEMORY_BLOCK_DEFAULT_BYTES,
  SEMANTIC_MEMORY_BLOCK_MAX_BYTES,
  SEMANTIC_MEMORY_BLOCK_MIN_BYTES,
  SEMANTIC_MEMORY_SCOPE_MAX_ITEMS,
} from "@kobe/protocol";
import { logger } from "../logger.js";

/**
 * Site memory settings (KOBE-381, SM27, SM14): one `site_settings` key holding a JSON document
 * (no migration). Every field has a default; a field missing from the stored document, or one that
 * no longer parses, reads as its default (logged), so an upgrade changes nothing. There is no
 * full-text search language setting: search uses fixed English stemming (Q11).
 *
 * The values are read by the tickets that enforce them: the context budget by the selector
 * (KOBE-382; the `run.start` contract allows the whole range), scope limits and the version cap by
 * the item store (KOBE-378), the stale threshold and retention window by the sweeps (KOBE-386),
 * rate limits and the learning model by Learn (KOBE-393). The embedding model (KOBE-409) is a
 * gateway model id (`<gateway provider>/<model>`), not a catalog alias: embedding models stay out
 * of the catalog, so they never appear in a chat model picker; its provider must be one the
 * gateway has (a Site provider, or `kobe-local` when the chart runs the in-cluster model).
 */
export const MEMORY_SITE_SETTINGS_KEY = "memory.settings";

/** The contract's rendered-block range, in KiB (4 to 16, default 8). */
export const MEMORY_CONTEXT_BUDGET_KIB_MIN = SEMANTIC_MEMORY_BLOCK_MIN_BYTES / 1024;
export const MEMORY_CONTEXT_BUDGET_KIB_MAX = SEMANTIC_MEMORY_BLOCK_MAX_BYTES / 1024;
const MEMORY_CONTEXT_BUDGET_KIB_DEFAULT = SEMANTIC_MEMORY_BLOCK_DEFAULT_BYTES / 1024;

export const MEMORY_STABLE_REPICK_MIN = 2;
export const MEMORY_STABLE_REPICK_MAX = 200;
const MEMORY_STABLE_REPICK_DEFAULT = 20;

const alias = z.string().max(64).regex(new RegExp(MODEL_ALIAS_PATTERN));
const scopeLimit = z.number().int().min(1).max(SEMANTIC_MEMORY_SCOPE_MAX_ITEMS);

export const memorySiteSettingsFields = {
  learning_model_alias: alias.nullable(),
  embedding_model: gatewayModelSchema.nullable(),
  context_budget_kib: z
    .number()
    .int()
    .min(MEMORY_CONTEXT_BUDGET_KIB_MIN)
    .max(MEMORY_CONTEXT_BUDGET_KIB_MAX),
  scope_limits: z.strictObject({
    user: scopeLimit,
    portable: scopeLimit,
    team: scopeLimit,
    site: scopeLimit,
  }),
  version_cap: z.number().int().min(5).max(500),
  stale_after_days: z.number().int().min(7).max(3650),
  rate_limits: z.strictObject({
    learn_passes_per_hour: z.number().int().min(1).max(100),
    saves_per_minute: z.number().int().min(1).max(600),
  }),
  retention_days: z.number().int().min(30).max(3650),
  /**
   * Where the per-message picks reach the model (KOBE-658; protocol `SEMANTIC_MEMORY_PLACEMENTS`):
   * read by the selector's caller (memory/items/placement.ts) and sent with `run.start`.
   */
  placement: semanticMemoryPlacementSchema,
  /** `stable_plus_delta`: the held picks are re-picked every this many messages of a thread. */
  stable_repick_every: z.number().int().min(MEMORY_STABLE_REPICK_MIN).max(MEMORY_STABLE_REPICK_MAX),
} as const;

export const memorySiteSettingsSchema = z.strictObject(memorySiteSettingsFields);
export type MemorySiteSettings = z.infer<typeof memorySiteSettingsSchema>;
export type MemorySiteSettingName = keyof MemorySiteSettings;
export const MEMORY_SITE_SETTING_NAMES = Object.keys(
  memorySiteSettingsFields,
) as MemorySiteSettingName[];

export const MEMORY_SITE_SETTINGS_DEFAULTS: MemorySiteSettings = Object.freeze({
  learning_model_alias: null,
  embedding_model: null,
  context_budget_kib: MEMORY_CONTEXT_BUDGET_KIB_DEFAULT,
  // SM21 defaults (KOBE-378 brief): 300 per person per Workspace, 50 portable per person,
  // 1,000 per Workspace and per Site.
  scope_limits: Object.freeze({
    user: 300,
    portable: 50,
    team: SEMANTIC_MEMORY_SCOPE_MAX_ITEMS,
    site: SEMANTIC_MEMORY_SCOPE_MAX_ITEMS,
  }),
  version_cap: 50,
  stale_after_days: 90,
  rate_limits: Object.freeze({ learn_passes_per_hour: 10, saves_per_minute: 30 }),
  retention_days: 365,
  placement: SEMANTIC_MEMORY_PLACEMENT_DEFAULT,
  stable_repick_every: MEMORY_STABLE_REPICK_DEFAULT,
});

/** The stored document over the defaults, field by field (pure; tested). */
export function parseMemorySiteSettings(raw: string | null | undefined): MemorySiteSettings {
  if (raw === null || raw === undefined) return MEMORY_SITE_SETTINGS_DEFAULTS;
  let doc: unknown;
  try {
    doc = JSON.parse(raw) as unknown;
  } catch {
    logger.warn("memory site settings: stored value is not JSON; using defaults");
    return MEMORY_SITE_SETTINGS_DEFAULTS;
  }
  const obj = doc !== null && typeof doc === "object" ? (doc as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const name of MEMORY_SITE_SETTING_NAMES) {
    const value = obj[name];
    const parsed = memorySiteSettingsFields[name].safeParse(value);
    if (parsed.success) out[name] = parsed.data;
    else {
      if (value !== undefined) logger.warn({ setting: name }, "memory site settings: default used");
      out[name] = MEMORY_SITE_SETTINGS_DEFAULTS[name];
    }
  }
  return out as MemorySiteSettings;
}

export async function readMemorySiteSettings(db: KobeDb | KobeTx): Promise<MemorySiteSettings> {
  const [row] = await db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, MEMORY_SITE_SETTINGS_KEY));
  return parseMemorySiteSettings(row?.value);
}

const stable = (v: unknown) => JSON.stringify(v);

/** Model settings the console shows as removed when their model is gone. */
export const MEMORY_SITE_MODEL_SETTINGS = ["learning_model_alias", "embedding_model"] as const;
export type MemorySiteModelSetting = (typeof MEMORY_SITE_MODEL_SETTINGS)[number];

/** The gateway provider of a gateway model id (`kobe-local/nomic-embed-text` → `kobe-local`). */
export const gatewayProviderOf = (model: string): string => model.slice(0, model.indexOf("/"));

async function inCatalog(db: KobeDb | KobeTx, alias: string): Promise<boolean> {
  const [m] = await db
    .select({ alias: modelCatalog.alias })
    .from(modelCatalog)
    .where(eq(modelCatalog.alias, alias));
  return m !== undefined;
}

/** Whether `model` (`<gateway provider>/<model>`) is a chat model of the catalog (review L3). */
async function isCatalogChatModel(db: KobeDb | KobeTx, model: string): Promise<boolean> {
  const rows = await db
    .select({ id: modelProviders.id, kind: modelProviders.kind, model: modelCatalog.model })
    .from(modelCatalog)
    .innerJoin(modelProviders, eq(modelProviders.id, modelCatalog.providerId));
  return rows.some((r) => `${gatewayProviderName(r.id, r.kind)}/${r.model}` === model);
}

/**
 * The model settings whose model is gone (review M1): the learning alias left the catalog, or the
 * embedding model's provider left the gateway (`providers`: the gateway provider names now). The
 * console shows them as removed so the admin can choose another; they never block saving other
 * settings.
 */
export async function removedModelSettings(
  db: KobeDb | KobeTx,
  settings: MemorySiteSettings,
  providers: ReadonlySet<string>,
): Promise<MemorySiteModelSetting[]> {
  const out: MemorySiteModelSetting[] = [];
  const learning = settings.learning_model_alias;
  if (learning !== null && !(await inCatalog(db, learning))) out.push("learning_model_alias");
  const embedding = settings.embedding_model;
  if (embedding !== null && !providers.has(gatewayProviderOf(embedding)))
    out.push("embedding_model");
  return out;
}

export type SiteSettingsWrite =
  | {
      readonly ok: true;
      readonly before: MemorySiteSettings;
      readonly settings: MemorySiteSettings;
      readonly changed: readonly MemorySiteSettingName[];
    }
  | {
      readonly ok: false;
      readonly code:
        | "unknown_alias"
        | "unknown_embedding_provider"
        | "embedding_is_chat_model"
        | "unknown_embedding_model";
      readonly message: string;
    };

/**
 * Saves the given fields over the current document (inside the caller's transaction, under
 * `lockSiteMemorySettings`). A model is checked only when it changes, so a stale stored value
 * never blocks saving other fields: a learning alias against the catalog (whether a Workspace
 * enabled it is checked when it is used), an embedding model's provider against `providers` (the
 * gateway provider names now) and against the chat catalog (review L3: a chat model is refused).
 * Whether the provider lists the model is checked by the route, outside the transaction
 * (`embeddingModelListed`).
 */
export async function writeMemorySiteSettings(
  tx: KobeTx,
  change: { readonly [K in MemorySiteSettingName]?: MemorySiteSettings[K] | undefined },
  providers: ReadonlySet<string>,
): Promise<SiteSettingsWrite> {
  const before = await readMemorySiteSettings(tx);
  const learning = change.learning_model_alias;
  if (learning && learning !== before.learning_model_alias && !(await inCatalog(tx, learning))) {
    return {
      ok: false,
      code: "unknown_alias",
      message: `No model in the catalog is "${learning}".`,
    };
  }
  const embedding = change.embedding_model;
  if (
    embedding &&
    embedding !== before.embedding_model &&
    !providers.has(gatewayProviderOf(embedding))
  ) {
    return {
      ok: false,
      code: "unknown_embedding_provider",
      message: `The gateway has no provider "${gatewayProviderOf(embedding)}": add it in Site settings › Models, or name the in-cluster model.`,
    };
  }
  if (
    embedding &&
    embedding !== before.embedding_model &&
    (await isCatalogChatModel(tx, embedding))
  ) {
    return {
      ok: false,
      code: "embedding_is_chat_model",
      message: `"${embedding}" is a chat model in the catalog: name the provider's embedding model.`,
    };
  }
  const given = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined));
  const next: MemorySiteSettings = { ...before, ...given };
  const changed = MEMORY_SITE_SETTING_NAMES.filter((k) => stable(before[k]) !== stable(next[k]));
  if (changed.length > 0) {
    const value = JSON.stringify(next);
    await tx
      .insert(siteSettings)
      .values({ key: MEMORY_SITE_SETTINGS_KEY, value })
      .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: new Date() } });
  }
  return { ok: true, before, settings: next, changed };
}
