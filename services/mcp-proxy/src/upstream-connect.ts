import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { Agent, type Dispatcher } from "undici";
import type { AddressChecker } from "./address-policy.js";
import type { UpstreamPolicy } from "./config.js";
import { UpstreamError } from "./upstream-wire.js";

/** Checks scheme, port and literal addresses; names are checked at connect time. */
export function checkUpstreamUrl(
  raw: string,
  policy: UpstreamPolicy,
  addresses: AddressChecker,
): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const httpsOnly = url.protocol === "https:";
  if (!httpsOnly && !(url.protocol === "http:" && policy.allowInsecureHttp)) return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  const port = url.port === "" ? (httpsOnly ? 443 : 80) : Number(url.port);
  if (!policy.allowedPorts.includes(port)) return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && addresses.check(host) !== "allowed") return undefined;
  return url;
}

/**
 * The connection pool towards upstreams: every name is resolved once and all of its addresses must
 * pass; connect uses a checked one.
 */
export function createDispatcher(
  resolve: (host: string) => Promise<LookupAddress[]>,
  addresses: AddressChecker,
  connectionsPerOrigin: number | undefined,
): Dispatcher {
  return new Agent({
    connect: {
      lookup(hostname, lookupOptions, callback) {
        resolve(hostname).then(
          (found) => {
            const usable = found.filter((a) => isIP(a.address) !== 0);
            if (addresses.checkAll(usable.map((a) => a.address)) !== "allowed") {
              callback(new UpstreamError("forbidden_address"), "", 0);
              return;
            }
            const ordered = [...usable].sort((a, b) => a.family - b.family);
            if ((lookupOptions as { all?: boolean }).all) {
              (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, ordered);
            } else {
              const first = ordered[0] as LookupAddress;
              callback(null, first.address, first.family);
            }
          },
          (err: unknown) => callback(err as NodeJS.ErrnoException, "", 0),
        );
      },
    },
    connectTimeout: 10_000,
    // Per origin (one MCP server): the proxy's own concurrency limits bound the rest.
    connections: connectionsPerOrigin ?? 32,
  });
}
