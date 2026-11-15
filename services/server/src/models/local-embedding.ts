import { gatewayProviderName } from "@kobe/db";
import type { LocalEmbeddingConfig } from "./config.js";
import type { ProviderInput } from "./desired.js";

/**
 * The chart's in-cluster embedding service (KOBE-659, Helm `embeddings.local`) as a gateway
 * provider. It is not a Site console provider (no row: the chart owns it), so the sync adds it to
 * the providers it pushes: a keyless OpenAI-compatible Bifrost provider on a private address,
 * named `kobe-local`, whose model is `kobe-local/<model>`. Turning the chart value off removes it
 * from Bifrost on the next sync. External embedding models stay ordinary Site console providers.
 */
export const LOCAL_EMBEDDING_PROVIDER_ID = "local";

const LOCAL_KIND = "openai_compatible" as const;

/** The Bifrost model id of the local embedding model, e.g. `kobe-local/nomic-embed-text`. */
export function localEmbeddingGatewayModel(local: LocalEmbeddingConfig): string {
  return `${gatewayProviderName(LOCAL_EMBEDDING_PROVIDER_ID, LOCAL_KIND)}/${local.model}`;
}

/**
 * `providers` plus the local embedding provider when the chart runs one. A Site console provider
 * that already uses the reserved id keeps it (`conflict`: the caller logs it), so an admin's own
 * provider is never replaced.
 */
export function withLocalEmbedding(
  providers: readonly ProviderInput[],
  local: LocalEmbeddingConfig | undefined,
): { providers: ProviderInput[]; conflict: boolean } {
  if (!local) return { providers: [...providers], conflict: false };
  if (providers.some((p) => p.id === LOCAL_EMBEDDING_PROVIDER_ID)) {
    return { providers: [...providers], conflict: true };
  }
  return {
    providers: [
      ...providers,
      {
        id: LOCAL_EMBEDDING_PROVIDER_ID,
        kind: LOCAL_KIND,
        baseUrl: local.url,
        allowPrivateNetwork: true,
        apiKey: undefined,
      },
    ],
    conflict: false,
  };
}
