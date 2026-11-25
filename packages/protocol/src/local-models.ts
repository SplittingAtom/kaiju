/**
 * The chart's in-cluster model provider (KOBE-659) and its gateway name (KOBE-828, rename step
 * RN-15, owner decision 2026-11-24): the Site provider id `local` is the gateway provider
 * `kaiju-local`, so its models are `kaiju-local/<model>`. Every other OpenAI-compatible provider
 * keeps its pre-rename gateway name (`kobe-<id>`, held in Bifrost by existing installs).
 *
 * Before the rename the same models were `kobe-local/<model>`. Migration
 * `kaiju_local_models` rewrote the stored references (the Site embedding model, the vectors'
 * `embedding_model`, evals still to run); history keeps the old id (`run_usage` is append-only),
 * so readers map it with {@link currentModelId}: usage reports group both ids as one model,
 * vectors made under the old id stay current (no re-embedding). That mapping is permanent.
 */

/** The Site provider id of the chart's in-cluster model service. */
export const LOCAL_PROVIDER_ID = "local";

/** Its gateway (Bifrost) provider name. */
export const LOCAL_GATEWAY_PROVIDER = "kaiju-local";

/** Its gateway provider name before the rename (history, and old pods during the upgrade). */
export const PRE_RENAME_LOCAL_GATEWAY_PROVIDER = "kobe-local";

const NEW_PREFIX = `${LOCAL_GATEWAY_PROVIDER}/`;
const OLD_PREFIX = `${PRE_RENAME_LOCAL_GATEWAY_PROVIDER}/`;

/** A gateway model id as it is named now: `kobe-local/<model>` → `kaiju-local/<model>`. */
export function currentModelId(model: string): string {
  return model.startsWith(OLD_PREFIX) ? NEW_PREFIX + model.slice(OLD_PREFIX.length) : model;
}

/** The pre-rename id of a current gateway model id, when it had another one. */
export function preRenameModelId(model: string): string | undefined {
  return model.startsWith(NEW_PREFIX) ? OLD_PREFIX + model.slice(NEW_PREFIX.length) : undefined;
}

/** Every id stored rows may name the model `model` by: its current id, then its pre-rename one. */
export function modelIdsOf(model: string): string[] {
  const current = currentModelId(model);
  const old = preRenameModelId(current);
  return old === undefined ? [current] : [current, old];
}
