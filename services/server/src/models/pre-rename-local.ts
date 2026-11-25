import { LOCAL_GATEWAY_PROVIDER, PRE_RENAME_LOCAL_GATEWAY_PROVIDER } from "@kaiju/protocol";
import type { DesiredProvider, DesiredVirtualKey } from "./desired.js";

/**
 * KOBE-828 (rename step RN-15), for one release (KOBE-754 removes it): the in-cluster provider is
 * `kaiju-local` now, but during the upgrade a server, gateway or sandbox of the previous release
 * still names its models `kobe-local/<model>`. So the gateway keeps the old provider name too, as
 * a second Bifrost provider with the same endpoint (and its key, under its own key name: Bifrost
 * wants key names unique across providers), and every virtual key that allows a `kaiju-local`
 * model allows the same model under the old name. The model gateway checks, prices and records
 * either id as the current one (`currentModelId`), so nothing widens: the old name reaches exactly
 * the models the new one does.
 */
export function withPreRenameLocal(providers: readonly DesiredProvider[]): DesiredProvider[] {
  const local = providers.find((p) => p.name === LOCAL_GATEWAY_PROVIDER);
  if (!local || providers.some((p) => p.name === PRE_RENAME_LOCAL_GATEWAY_PROVIDER)) {
    return [...providers];
  }
  const alias: DesiredProvider = {
    ...local,
    name: PRE_RENAME_LOCAL_GATEWAY_PROVIDER,
    key: local.key && { ...local.key, name: `${local.key.name}-pre-rename` },
  };
  return [...providers, alias];
}

/** `models` with each `kaiju-local` model allowed under the pre-rename provider name too. */
export function preRenameLocalModels(
  models: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  const local = models[LOCAL_GATEWAY_PROVIDER];
  if (!local || models[PRE_RENAME_LOCAL_GATEWAY_PROVIDER]) return models;
  return Object.fromEntries(
    [...Object.entries(models), [PRE_RENAME_LOCAL_GATEWAY_PROVIDER, local] as const].sort(
      ([a], [b]) => a.localeCompare(b),
    ),
  );
}

/** A virtual key with {@link preRenameLocalModels} applied. */
export const withPreRenameLocalKey = (vk: DesiredVirtualKey): DesiredVirtualKey => ({
  ...vk,
  models: preRenameLocalModels(vk.models),
});
