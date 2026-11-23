import type { AuditEvent } from "@kobe/db";
import type { ConnectionLimits } from "../limits.js";
import type { RateBuckets } from "../rate-buckets.js";
import type { GitDecisionCache } from "./decisions.js";

/** Limits of git smart-HTTP relays (KOBE-763); the push limit comes per connection. */
export interface GitSettings {
  /** Fetch negotiation bodies (`git-upload-pack` requests: wants and haves). */
  readonly maxFetchRequestBytes: number;
  /** Responses (packs of a clone or fetch). */
  readonly maxResponseBytes: number;
  /** Whole exchange, from the request head to the last byte. */
  readonly timeoutMs: number;
}

/** What the egress proxy needs to relay git smart-HTTP for connected organizations. */
export interface GitTransportDeps {
  readonly decisions: GitDecisionCache;
  readonly settings: GitSettings;
  /** Concurrent git requests per sandbox (per replica). */
  readonly concurrency: ConnectionLimits;
  /** Git requests per sandbox: burst, then per second (per replica). */
  readonly rate: RateBuckets;
  /**
   * Decisions not in the cache per sandbox (per replica): each may cost host API calls for a
   * token connection, so distinct repositories are budgeted (review L3).
   */
  readonly lookups: RateBuckets;
  /** Writes one `egress.git_push` row (the connection audit's single-event path). */
  readonly recordEvent: (event: AuditEvent) => void;
}
