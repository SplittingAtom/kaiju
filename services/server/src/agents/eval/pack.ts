/**
 * The scenario pack the eval image runs by default (images/orbit-eval/scenarios/default-pack.yaml)
 * and how many scenario runs a complete result has. A result for another pack, or one that did not
 * run every scenario, is not trusted (KOBE-93). `pack.test.ts` keeps this equal to the YAML.
 */
export const EXPECTED_PACK = { id: "kaiju-default", version: 1, scenarios: 5 } as const;
/**
 * The same pack under its id before the rename to Kaiju (KOBE-750), accepted for one release: an
 * eval Job of the previous image that runs across the upgrade reports it. Removed in KOBE-754.
 */
export const LEGACY_PACK_IDS: readonly string[] = ["kobe-default"];
/** The image's default `--epochs`. */
export const EVAL_EPOCHS = 1;
