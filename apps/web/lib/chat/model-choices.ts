/**
 * The conversation's model choices (KOBE-44, D30), shared by the model picker and "Regenerate
 * with…" (CE17, KOBE-217): the team's enabled models; the conversation's choice, where null means
 * "follow the team default" (never the default's alias); a choice the team has since disabled;
 * and the agent's pin, which wins over all of it (user decision, KOBE-44).
 */
import { modelName, type TeamModel, type TeamModels } from "../admin/api/team/models";

export interface ModelChoices {
  /** The agent's pinned alias, or null: with a pin there is nothing to choose. */
  readonly pinned: string | null;
  readonly enabled: readonly TeamModel[];
  /** The conversation's choice; null follows the team default. */
  readonly chosen: string | null;
  /** A choice the team has since disabled (runs on it fail until another is chosen). */
  readonly unavailable: boolean;
  /** The team default, when it is enabled. */
  readonly defaultModel: TeamModel | undefined;
}

export function modelChoices(
  data: TeamModels,
  chosen: string | null,
  agentModel: string | null,
): ModelChoices {
  const enabled = data.models.filter((m) => m.enabled);
  return {
    pinned: agentModel,
    enabled,
    chosen,
    unavailable: chosen !== null && !enabled.some((m) => m.alias === chosen),
    defaultModel: enabled.find((m) => m.alias === data.default),
  };
}

/**
 * The model picker's `<select>` value (and `/model`'s) for "follow the team default": an alias is
 * never empty.
 */
export const FOLLOW_DEFAULT = "";

/** The name the picker gives "follow the team default" when that default isn't enabled. */
export const DEFAULT_MODEL_LABEL = "Default model";

export interface PickerOption {
  readonly value: string;
  readonly label: string;
}

/**
 * The model picker's options (KOBE-840): the enabled models by name, with no "Team default" entry;
 * the team default is simply the model shown as selected while the conversation follows it. Only
 * when the default isn't enabled does "follow the default" keep an entry of its own.
 */
export function pickerOptions(
  choices: Pick<ModelChoices, "enabled" | "defaultModel">,
): readonly PickerOption[] {
  const models = choices.enabled.map((m) => ({ value: m.alias, label: modelName(m) }));
  return choices.defaultModel
    ? models
    : [{ value: FOLLOW_DEFAULT, label: DEFAULT_MODEL_LABEL }, ...models];
}

/** The option the picker shows as selected: the choice, else the team default's own entry. */
export function pickerValue(choices: Pick<ModelChoices, "chosen" | "defaultModel">): string {
  return choices.chosen ?? choices.defaultModel?.alias ?? FOLLOW_DEFAULT;
}

/**
 * What picking `value` saves on the conversation: the team default's own entry follows the team
 * default (null), as it did when the picker named it "Team default (…)"; another model is chosen.
 */
export function pickedModel(
  choices: Pick<ModelChoices, "defaultModel">,
  value: string,
): string | null {
  return value === FOLLOW_DEFAULT || value === choices.defaultModel?.alias ? null : value;
}

/** The conversation's model by name, as the picker shows it (Session info, KOBE-584). */
export function shownModelName(data: TeamModels, choices: ModelChoices): string {
  const alias = choices.pinned ?? choices.chosen;
  if (alias !== null) return aliasName(data, alias);
  return choices.defaultModel ? modelName(choices.defaultModel) : DEFAULT_MODEL_LABEL;
}

/**
 * "Team default (Kimi K2.7 Code)", or "Team default" when the default isn't enabled: Regenerate
 * with… keeps it (a menu of runs to ask again with, not the picker, KOBE-840).
 */
export function teamDefaultLabel(choices: Pick<ModelChoices, "defaultModel">): string {
  return choices.defaultModel
    ? `Team default (${modelName(choices.defaultModel)})`
    : "Team default";
}

/** A model's name by alias: its catalog label, else the alias itself. */
export function aliasName(data: TeamModels, alias: string): string {
  const model = data.models.find((m) => m.alias === alias);
  return model ? modelName(model) : alias;
}
