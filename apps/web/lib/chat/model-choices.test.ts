import { describe, expect, it } from "vitest";
import type { TeamModel, TeamModels } from "../admin/api/team/models";
import {
  FOLLOW_DEFAULT,
  aliasName,
  modelChoices,
  pickedModel,
  pickerOptions,
  pickerValue,
  shownModelName,
  teamDefaultLabel,
} from "./model-choices";

const model = (alias: string, label: string | null, enabled: boolean): TeamModel =>
  ({ alias, label, enabled, isDefault: false }) as unknown as TeamModel;

const data: TeamModels = {
  models: [model("kimi", "Kimi", true), model("glm", "GLM", true), model("gpt", null, false)],
  default: "kimi",
};

describe("modelChoices (KOBE-44, KOBE-217)", () => {
  it("offers the enabled models; null follows the team default", () => {
    const c = modelChoices(data, null, null);
    expect(c.enabled.map((m) => m.alias)).toEqual(["kimi", "glm"]);
    expect(c.chosen).toBeNull();
    expect(c.unavailable).toBe(false);
    expect(teamDefaultLabel(c)).toBe("Team default (Kimi)");
  });

  it("marks a choice the team disabled since as unavailable", () => {
    expect(modelChoices(data, "gpt", null).unavailable).toBe(true);
    expect(aliasName(data, "gpt")).toBe("gpt");
    expect(aliasName(data, "glm")).toBe("GLM");
  });

  it("names the agent's pin, and a default that isn't enabled is plain 'Team default'", () => {
    expect(modelChoices(data, "glm", "kimi").pinned).toBe("kimi");
    const noDefault = modelChoices({ ...data, default: "gpt" }, null, null);
    expect(noDefault.defaultModel).toBeUndefined();
    expect(teamDefaultLabel(noDefault)).toBe("Team default");
  });
});

describe("the picker shows the team default as itself (KOBE-840)", () => {
  it("lists the enabled models only, with the default selected while the conversation follows it", () => {
    const c = modelChoices(data, null, null);
    expect(pickerOptions(c)).toEqual([
      { value: "kimi", label: "Kimi" },
      { value: "glm", label: "GLM" },
    ]);
    expect(
      pickerOptions(c)
        .map((o) => o.label)
        .join(" "),
    ).not.toMatch(/Team default/);
    expect(pickerValue(c)).toBe("kimi");
    expect(pickerValue(modelChoices(data, "glm", null))).toBe("glm");
    expect(shownModelName(data, c)).toBe("Kimi");
  });

  it("picking the default's own entry follows the team default; another model is chosen", () => {
    const c = modelChoices(data, "glm", null);
    expect(pickedModel(c, "kimi")).toBeNull();
    expect(pickedModel(c, "glm")).toBe("glm");
    expect(pickedModel(c, FOLLOW_DEFAULT)).toBeNull();
  });

  it("a default that isn't enabled keeps a plain 'Default model' entry", () => {
    const c = modelChoices({ ...data, default: "gpt" }, null, null);
    expect(pickerOptions(c)[0]).toEqual({ value: FOLLOW_DEFAULT, label: "Default model" });
    expect(pickerValue(c)).toBe(FOLLOW_DEFAULT);
    expect(shownModelName({ ...data, default: "gpt" }, c)).toBe("Default model");
  });
});
