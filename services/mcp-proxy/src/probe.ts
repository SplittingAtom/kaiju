import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { apiKeyHeaders, oauthHeaders } from "./credentials.js";
import { keyMatches } from "./internal-key.js";
import { logger } from "./logger.js";
import { checkRegisteredUrl, type RegisteredUrlLookup } from "./registered-url.js";
import type { UpstreamClient } from "./upstream.js";

/**
 * The server's pinning probe (KOBE-101): `POST /internal/v1/probe {connector_id, url}` returns the connector's
 * live `tools/list`, fetched through the same upstream client (address policy, size and time caps)
 * the sandboxes' calls use. Only the server's internal key may call it; sandboxes cannot, and the
 * answer goes to the server, which pins it, never to a sandbox. Without an `api_key` or
 * `access_token` in the request no credentials are attached, so connectors that need a grant
 * answer `auth_required`.
 *
 * With `ui_resources: true` (KOBE-433) the answer also carries `ui_resources`: the `ui://`
 * templates the live tools name, read in the same upstream session (see ui-resources.ts). The
 * proxy derives the URIs from the tools it just listed, so the server needs one probe, not two.
 */
export interface ProbeDeps {
  readonly internalKey: string;
  readonly upstream: UpstreamClient;
  readonly timeoutMs: number;
  /**
   * The connector's registered URL, from the server's registry (KOBE-693): a body naming any
   * other URL is refused before the upstream is contacted.
   */
  readonly registeredUrl: RegisteredUrlLookup;
  readonly maxRequestBytes: number;
}

// `api_key`: a site admin's key (or the site key), sent by the server to pin a connector that
// needs one (KOBE-108, KOBE-431). `access_token` (KOBE-784): a site admin's own OAuth access token
// for an `oauth` connector. Either becomes a bearer token for this probe's upstream session
// (initialize, tools/list, ui:// reads) and nothing else; never both.
const bodySchema = z
  .strictObject({
    // KOBE-693: the connector being pinned or refreshed; `url` must be its registered URL.
    connector_id: z.uuid(),
    url: z.string().min(1).max(2048),
    api_key: z
      .string()
      .regex(/^[\x21-\x7e]{1,2048}$/)
      .optional(),
    access_token: z
      .string()
      .regex(/^[\x21-\x7e]{1,8192}$/)
      .optional(),
    ui_resources: z.literal(true).optional(),
  })
  .refine((b) => b.api_key === undefined || b.access_token === undefined);

export function probeRoutes(deps: ProbeDeps): Hono {
  const app = new Hono();
  app.post(
    "/",
    bodyLimit({
      maxSize: deps.maxRequestBytes,
      onError: (c) => c.json({ code: "too_large" }, 413),
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      if (!keyMatches(c.req.header("authorization"), deps.internalKey)) {
        return c.json({ code: "unauthorized" }, 401);
      }
      const body = bodySchema.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json({ code: "invalid_request" }, 400);
      const b = body.data;
      const check = await checkRegisteredUrl(deps.registeredUrl, b.connector_id, b.url);
      if (check === "unavailable") {
        logger.warn("connector registry unavailable: call refused");
        return c.json({ code: "registry_unavailable" }, 503);
      }
      if (check === "not_registered") return c.json({ code: "url_not_registered" }, 403);
      const result = await deps.upstream.listTools(
        {
          url: body.data.url,
          headers:
            b.api_key !== undefined
              ? apiKeyHeaders(b.api_key)
              : b.access_token !== undefined
                ? oauthHeaders(b.access_token)
                : {},
          signal: AbortSignal.timeout(deps.timeoutMs),
        },
        { uiResources: body.data.ui_resources === true },
      );
      if (result.ok) {
        const { tools, ui_resources: uiResources, ui_resources_skipped: uiSkipped } = result.result;
        return c.json({
          ok: true,
          tools,
          ...(uiResources === undefined ? {} : { ui_resources: uiResources }),
          ...(uiSkipped === undefined ? {} : { ui_resources_skipped: uiSkipped }),
        });
      }
      return c.json({ ok: false, failure: result.failure });
    },
  );
  return app;
}
