import { describe, expect, it } from "vitest";
import {
  LOCAL_GATEWAY_PROVIDER,
  PRE_RENAME_LOCAL_GATEWAY_PROVIDER,
  currentModelId,
  modelIdsOf,
  preRenameModelId,
} from "./local-models.js";

// KOBE-828 (RN-15): the in-cluster provider's models are `kaiju-local/<model>`; history and pods
// of the previous release name them `kobe-local/<model>`.
describe("the in-cluster provider's model ids", () => {
  it("names the provider kaiju-local, kobe-local before the rename", () => {
    expect(LOCAL_GATEWAY_PROVIDER).toBe("kaiju-local");
    expect(PRE_RENAME_LOCAL_GATEWAY_PROVIDER).toBe("kobe-local");
  });

  it("reads a pre-rename id as the current one and leaves every other id alone", () => {
    expect(currentModelId("kobe-local/nomic-embed-text")).toBe("kaiju-local/nomic-embed-text");
    expect(currentModelId("kaiju-local/nomic-embed-text")).toBe("kaiju-local/nomic-embed-text");
    expect(currentModelId("kobe-local-2/m")).toBe("kobe-local-2/m");
    expect(currentModelId("kobe-lan/m")).toBe("kobe-lan/m");
    expect(currentModelId("openai/gpt-5")).toBe("openai/gpt-5");
    expect(currentModelId("kobe-local")).toBe("kobe-local");
  });

  it("gives a current id's pre-rename id, and every id stored rows may use", () => {
    expect(preRenameModelId("kaiju-local/qwen3:8b")).toBe("kobe-local/qwen3:8b");
    expect(preRenameModelId("openai/gpt-5")).toBeUndefined();
    expect(modelIdsOf("kaiju-local/m")).toEqual(["kaiju-local/m", "kobe-local/m"]);
    expect(modelIdsOf("kobe-local/m")).toEqual(["kaiju-local/m", "kobe-local/m"]);
    expect(modelIdsOf("openai/gpt-5")).toEqual(["openai/gpt-5"]);
  });
});
