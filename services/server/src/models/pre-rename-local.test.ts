import { describe, expect, it } from "vitest";
import { buildDesiredState, type ProviderInput } from "./desired.js";
import { withLocalEmbedding } from "./local-embedding.js";

// KOBE-828 (RN-15): for one release the gateway keeps the in-cluster provider's pre-rename name,
// so a pod or sandbox of the previous release that still sends `kobe-local/<model>` is served,
// and it reaches exactly the models `kaiju-local` does (KOBE-754 removes it).
const SECRET = "f".repeat(32);
const LOCAL = { url: "http://kaiju-embeddings:8080/v1", model: "nomic-embed-text" };
const keyed: ProviderInput = {
  id: "local",
  kind: "openai_compatible",
  baseUrl: "http://10.0.0.5:8080/v1",
  allowPrivateNetwork: true,
  apiKey: "sk-local",
};

describe("the in-cluster provider's pre-rename name in Bifrost (KOBE-828)", () => {
  it("pushes kobe-local next to kaiju-local, with the same endpoint", () => {
    const { providers } = withLocalEmbedding([], LOCAL);
    const desired = buildDesiredState(
      {
        providers,
        catalog: [],
        teams: [{ teamId: "t1", members: ["u1"], aliases: [] }],
        siteModels: ["kaiju-local/nomic-embed-text"],
      },
      SECRET,
    );
    const byName = new Map(desired.providers.map((p) => [p.name, p]));
    expect([...byName.keys()].sort()).toEqual(["kaiju-local", "kobe-local"]);
    expect({ ...byName.get("kobe-local"), name: "kaiju-local" }).toEqual(byName.get("kaiju-local"));
    expect(desired.virtualKeys[0]?.models).toEqual({
      "kaiju-local": ["nomic-embed-text"],
      "kobe-local": ["nomic-embed-text"],
    });
  });

  it("gives a keyed provider's alias its own key name (unique across providers)", () => {
    const desired = buildDesiredState(
      {
        providers: [keyed],
        catalog: [{ alias: "local-chat", providerId: "local", model: "qwen3" }],
        teams: [{ teamId: "t1", members: ["u1"], aliases: ["local-chat"] }],
      },
      SECRET,
    );
    const [current, alias] = desired.providers;
    expect(current?.name).toBe("kaiju-local");
    expect(alias?.name).toBe("kobe-local");
    expect(alias?.key?.value).toBe("sk-local");
    expect(alias?.key?.name).toBe(`${current?.key?.name}-pre-rename`);
    expect(desired.virtualKeys[0]?.models).toEqual({
      "kaiju-local": ["qwen3"],
      "kobe-local": ["qwen3"],
    });
  });

  it("adds nothing without the in-cluster provider", () => {
    const desired = buildDesiredState(
      {
        providers: [{ ...keyed, id: "lan" }],
        catalog: [{ alias: "lan-chat", providerId: "lan", model: "qwen3" }],
        teams: [{ teamId: "t1", members: ["u1"], aliases: ["lan-chat"] }],
      },
      SECRET,
    );
    expect(desired.providers.map((p) => p.name)).toHaveLength(1);
    expect(Object.keys(desired.virtualKeys[0]?.models ?? {})).toHaveLength(1);
  });
});
