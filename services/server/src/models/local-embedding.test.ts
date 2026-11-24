import { describe, expect, it } from "vitest";
import { buildDesiredState, type ProviderInput } from "./desired.js";
import { addProviderSchema } from "./schemas.js";
import {
  LOCAL_EMBEDDING_PROVIDER_ID,
  localEmbeddingGatewayModel,
  withLocalEmbedding,
} from "./local-embedding.js";

// KOBE-659: the chart's in-cluster embedding service becomes a Bifrost provider (`kobe-local`)
// pushed by the gateway sync, besides the Site console's providers (which stay the way to use an
// external embedding model: a LAN Ollama or a hosted provider with a site key).

const LOCAL = { url: "http://kaiju-embeddings:8080", model: "nomic-embed-text" };
const lanOllama: ProviderInput = {
  id: "ollama",
  kind: "ollama",
  baseUrl: "http://ollama.lan:11434",
  allowPrivateNetwork: true,
  apiKey: undefined,
};
const stub: ProviderInput = {
  id: "embed-stub",
  kind: "openai_compatible",
  baseUrl: "https://embeddings.example.com",
  allowPrivateNetwork: false,
  apiKey: "sk-stub-0001",
};

describe("withLocalEmbedding", () => {
  it("adds the local service as a keyless OpenAI-compatible provider on a private address", () => {
    const { providers, conflict } = withLocalEmbedding([lanOllama], LOCAL);
    expect(conflict).toBe(false);
    expect(providers).toEqual([
      lanOllama,
      {
        id: LOCAL_EMBEDDING_PROVIDER_ID,
        kind: "openai_compatible",
        baseUrl: LOCAL.url,
        allowPrivateNetwork: true,
        apiKey: undefined,
      },
    ]);
    const desired = buildDesiredState({ providers, catalog: [], teams: [] }, "f".repeat(32));
    expect(desired.providers.find((p) => p.name === "kobe-local")).toMatchObject({
      custom: true,
      keyless: true,
      baseUrl: LOCAL.url,
      allowPrivateNetwork: true,
      key: undefined,
    });
  });

  it("names the gateway model `kobe-local/<model>`", () => {
    expect(localEmbeddingGatewayModel(LOCAL)).toBe("kobe-local/nomic-embed-text");
  });

  it("changes nothing when the chart runs no local service (external models only)", () => {
    const { providers, conflict } = withLocalEmbedding([lanOllama, stub], undefined);
    expect(conflict).toBe(false);
    expect(providers).toEqual([lanOllama, stub]);
    // The external stub provider still reaches Bifrost and a team's virtual key as before.
    const desired = buildDesiredState(
      {
        providers,
        catalog: [{ alias: "embed", providerId: "embed-stub", model: "text-embedding-3-small" }],
        teams: [{ teamId: "t1", members: ["u1"], aliases: ["embed"] }],
      },
      "f".repeat(32),
    );
    expect(desired.providers.map((p) => p.name).sort()).toEqual(["kobe-embed-stub", "ollama"]);
    expect(desired.virtualKeys[0]?.models).toEqual({
      "kobe-embed-stub": ["text-embedding-3-small"],
    });
  });

  it("leaves a Site console provider with the reserved id alone and reports the conflict", () => {
    const own: ProviderInput = { ...stub, id: LOCAL_EMBEDDING_PROVIDER_ID };
    const { providers, conflict } = withLocalEmbedding([own], LOCAL);
    expect(conflict).toBe(true);
    expect(providers).toEqual([own]);
  });
});

describe("the Site embedding model on every member's key (KOBE-409)", () => {
  it("adds the Site embedding model to each virtual key, outside every catalog", () => {
    const { providers } = withLocalEmbedding([lanOllama], LOCAL);
    const desired = buildDesiredState(
      {
        providers,
        catalog: [{ alias: "chat", providerId: "ollama", model: "qwen3.5:9b" }],
        teams: [
          { teamId: "t1", members: ["u1"], aliases: ["chat"] },
          { teamId: "t2", members: ["u2"], aliases: [] },
        ],
        siteModels: ["kobe-local/nomic-embed-text", "gone/model"],
      },
      "f".repeat(32),
    );
    expect(desired.virtualKeys.map((k) => k.models)).toEqual([
      { "kobe-local": ["nomic-embed-text"], ollama: ["qwen3.5:9b"] },
      { "kobe-local": ["nomic-embed-text"] },
    ]);
  });
});

describe("the reserved provider id", () => {
  it("cannot be taken by a new Site console provider", () => {
    const r = addProviderSchema.safeParse({
      kind: "openai_compatible",
      id: LOCAL_EMBEDDING_PROVIDER_ID,
      name: "Mine",
      base_url: "http://10.0.0.5:8080",
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("reserved");
  });
});
