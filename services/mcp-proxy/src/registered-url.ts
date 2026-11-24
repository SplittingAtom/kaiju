import { injectTraceHeaders } from "@kaiju/telemetry";
import { z } from "zod";

/**
 * The connector registry's URL for a connector (KOBE-693). The server's probe and app-call routes
 * name a connector and its URL; the proxy asks the server's internal listener for the registered
 * URL and refuses any other, so the routes key alone never lets a caller point the proxy at an
 * arbitrary address. Resolves undefined for an unknown or removed connector; rejects when the
 * server cannot be asked.
 */
export type RegisteredUrlLookup = (connectorId: string) => Promise<string | undefined>;

export interface RegisteredUrlLookupOptions {
  /** The server's internal listener, e.g. http://kobe-server:8082. */
  readonly baseUrl: string;
  /** What the proxy presents to that listener (KAIJU_MCP_INTERNAL_KEY). */
  readonly internalKey: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

const answerSchema = z.object({ url: z.string().min(1).max(2048) });

export function createRegisteredUrlLookup(
  options: RegisteredUrlLookupOptions,
): RegisteredUrlLookup {
  const doFetch = options.fetch ?? fetch;
  return async (connectorId) => {
    const res = await doFetch(
      `${options.baseUrl}/internal/v1/mcp/connectors/${encodeURIComponent(connectorId)}/endpoint`,
      {
        method: "GET",
        headers: injectTraceHeaders({ authorization: `Bearer ${options.internalKey}` }),
        signal: AbortSignal.timeout(options.timeoutMs),
        redirect: "error",
      },
    );
    if (res.status === 404) {
      await res.body?.cancel();
      return undefined;
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new Error(`server answered ${res.status}`);
    }
    return answerSchema.parse(await res.json()).url;
  };
}

export type RegisteredUrlCheck = "registered" | "not_registered" | "unavailable";

const normalized = (url: string): string | undefined =>
  URL.canParse(url) ? new URL(url).href : undefined;

/** Whether `url` is the connector's registered URL (compared after URL normalization). */
export async function checkRegisteredUrl(
  lookup: RegisteredUrlLookup,
  connectorId: string,
  url: string,
): Promise<RegisteredUrlCheck> {
  let registered: string | undefined;
  try {
    registered = await lookup(connectorId);
  } catch {
    return "unavailable";
  }
  const wanted = normalized(url);
  if (registered === undefined || wanted === undefined) return "not_registered";
  return normalized(registered) === wanted ? "registered" : "not_registered";
}
