import type { Socket } from "node:net";
import type { Logger } from "pino";
import type { AddressChecker } from "./address-policy.js";
import type { EgressDecision } from "./allowlist.js";
import type { SiteTokenVerifier, TokenVerifier } from "./auth.js";
import type { BlockedAttempt } from "./blocked-reporter.js";
import type { ConnectionRecord } from "./connection-audit.js";
import type { BandwidthLimiter, ConnectionLimits } from "./limits.js";
import type { ResolveHost } from "./resolver.js";
import type { PreAuthGate } from "./preauth-gate.js";
import type { TunnelRegistry } from "./tunnel-registry.js";
import type { InjectedHeader } from "@kobe/db";
import type { GitTransportDeps } from "./git/types.js";

/**
 * The egress proxy (spec D28): default deny, HTTPS only, per-team allowlists within the install
 * ceiling. A sandbox sends `CONNECT host:443` with its egress session token; the proxy
 *
 * 1. authenticates the token (team, user, sandbox come from it) and checks the user is still an
 *    active member of the team;
 * 2. allows only ports in `allowedPorts` (443) and host names (no IP literals);
 * 3. checks the host against the team's effective allowlist (enablement ∩ ceiling);
 * 4. resolves the host itself and refuses it if any address is internal (private, loopback,
 *    link-local/metadata, cluster ranges) unless explicitly allowed, or (EA4) inside the install's
 *    internal targets for a host whose matching pattern is marked internal (loopback, link-local
 *    and metadata never); connects to an address it checked (no second lookup, so DNS rebinding
 *    gains nothing);
 * 5. replies 200, reads the TLS ClientHello and requires its SNI to equal the CONNECT host (no SNI,
 *    another name or another protocol tears the tunnel down);
 * 6. relays bytes without decrypting them, under per-sandbox connection, bandwidth and idle limits.
 *
 * The server's own site jobs (KOBE-343, the catalog's git mirror) CONNECT with a site egress token:
 * no membership, team allowlist, header injection or run report; only the site ceiling decides,
 * and the connection is logged here (the server audits the job itself).
 *
 * Plain-HTTP proxy requests are refused, except for domains whose team configured injected headers
 * (KOBE-39): those are upgraded to verified HTTPS by the proxy itself (upgrade.ts), and a CONNECT
 * to such a domain is refused with a pointer to `http://` (a tunnel could not carry the headers).
 * Every authenticated attempt is counted in the
 * aggregated `egress.connection` audit; refusals of a named host also record an `egress.blocked`
 * event for the run (blocked-reporter.ts).
 */
export interface ProxySettings {
  readonly allowedPorts: readonly number[];
  readonly idleTimeoutMs: number;
  /** TLS ClientHello deadline after the 200. */
  readonly handshakeTimeoutMs: number;
  /** Request-head deadline for new sockets (pre-authentication; slow-loris bound). */
  readonly preAuthTimeoutMs: number;
  readonly connectTimeoutMs: number;
  /** Longest a tunnel may live (it also closes when the token that opened it expires). */
  readonly maxTunnelMs: number;
}

export interface ProxyPolicy {
  decide(teamId: string, host: string): Promise<EgressDecision>;
  /** A site job's decision (KOBE-343): the site egress ceiling alone. */
  decideSite(host: string): Promise<EgressDecision>;
  isActiveMember(teamId: string, userId: string): Promise<boolean>;
  /** The team's sealed injected headers for an enabled pattern (KOBE-39), if any. */
  sealedHeaders?(teamId: string, pattern: string): Promise<string | undefined>;
}

export type ConnectUpstream = (address: string, port: number, timeoutMs: number) => Promise<Socket>;

export interface ProxyDeps {
  readonly verify: TokenVerifier;
  /** Site egress tokens (KOBE-343); absent: only sandboxes may connect. */
  readonly verifySite?: SiteTokenVerifier;
  readonly policy: ProxyPolicy;
  readonly resolve: ResolveHost;
  readonly addresses: AddressChecker;
  readonly connections: ConnectionLimits;
  readonly bandwidth: BandwidthLimiter;
  readonly audit: { record(record: ConnectionRecord): void };
  readonly blocked: { report(attempt: BlockedAttempt): void };
  readonly logger: Logger;
  readonly settings: ProxySettings;
  readonly connectUpstream?: ConnectUpstream;
  /** Caps sockets that have not authenticated yet, per source and in total. */
  readonly preauth?: PreAuthGate;
  /** Open tunnels, for revocation on change hints. */
  readonly tunnels?: TunnelRegistry;
  /** Health endpoint state (readyz turns 503 while draining). */
  readonly ready?: () => boolean;
  /** Opens the teams' sealed injected headers (KOBE-39); absent: header injection off. */
  readonly headers?: HeaderOpener;
  /** Limits of upgraded plain-HTTP requests (KOBE-39); absent: header injection off. */
  readonly upgrade?: UpgradeSettings;
  /** Git smart-HTTP for connected organizations (KOBE-763); absent: git paths get no credential. */
  readonly git?: GitTransportDeps;
  /** Extra CAs trusted for upgraded requests (tests); production uses the system store only. */
  readonly upstreamCa?: string | Buffer | readonly (string | Buffer)[];
}

/** Bytes relayed, and the set-up latency (ms) when the connection got that far (KOBE-525). */
export interface ConnectionBytes {
  readonly bytesUp: number;
  readonly bytesDown: number;
  readonly setupMs?: number;
}

/** Limits of upgraded plain-HTTP requests (KOBE-39, upgrade.ts). */
export interface UpgradeSettings {
  /** Request body limit (uploads, e.g. `twine upload`). */
  readonly maxRequestBytes: number;
  /** Response body limit (downloads). */
  readonly maxResponseBytes: number;
  /** Whole exchange, from the request head to the last response byte. */
  readonly timeoutMs: number;
}

export interface HeaderOpener {
  /** The team's headers for the pattern (throws when the sealed value does not open). */
  open(teamId: string, pattern: string, sealed: string): InjectedHeader[];
}
