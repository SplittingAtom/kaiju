import { and, eq, gt, kobeRateLimits, type KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import type { BackgroundTasks } from "../background.js";
import { countRateLimitHit } from "../rate-limit.js";

/** Where a request without a resolvable client address was seen. */
export type UnknownIpSource = "sign-in" | "scim";

const KEY = "unknown-client-ip";
/** How long one sighting keeps the Site console notice up. */
export const UNKNOWN_IP_NOTICE_MS = 24 * 60 * 60_000;
/** Each replica writes a sighting at most this often (the notice needs one, not a count). */
const RECORD_EVERY_MS = 60_000;

export interface ClientIpWatch {
  /** A request reached an IP-keyed limit without a client address Kaiju can trust. */
  unknown(source: UnknownIpSource): void;
  /** Since when sightings have been recorded (the last day), or null when there were none. */
  seen(): Promise<{ readonly since: number } | null>;
}

/**
 * Reports requests whose client address can't be resolved (KOBE-812): the trusted proxy list
 * doesn't match the proxies in front of the server, or they don't send X-Forwarded-For. Better
 * Auth's per-address sign-in limits then fall back to one bucket per path shared by every client,
 * and SCIM's failed-authentication limit to one per provider. A warning is logged once per source
 * and replica; sightings are recorded in `kobe_rate_limits` (shared by every replica, no address
 * stored) so the Site console can say so for a day.
 */
export function createClientIpWatch(o: {
  readonly db: KobeDb;
  readonly log: Pick<Logger, "warn">;
  readonly background: BackgroundTasks;
  readonly now?: () => number;
}): ClientIpWatch {
  const now = o.now ?? Date.now;
  const warned = new Set<UnknownIpSource>();
  let lastRecorded = Number.NEGATIVE_INFINITY;
  return {
    unknown(source) {
      if (!warned.has(source)) {
        warned.add(source);
        o.log.warn(
          { source },
          "a request arrived without a client IP Kaiju can trust: per-address limits are shared by every such client. Check KOBE_TRUSTED_PROXIES (Helm auth.trustedProxies) against the proxies in front of the server",
        );
      }
      const t = now();
      if (t - lastRecorded < RECORD_EVERY_MS) return;
      lastRecorded = t;
      o.background.run("unknown client IP sighting not recorded", () =>
        countRateLimitHit(o.db, KEY, { windowMs: UNKNOWN_IP_NOTICE_MS }, t),
      );
    },
    async seen() {
      const [row] = await o.db
        .select({ since: kobeRateLimits.windowStart })
        .from(kobeRateLimits)
        .where(and(eq(kobeRateLimits.key, `kobe:${KEY}`), gt(kobeRateLimits.expiresAt, now())));
      return row ? { since: Number(row.since) } : null;
    },
  };
}

/**
 * Start-up warning (KOBE-812): with no trusted proxies, only a single-entry X-Forwarded-For names
 * the client; behind any proxy chain the client address is then unknown.
 */
export function warnTrustedProxies(
  trustedProxies: readonly string[],
  log: Pick<Logger, "warn">,
): void {
  if (trustedProxies.length > 0) return;
  log.warn(
    "KOBE_TRUSTED_PROXIES is empty: behind a proxy chain the client IP can't be resolved, and per-address sign-in limits are then shared by every client",
  );
}
